'use strict';
import { test, vi } from 'vitest';
import assert from 'node:assert';

vi.mock('../../src/session/prompt-builder.js', () => ({
  buildPrompt: (opts) => ({
    prompt: '# ' + opts.providerId + '\n项目=' + opts.selectedDir + '\n自定义=' + (opts.customSystemPrompt || ''),
  }),
}));

test('API 系统提示词复用主提示词构建器，并注入项目目录/自定义指令', async () => {
  const { buildApiSystemPrompt } = await import('../../src/api-transport/system-prompt.js');
  const p = buildApiSystemPrompt({ selectedDir: 'D:\\work\\demo', customSystemPrompt: '用中文' });
  assert.ok(p.includes('项目=D:\\work\\demo'));
  assert.match(p, /自定义=用中文/);
  assert.doesNotMatch(p, /cuckoo 代码块/);
});

test('提示词构建失败时仍有可用的 API 兜底，不阻断对话', async () => {
  vi.resetModules();
  vi.doMock('../../src/session/prompt-builder.js', () => ({
    buildPrompt: () => { throw new Error('boom'); },
  }));
  const { buildApiSystemPrompt } = await import('../../src/api-transport/system-prompt.js?fallback');
  const p = buildApiSystemPrompt({ selectedDir: 'D:\\work', customSystemPrompt: 'X' });
  assert.match(p, /Cuckoo Code/);
  assert.match(p, /X/);
});

test('cuckoo-js 提示词走 quick provider，并保留项目目录/自定义指令', async () => {
  vi.resetModules();
  vi.doMock('../../src/session/prompt-builder.js', () => ({
    buildPrompt: (opts) => ({ prompt: '# ' + opts.providerId + '\n项目=' + opts.selectedDir + '\n自定义=' + (opts.customSystemPrompt || '') }),
  }));
  const { buildCuckooApiSystemPrompt } = await import('../../src/api-transport/system-prompt.js?cuckoo');
  const p = buildCuckooApiSystemPrompt({ selectedDir: 'D:\\work\\demo', customSystemPrompt: '用中文' });
  assert.match(p, /# quick/);
  assert.match(p, /项目=D:\\work\\demo/);
  assert.match(p, /自定义=用中文/);
  assert.ok(p.length <= 16000, 'quick 提示词必须在网关裁剪线以内');
});

test('cuckoo-js 提示词构建失败时回退到内置协议，不阻断对话', async () => {
  vi.resetModules();
  vi.doMock('../../src/session/prompt-builder.js', () => ({
    buildPrompt: () => { throw new Error('boom'); },
  }));
  const { buildCuckooApiSystemPrompt } = await import('../../src/api-transport/system-prompt.js?cuckoo-fallback');
  const p = buildCuckooApiSystemPrompt({ selectedDir: 'D:\\work', customSystemPrompt: 'X' });
  assert.match(p, /Cuckoo Code/);
  assert.match(p, /```cuckoo/);
  assert.match(p, /await bash/);
  assert.match(p, /mcpCall/, '兜底提示词也必须让模型知道 MCP 工具存在');
});
