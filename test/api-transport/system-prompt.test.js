'use strict';
import { test, vi } from 'vitest';
import assert from 'node:assert';

vi.mock('../../src/session/prompt-builder.js', () => ({
  buildPrompt: (opts) => ({
    prompt: '# API\n项目=' + opts.selectedDir + '\n自定义=' + (opts.customSystemPrompt || ''),
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
