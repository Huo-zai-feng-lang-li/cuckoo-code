'use strict';
/**
 * cuckoo-js 循环测试：模型只写代码块，本地执行，结果以普通 user 消息回传。
 * 不发送 native tools/tool_calls；最终回答和工具轮次必须分开标记。
 */
import { test, vi } from 'vitest';
import assert from 'node:assert';

const h = vi.hoisted(() => ({
  streamImpl: null,
  execImpl: null,
  streams: [],
  execs: [],
}));

vi.mock('../../src/api-transport/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    streamChat: (...args) => h.streamImpl(...args),
  };
});

vi.mock('../../src/api-transport/cuckoo-js-exec.js', () => ({
  ALLOWED_TOOLS: ['bash', 'read'],
  executeCuckooJs: (...args) => h.execImpl(...args),
}));

vi.mock('../../src/api-transport/attachments.js', () => ({
  materializeMessages: async (messages) => messages,
}));

vi.mock('../../src/api-transport/cuckoo-js.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    formatCuckooResult: (result) => 'RESULT: ' + (result.output || result.error),
  };
});

function makeState() {
  const ac = new AbortController();
  return {
    sessionId: 's1',
    title: 't',
    createdAt: 1,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do it' }],
    controller: ac,
    projectDir: 'D:\\work',
    turn: null,
    pendingReset: false,
    systemKey: '',
    visionUnsupported: false,
    disposed: false,
    usageTotal: {},
  };
}

function makeRuntime(overrides = {}) {
  return {
    config: { baseUrl: 'http://x', model: 'aws' },
    connection: { vision: false, reasoningEffort: 'auto', usageReporting: 'off' },
    toolsEnabled: true,
    maxToolRounds: 2,
    budget: { inputBudget: 100000, outputReserve: 4096 },
    systemPrompt: 'sys',
    systemKey: 'k',
    toolMode: 'cuckoo-js',
    ...overrides,
  };
}

function makeHooks() {
  const events = [];
  return {
    events,
    persist: () => {},
    trimHistory: () => {},
    uiDropped: () => false,
    emit: (_ctx, payload) => events.push(payload),
  };
}

test('最终纯文本：不执行工具，不带 native tools，原样结束', async () => {
  h.streams = [];
  h.execs = [];
  h.streamImpl = async (opts) => {
    h.streams.push(opts);
    return { text: '最终答案', think: '想一下', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
  };
  h.execImpl = async (...args) => { h.execs.push(args); return { success: true, output: 'x' }; };
  const { runCuckooJsTurn } = await import('../../src/api-transport/cuckoo-js-loop.js');
  const state = makeState();
  const hooks = makeHooks();
  const r = await runCuckooJsTurn({ ctx: {}, state, controller: state.controller, runtime: makeRuntime(), hooks });
  assert.equal(r.success, true);
  assert.equal(r.text, '最终答案');
  assert.equal(h.execs.length, 0);
  assert.equal(h.streams[0].tools, undefined);
  assert.equal(h.streams[0].conversationId, 'cuckoo-js:s1');
  assert.equal(state.messages.at(-1).role, 'assistant');
  assert.equal(state.messages.at(-1).content, '最终答案');
});

test('代码块执行后把结果作为 internal user 回传，再请求下一轮', async () => {
  h.streams = [];
  h.execs = [];
  h.streamImpl = async (opts) => {
    h.streams.push(opts);
    if (h.streams.length === 1) {
      return { text: '先跑一下\n```cuckoo\nawait bash("dir")\n```\n' };
    }
    return { text: '跑完了，目录有文件' };
  };
  h.execImpl = async (...args) => { h.execs.push(args); return { success: true, output: 'a.txt' }; };
  const { runCuckooJsTurn } = await import('../../src/api-transport/cuckoo-js-loop.js');
  const state = makeState();
  const hooks = makeHooks();
  const r = await runCuckooJsTurn({ ctx: {}, state, controller: state.controller, runtime: makeRuntime({ maxToolRounds: 3 }), hooks });
  assert.equal(r.success, true);
  assert.equal(h.execs.length, 1);
  assert.equal(h.execs[0][1], 'await bash("dir")');
  assert.equal(h.execs[0][2], 'D:\\work');
  assert.equal(h.execs[0][3], 's1');
  const internal = state.messages.find((m) => m.role === 'user' && m.internal);
  assert.ok(internal, '工具结果必须写成 internal user 消息');
  assert.match(internal.content, /RESULT: a.txt/);
  assert.equal(state.messages.some((m) => m.role === 'tool'), false);
  assert.equal(h.streams[1].tools, undefined);
});

test('同一轮多个 cuckoo 块合并成一条 user 结果，避免 3000 续接只发最后一条', async () => {
  h.streams = [];
  h.execs = [];
  h.streamImpl = async (opts) => {
    h.streams.push(opts);
    if (h.streams.length === 1) {
      return { text: '```cuckoo\nawait bash("a")\n```\n```cuckoo\nawait bash("b")\n```' };
    }
    return { text: '两块都跑完了' };
  };
  const outputs = ['A', 'B'];
  h.execImpl = async (...args) => { h.execs.push(args); return { success: true, output: outputs[h.execs.length - 1] }; };
  const { runCuckooJsTurn } = await import('../../src/api-transport/cuckoo-js-loop.js');
  const state = makeState();
  const hooks = makeHooks();
  const r = await runCuckooJsTurn({ ctx: {}, state, controller: state.controller, runtime: makeRuntime({ maxToolRounds: 3 }), hooks });
  assert.equal(r.success, true);
  assert.equal(h.execs.length, 2);
  const internalUsers = state.messages.filter((m) => m.role === 'user' && m.internal);
  assert.equal(internalUsers.length, 1);
  assert.match(internalUsers[0].content, /A/);
  assert.match(internalUsers[0].content, /B/);
  assert.equal(h.streams[1].tools, undefined);
});

test('toolsEnabled=false 时只提示，不执行代码块', async () => {
  h.streams = [];
  h.execs = [];
  h.streamImpl = async () => ({ text: '```cuckoo\nawait bash("dir")\n```' });
  h.execImpl = async (...args) => { h.execs.push(args); return { success: true, output: 'x' }; };
  const { runCuckooJsTurn } = await import('../../src/api-transport/cuckoo-js-loop.js');
  const state = makeState();
  const hooks = makeHooks();
  const r = await runCuckooJsTurn({ ctx: {}, state, controller: state.controller, runtime: makeRuntime({ toolsEnabled: false }), hooks });
  assert.equal(r.success, false);
  assert.equal(r.code, 'tools_disabled');
  assert.equal(h.execs.length, 0);
});

test('达到最大工具轮次后停止，不无限循环', async () => {
  h.streams = [];
  h.execs = [];
  h.streamImpl = async () => ({ text: '```cuckoo\nawait bash("dir")\n```' });
  h.execImpl = async (...args) => { h.execs.push(args); return { success: true, output: 'x' }; };
  const { runCuckooJsTurn } = await import('../../src/api-transport/cuckoo-js-loop.js');
  const state = makeState();
  const hooks = makeHooks();
  const r = await runCuckooJsTurn({ ctx: {}, state, controller: state.controller, runtime: makeRuntime({ maxToolRounds: 1 }), hooks });
  assert.equal(r.success, false);
  assert.equal(r.code, 'rounds_limit');
  assert.equal(h.execs.length, 1);
  assert.equal(state.turn, null);
});

test('未闭合的 cuckoo 块不执行，也不把原始代码写进可见历史', async () => {
  h.streams = [];
  h.execs = [];
  h.streamImpl = async () => ({ text: '```cuckoo\nawait bash("dir")' });
  h.execImpl = async (...args) => { h.execs.push(args); return { success: true, output: 'x' }; };
  const { runCuckooJsTurn } = await import('../../src/api-transport/cuckoo-js-loop.js');
  const state = makeState();
  const hooks = makeHooks();
  const r = await runCuckooJsTurn({ ctx: {}, state, controller: state.controller, runtime: makeRuntime({ maxToolRounds: 2 }), hooks });
  assert.equal(r.success, true);
  assert.equal(h.execs.length, 0);
  assert.match(r.text, /未闭合/);
  const last = state.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.match(last.displayText, /未闭合/);
  assert.doesNotMatch(last.displayText, /await bash/);
});
