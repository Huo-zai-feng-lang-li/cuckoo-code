'use strict';
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

// Electron 是"外部运行时边界"（其 index.js 导出的是可执行文件路径字符串，非模块）。
// 真实 Electron 下 app.getAppPath() 返回项目根；这里用 Module._load 拦截 require('electron')，
// 把 app 指到真实项目根，从而让 paths/prompt-builder 用真实模板与文件跑起来。
// 这不属于"mock 内部模块"，符合测试哲学（只模拟外部边界）。
const origLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => path.join(process.cwd(), 'test', 'tmp', 'prompt-builder-userdata'),
        isPackaged: false,
      },
    };
  }
  return origLoad.apply(this, arguments);
};

let pb;
beforeAll(async () => {
  pb = await import('../../src/session/prompt-builder.js');
});

afterAll(() => {
  Module._load = origLoad;
});

test('PROMPT_DIR 指向 src/prompt', () => {
  assert.ok(pb.PROMPT_DIR.endsWith(path.join('src', 'prompt')), pb.PROMPT_DIR);
});

test('loadTemplate 已知平台返回非空内容', () => {
  const r = pb.loadTemplate('deepseek');
  assert.ok(r.content.length > 0);
  assert.ok(!r.error);
});

test('loadTemplate 未知 providerId 回退 default.md', () => {
  const r = pb.loadTemplate('no-such-provider-xyz');
  assert.ok(r.content.length > 0, '应回退到 default.md');
  assert.ok(r.path.endsWith('default.md'));
  assert.ok(!r.error);
});

test('loadTemplate provider.getPromptTemplate 优先级最高', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => '来自 getPromptTemplate 的模板内容 {{TOOLS_LIST}}';
  try {
    const r = pb.loadTemplate('deepseek');
    assert.strictEqual(r.path, '(provider.getPromptTemplate)');
    assert.ok(r.content.includes('来自 getPromptTemplate'));
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('loadTemplate provider.getPromptTemplate 返回空则回退文件模板', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => '   ';
  try {
    const r = pb.loadTemplate('deepseek');
    assert.ok(r.path.endsWith('deepseek.md'));
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('loadTemplate provider.getPromptTemplate 抛错时回退文件模板', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => { throw new Error('模板方法崩溃'); };
  try {
    const r = pb.loadTemplate('deepseek');
    assert.ok(r.content.length > 0);
    assert.ok(!r.error);
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('buildPrompt 替换核心占位符', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    const p = r.prompt;
    // 占位符应已被替换（不再残留）
    assert.ok(!p.includes('{{TOOLS_LIST}}'));
    assert.ok(!p.includes('{{TOOL_SECTIONS}}'));
    assert.ok(!p.includes('{{PLATFORM_INFO}}'));
    assert.ok(!p.includes('{{PROJECT_DIR}}'));
    assert.ok(!p.includes('{{MCP_SECTION}}'));
    assert.ok(!p.includes('{{TOOL_API_TYPES}}'));
    assert.ok(!p.includes('{{PROJECT_INTRO_SECTION}}'));
    // 正向守护：工具契约必须真实注入，否则模型无法调用任何工具
    assert.ok(p.includes('declare function read(filePath: string'), '必须注入工具签名');
    assert.ok(p.includes('## 可用技能（Skills）'), '必须注入技能章节');
    // 项目目录被写入
    assert.ok(p.includes(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt PLATFORM_INFO 含当前平台信息', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('操作系统'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt quick 模板可直接加载且包含 cuckoo-js 契约', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const tpl = pb.loadTemplate('quick');
    assert.ok(tpl.path.endsWith(path.join('src', 'prompt', 'quick.md')), tpl.path);
    const r = pb.buildPrompt({ providerId: 'quick', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    assert.ok(r.prompt.includes('```cuckoo'), '必须告诉模型输出 cuckoo 代码块');
    assert.ok(r.prompt.includes('declare function bash'), '必须给出 bash 签名');
    assert.ok(r.prompt.includes('mcpCall'), '必须给出 MCP 工具声明');
    assert.ok(r.prompt.length <= 16000, 'Quick 首条消息预算 16000，实际 ' + r.prompt.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt quick 注入全局规则、技能索引和 MCP 章节，且不挤爆预算', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-quick-'));
  const home = path.join(tmp, 'home');
  const rulesDir = path.join(home, '.agents', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'quick-inject.md'),
    '# 测试规则\n\n这条规则必须进入 cuckoo-js 的首条消息：禁止在最终回答里泄漏内部工具协议。\n',
    'utf8'
  );
  const oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = home;
  try {
    const r = pb.buildPrompt({ providerId: 'quick', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    assert.ok(r.prompt.includes('## 项目规则'), '缺少项目规则章节');
    assert.ok(r.prompt.includes('这条规则必须进入 cuckoo-js'), '规则正文没有注入');
    assert.ok(r.prompt.includes('## 可用技能（Skills）'), '缺少技能章节');
    assert.ok(r.prompt.includes('## MCP 能力'), '缺少 MCP 章节');
    assert.ok(r.prompt.includes('mcpListServers'), '缺少 MCP 工具调用说明');
    assert.ok(r.prompt.length <= 16000, 'Quick 首条消息预算 16000，实际 ' + r.prompt.length);
  } finally {
    if (oldHome === undefined) delete process.env.CUCKOO_HOME;
    else process.env.CUCKOO_HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isCompaction 末尾追加"请继续你之前的工作"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isCompaction: true });
    assert.ok(r.prompt.includes('请继续你之前的工作'));
    assert.ok(r.prompt.trimEnd().endsWith('请继续你之前的工作'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 无 CUCKOO.md 时 PROJECT_INTRO_SECTION 为空', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    // 没有项目介绍章节
    assert.ok(!r.prompt.includes('## 项目介绍'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 读取 CUCKOO.md 并注入项目介绍', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const dir = path.join(tmp, '.cuckooCode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), '这是一个测试项目的介绍内容', 'utf-8');
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('## 项目介绍'));
    assert.ok(r.prompt.includes('这是一个测试项目的介绍内容'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 超长 CUCKOO.md 被截断，且提示按需 read', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const dir = path.join(tmp, '.cuckoo');
    fs.mkdirSync(dir, { recursive: true });
    const tail = 'TAIL_SENTINEL_SHOULD_NOT_APPEAR';
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), '项目说明。'.repeat(3000) + tail, 'utf-8');
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('## 项目介绍'));
    assert.ok(r.prompt.includes('内容过长已截断'), '必须给出截断说明');
    assert.ok(r.prompt.includes('read ' + path.join(dir, 'CUCKOO.md')), '必须提示按需 read 全文');
    assert.ok(!r.prompt.includes(tail), '截断后不应包含尾部哨兵');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 极端项目文档下总长度不超 36,000 字符预算', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const dir = path.join(tmp, '.cuckoo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), 'A'.repeat(30000), 'utf-8');
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.length <= 36000, '实际长度 ' + r.prompt.length);
    // 预算再紧也不能裁掉工具契约
    assert.ok(r.prompt.includes('declare function read(filePath: string'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 不存在的模板文件走 default（未知 provider）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'nonexistent-xyz', selectedDir: tmp });
    assert.ok(!r.error);
    assert.ok(r.prompt.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
