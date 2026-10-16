'use strict';
/**
 * 提示词增强（prompt-enhancer）集成测试
 *
 * 真实集成：用本地 http server 模拟 OpenAI 兼容 API，验证成功/失败/超时路径。
 * 隔离：用 CUCKOO_HOME 指向临时目录，不污染真实 ~/.cuckoo。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const TMP = path.join(os.tmpdir(), 'cuckoo-enhancer-test');
const FAKE_HOME = path.join(TMP, 'home');

let enh;
let oldHome;

beforeEach(async () => {
  vi.resetModules();
  oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = FAKE_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  enh = await import('../../src/app/prompt-enhancer.ts');
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = oldHome;
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 起一个本地 http server，handler(req,res) 自定义 */
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ srv, base: 'http://127.0.0.1:' + port + '/v1' });
    });
  });
}

const baseCfg = {
  enabled: true,
  apiUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  mode: 'gentle',
  contextRounds: 8,
  systemPrompt: '',
};

// ===== 失败路径 =====

test('空输入 → 失败，不请求', async () => {
  const r = await enh.enhancePrompt({ text: '   ' }, baseCfg);
  assert.strictEqual(r.success, false);
  assert.ok(/空/.test(r.error), '应提示输入为空');
});

test('未配置 apiKey → 失败', async () => {
  const r = await enh.enhancePrompt({ text: '写个登录页' }, { ...baseCfg, apiKey: '' });
  assert.strictEqual(r.success, false);
  assert.ok(/未配置/.test(r.error));
});

test('API 返回 401 → 失败并带状态码', async () => {
  const { srv, base } = await startServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid token' } }));
  });
  try {
    const r = await enh.enhancePrompt({ text: '写个登录页' }, { ...baseCfg, apiUrl: base });
    assert.strictEqual(r.success, false);
    assert.ok(r.error.indexOf('401') >= 0, '应带状态码: ' + r.error);
  } finally { srv.close(); }
});

test('API 返回空内容 → 失败', async () => {
  const { srv, base } = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
  });
  try {
    const r = await enh.enhancePrompt({ text: '写个登录页' }, { ...baseCfg, apiUrl: base });
    assert.strictEqual(r.success, false);
    assert.ok(/为空/.test(r.error));
  } finally { srv.close(); }
});

test('连接被拒 → 失败（不抛异常）', async () => {
  const r = await enh.enhancePrompt({ text: '写个登录页' }, { ...baseCfg, apiUrl: 'http://127.0.0.1:1/v1' });
  assert.strictEqual(r.success, false);
  assert.ok(/失败/.test(r.error));
});

// ===== 成功路径 =====

test('成功：回填增强文本，请求体含 model + messages', async () => {
  let seenBody = null;
  let seenAuth = null;
  const { srv, base } = await startServer((req, res) => {
    seenAuth = req.headers['authorization'];
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '【增强后的提示词】' } }] }));
    });
  });
  try {
    const r = await enh.enhancePrompt({ text: '写个登录页' }, { ...baseCfg, apiUrl: base });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.text, '【增强后的提示词】');
    assert.strictEqual(seenAuth, 'Bearer sk-test');
    assert.strictEqual(seenBody.model, 'test-model');
    assert.ok(Array.isArray(seenBody.messages) && seenBody.messages.length >= 2);
    // 最后一条 user 消息内含待增强草稿（历史折叠后不再是裸文本）
    assert.ok(seenBody.messages[seenBody.messages.length - 1].content.indexOf('写个登录页') >= 0);
    // 第一条 = system
    assert.strictEqual(seenBody.messages[0].role, 'system');
  } finally { srv.close(); }
});

test('apiUrl 尾斜杠归一化（不产生 //chat/completions）', async () => {
  let seenPath = null;
  const { srv, base } = await startServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  try {
    await enh.enhancePrompt({ text: 'x' }, { ...baseCfg, apiUrl: base + '/' });
    assert.strictEqual(seenPath, '/v1/chat/completions');
  } finally { srv.close(); }
});

// ===== 纯函数 =====

test('readProjectTech：读 package.json 的 name + 依赖', () => {
  const dir = path.join(TMP, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-app', dependencies: { react: '^18' }, devDependencies: { vite: '^5' } }));
  const tech = enh.readProjectTech(dir);
  assert.ok(tech.indexOf('my-app') >= 0);
  assert.ok(tech.indexOf('react') >= 0);
  assert.ok(tech.indexOf('vite') >= 0);
});

test('readProjectTech：目录空 / 无 package.json → 空串', () => {
  assert.strictEqual(enh.readProjectTech(null), '');
  assert.strictEqual(enh.readProjectTech(path.join(TMP, 'nope')), '');
});

test('buildSystemPrompt：strict 含结构化要求；gentle 含克制要求', () => {
  const strict = enh.buildSystemPrompt({ ...baseCfg, mode: 'strict' }, '');
  assert.ok(/结构化/.test(strict));
  const gentle = enh.buildSystemPrompt({ ...baseCfg, mode: 'gentle' }, '');
  assert.ok(/克制/.test(gentle));
  // 自定义优先
  const custom = enh.buildSystemPrompt({ ...baseCfg, systemPrompt: '自定义模板' }, '');
  assert.strictEqual(custom, '自定义模板');
});

test('buildSystemPrompt：有技术栈时注入项目信息', () => {
  const s = enh.buildSystemPrompt({ ...baseCfg, mode: 'gentle' }, '项目名: foo; 依赖: react');
  assert.ok(s.indexOf('foo') >= 0);
  assert.ok(s.indexOf('react') >= 0);
});

test('buildMessages：固定 system + 1 条 user（历史折叠进 user 文本，不作真实轮次）', () => {
  const history = [];
  for (let i = 0; i < 10; i++) history.push({ role: 'user', content: 'u' + i });
  for (let i = 0; i < 10; i++) history.push({ role: 'assistant', content: 'a' + i });
  const msgs = enh.buildMessages({ ...baseCfg, contextRounds: 2 }, { text: 'NEW', history }, '');
  // 关键：不能是 user/assistant 交替的真实轮次（会让模型续写对话而非增强）
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[1].role, 'user');
  // 历史作为背景文本折叠进 user 消息（只取最近 2 轮 = 4 条 → a6~a9）
  assert.ok(msgs[1].content.indexOf('a6') >= 0);
  assert.ok(msgs[1].content.indexOf('a9') >= 0);
  assert.ok(msgs[1].content.indexOf('u0') < 0, '更早的历史应被截掉');
  // 待增强输入在文本中
  assert.ok(msgs[1].content.indexOf('NEW') >= 0);
});

test('buildMessages：contextRounds=0 → 无历史背景段', () => {
  const msgs = enh.buildMessages({ ...baseCfg, contextRounds: 0 }, { text: 'NEW', history: [{ role: 'user', content: 'x' }] }, '');
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[1].content.indexOf('最近对话背景') < 0, '不应含历史背景段');
  assert.ok(msgs[1].content.indexOf('NEW') >= 0);
});

// ===== 配置读取（ui-prefs）=====

test('ui-prefs：apiKey 默认空（源码不硬编码密钥）', async () => {
  const ui = await import('../../src/app/ui-prefs.ts');
  const p = ui.readPrefs();
  assert.strictEqual(p.promptEnhancer.apiKey, '');
  assert.strictEqual(p.promptEnhancer.mode, 'gentle');
});

test('ui-prefs：写配置后可读回，mode 非法回退 gentle', async () => {
  const ui = await import('../../src/app/ui-prefs.ts');
  ui.writePrefs({ promptEnhancer: { apiKey: 'k', mode: 'bogus' } });
  const p = ui.readPrefs();
  assert.strictEqual(p.promptEnhancer.apiKey, 'k');
  assert.strictEqual(p.promptEnhancer.mode, 'gentle');
});
