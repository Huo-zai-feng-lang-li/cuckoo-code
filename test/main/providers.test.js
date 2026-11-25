import { test, vi } from 'vitest';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getProvider, getAllProviders, getProviderByUrl } from '../../src/providers/registry.js';
import { deepseek } from '../../src/providers/deepseek.js';

test('getAllProviders 只保留 DeepSeek 与 API Key', () => {
  const ids = getAllProviders().map((p) => p.id);
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('api-key'));
  assert.ok(!ids.includes('claude'));
  assert.ok(!ids.includes('chatgpt'));
});

test('getProvider 按 id 查找', () => {
  assert.strictEqual(getProvider('deepseek').id, 'deepseek');
  assert.strictEqual(getProvider('api-key').id, 'api-key');
  assert.strictEqual(getProvider('claude'), null);
  assert.strictEqual(getProvider('chatgpt'), null);
  assert.strictEqual(getProvider('unknown'), null);
});

test('getProviderByUrl 识别 DeepSeek URL', () => {
  assert.strictEqual(getProviderByUrl('https://chat.deepseek.com/').id, 'deepseek');
  assert.strictEqual(getProviderByUrl('https://chat.deepseek.com/a/chat/s/abc').id, 'deepseek');
});

test('getProviderByUrl 不再识别 Claude / ChatGPT', () => {
  assert.strictEqual(getProviderByUrl('https://claude.ai/new'), null);
  assert.strictEqual(getProviderByUrl('https://claude.ai/chat/abc'), null);
  assert.strictEqual(getProviderByUrl('https://chatgpt.com/'), null);
  assert.strictEqual(getProviderByUrl('https://chat.openai.com/c/abc'), null);
});

test('getProviderByUrl 未识别返回 null', () => {
  assert.strictEqual(getProviderByUrl('https://example.com'), null);
  assert.strictEqual(getProviderByUrl(null), null);
});

test('deepseek matchesUrl', () => {
  assert.strictEqual(deepseek.matchesUrl('https://chat.deepseek.com/'), true);
  assert.strictEqual(deepseek.matchesUrl('https://example.com'), false);
});

test('deepseek extractSessionId', () => {
  assert.strictEqual(deepseek.extractSessionId('https://chat.deepseek.com/a/chat/s/abc123'), 'abc123');
  assert.strictEqual(deepseek.extractSessionId('https://chat.deepseek.com/s/def456'), 'def456');
  assert.strictEqual(deepseek.extractSessionId('https://chat.deepseek.com/'), null);
});

test('渲染进程经注入的 userData 路径可加载自定义 Provider', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-cp-'));
  const dir = path.join(tmp, 'custom-providers');
  fs.mkdirSync(dir, { recursive: true });
  const providerFile = path.join(dir, 'demo.js');
  fs.writeFileSync(providerFile,
    "module.exports = { id: 'demo', name: 'Demo', homeUrl: 'https://demo.example.com', " +
    "sessionUrlBase: 'https://demo.example.com/chat/', " +
    "matchesUrl: (u) => String(u).includes('demo.example.com'), extractSessionId: () => '1' };");
  fs.writeFileSync(path.join(tmp, 'custom-providers.json'),
    JSON.stringify({ paths: [providerFile.replace(/\\/g, '/')] }));

  const savedArgv = process.argv;
  const savedType = process.type;
  process.type = 'renderer';
  process.argv = savedArgv.concat(['--cuckoo-user-data=' + tmp]);
  try {
    // loader 有模块级副作用（加载时读 process.type/argv），
    // 用 resetModules + 动态 import 让它重新求值
    vi.resetModules();
    const { loadCustomProviders } = await import('../../src/providers/custom/loader.js');
    const ps = loadCustomProviders();
    assert.ok(ps.some((p) => p.id === 'demo'), '渲染进程应能加载注入路径下的自定义 Provider');
  } finally {
    process.type = savedType;
    process.argv = savedArgv;
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
