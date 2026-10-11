'use strict';
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

let executor;

function setupGlobals() {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.window = {
    location: { href: 'https://chat.deepseek.com/' },
    addEventListener: () => {},
    electronAPI: {
      executeJs: vi.fn(async () => ({ success: true, output: 'ok' })),
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  setupGlobals();
  executor = await import('../../../src/bridge/loop/executor.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('handleJsToolScript 成功返回结果', async () => {
  window.electronAPI.executeJs = vi.fn(async () => ({ success: true, output: '输出内容' }));
  const r = await executor.handleJsToolScript('const x = 1;');
  assert.strictEqual(r.code, 'const x = 1;');
  assert.strictEqual(r.result.success, true);
  assert.strictEqual(r.result.output, '输出内容');
});

test('handleJsToolScript 失败返回 error', async () => {
  window.electronAPI.executeJs = vi.fn(async () => ({ success: false, error: '执行出错' }));
  const r = await executor.handleJsToolScript('bad code');
  assert.strictEqual(r.result.success, false);
  assert.strictEqual(r.result.error, '执行出错');
});

test('handleJsToolScript executeJs 抛异常被捕获', async () => {
  window.electronAPI.executeJs = vi.fn(async () => { throw new Error('系统崩溃'); });
  const r = await executor.handleJsToolScript('code');
  assert.strictEqual(r.result.success, false);
  assert.ok(r.result.error.includes('系统异常'));
  assert.ok(r.result.error.includes('系统崩溃'));
});

test('handleJsToolScript 成功但无 output', async () => {
  window.electronAPI.executeJs = vi.fn(async () => ({ success: true }));
  const r = await executor.handleJsToolScript('code');
  assert.strictEqual(r.result.success, true);
  assert.strictEqual(r.result.output, undefined);
});
