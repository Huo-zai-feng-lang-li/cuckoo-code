'use strict';
/**
 * cuckoo-js 执行桥：guard 拒绝不执行；放行时把白名单、项目目录、windowId
 * 原样交给 JsRunner，绝不让脚本自己选工具范围。
 */
import { test, vi } from 'vitest';
import assert from 'node:assert';

const h = vi.hoisted(() => ({
  guard: null,
  run: null,
  guardCalls: [],
  runCalls: [],
  planCalls: [],
}));

vi.mock('../../src/app/ipc-guard.js', () => ({
  guardExecutionCall: (event, kind, payload) => {
    h.guardCalls.push({ event, kind, payload });
    return h.guard;
  },
}));

vi.mock('../../src/tools/index.js', () => ({
  jsRunner: { run: (...args) => { h.runCalls.push(args); return h.run(...args); } },
}));

vi.mock('../../src/app/ipc/tool.js', () => ({
  pushPlanEvent: (...args) => { h.planCalls.push(args); },
}));

function makeCtx() {
  return {
    win: { id: 7, isDestroyed: () => false },
    harnessView: { webContents: { isDestroyed: () => false, getURL: () => 'file://harness.html' } },
    sessionStore: { state: { selectedProjectDir: 'D:\\work' } },
  };
}

test('guard 通过后按白名单执行，并透传项目目录/windowId/sessionId', async () => {
  h.guardCalls = [];
  h.runCalls = [];
  h.planCalls = [];
  h.guard = { pass: true, ctx: {} };
  h.run = async () => ({ success: true, output: 'files' });
  const { executeCuckooJs } = await import('../../src/api-transport/cuckoo-js-exec.js');
  const r = await executeCuckooJs(makeCtx(), 'await bash("dir")', 'D:\\work', 's1');
  assert.equal(r.success, true);
  assert.equal(r.output, 'files');
  assert.equal(h.guardCalls[0].kind, 'js');
  assert.deepEqual(h.guardCalls[0].payload, { code: 'await bash("dir")' });
  assert.equal(h.runCalls[0][0], 'await bash("dir")');
  assert.equal(h.runCalls[0][1], 'D:\\work');
  assert.equal(h.runCalls[0][2], 7);
  assert.equal(h.runCalls[0][3].sessionId, 's1');
  assert.ok(Array.isArray(h.runCalls[0][3].allowedTools));
  assert.equal(h.runCalls[0][3].allowedTools.includes('runAgent'), false);
  assert.equal(h.runCalls[0][3].allowedTools.includes('mcpListServers'), true);
  assert.equal(h.runCalls[0][3].allowedTools.includes('mcpGetTools'), true);
  assert.equal(h.runCalls[0][3].allowedTools.includes('mcpCall'), true);
  assert.equal(h.planCalls.length, 1);
});

test('guard 拒绝时绝不执行脚本', async () => {
  h.runCalls = [];
  h.guard = { pass: false, error: { error: '来源校验失败' } };
  h.run = async () => { throw new Error('不应执行'); };
  const { executeCuckooJs } = await import('../../src/api-transport/cuckoo-js-exec.js');
  const r = await executeCuckooJs(makeCtx(), 'await bash("dir")', 'D:\\work', 's1');
  assert.equal(r.success, false);
  assert.match(r.error, /来源校验失败/);
  assert.equal(h.runCalls.length, 0);
});

test('已停止的信号不进入 guard', async () => {
  h.runCalls = [];
  h.guardCalls = [];
  const ac = new AbortController();
  ac.abort();
  const { executeCuckooJs } = await import('../../src/api-transport/cuckoo-js-exec.js');
  const r = await executeCuckooJs(makeCtx(), 'await bash("dir")', 'D:\\work', 's1', ac.signal);
  assert.equal(r.success, false);
  assert.equal(h.guardCalls.length, 0);
});
