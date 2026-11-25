'use strict';
import { test, vi } from 'vitest';
import assert from 'node:assert';

const h = vi.hoisted(() => ({
  streamImpl: null,
  executeImpl: null,
  materializeImpl: null,
  cuckooImpl: null,
  toolMode: 'native',
  snapToolMode: null,
  sent: [],
  loadMessages: [],
  createdOpts: null,
  savedMessages: null,
  savedOpts: null,
}));

vi.mock('../../src/api-transport/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    streamChat: (...args) => h.streamImpl(...args),
  };
});

vi.mock('../../src/api-transport/tool-loop.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildOpenAiTools: () => [],
    executeApiToolCall: (...args) => h.executeImpl(...args),
    formatToolCall: (call) => call.function.name + '(...)',
  };
});

vi.mock('../../src/api-transport/cuckoo-js-loop.js', () => ({
  runCuckooJsTurn: (...args) => h.cuckooImpl(...args),
}));

vi.mock('../../src/app/ui-prefs.js', () => ({
  readPrefs: () => ({
    apiTransport: {
      baseUrl: 'http://127.0.0.1:3000/v1',
      apiKey: '',
      model: 'm',
      toolsEnabled: true,
      maxToolRounds: 2,
    },
    promptEnhancer: {},
  }),
  getApiConnection: () => ({
    baseUrl: 'http://127.0.0.1:3000/v1',
    apiKey: '',
    model: 'm',
    toolsEnabled: true,
    maxToolRounds: 2,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    reasoningEffort: 'auto',
    vision: true,
    systemPrompt: '',
    usageReporting: 'off',
    toolMode: h.toolMode,
  }),
}));

vi.mock('../../src/api-transport/system-prompt.js', () => ({
  buildApiSystemPrompt: () => 'system prompt',
  buildCuckooApiSystemPrompt: () => 'cuckoo system prompt',
}));

vi.mock('../../src/api-transport/attachments.js', () => ({
  saveIncomingAttachments: async () => ({ success: true, stored: [] }),
  materializeMessages: async (messages, max) => (h.materializeImpl ? h.materializeImpl(messages, max) : messages),
}));

vi.mock('../../src/api-transport/session-store.js', () => ({
  loadApiSession: () => h.loadMessages,
  loadApiSessionSnapshot: () => (h.loadMessages.length
    ? { id: 's', title: 't', createdAt: 1, updatedAt: 1, messages: h.loadMessages, toolMode: h.snapToolMode || h.toolMode }
    : null),
  getActiveApiSessionId: () => 's',
  deriveSessionTitle: () => 't',
  saveApiSession: (_profile, messages, opts) => { h.savedMessages = messages; h.savedOpts = opts || null; },
  clearApiSession: () => {},
  createApiSession: (_profile, opts) => { h.createdOpts = opts || null; return 's-new'; },
  setActiveApiSession: () => true,
  deleteApiSession: () => 's',
  listApiSessions: () => ({ activeSessionId: 's', sessions: [] }),
  getApiSessionProjectDir: () => null,
  setApiSessionProjectDir: () => true,
  pruneProfileAttachments: () => ({ removed: 0, bytes: 0 }),
}));

vi.mock('../../src/infra/process-tracker.js', () => ({
  abortWindowProcesses: () => {},
}));

vi.mock('../../src/tools/index.js', () => ({
  registry: { getDescriptions: () => [] },
  jsRunner: { abortAll: () => {} },
}));

function makeCtx() {
  h.sent = [];
  return {
    profileId: 'p',
    win: { id: 1, isDestroyed: () => false },
    harnessView: {
      webContents: {
        isDestroyed: () => false,
        send: (_channel, payload) => h.sent.push(payload),
      },
    },
    sessionStore: { state: { selectedProjectDir: 'D:\\work' } },
  };
}

function toolCall(id, name) {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

test('停止/抢占时补齐缺失 tool 结果，下一轮历史不会出现孤儿 assistant.tool_calls', async () => {
  const ctx = makeCtx();
  let streamCalls = 0;
  let capturedSecond = null;
  h.executeImpl = async (_ctx, call) => {
    if (call.function.name === 'a') {
      const { stopApiSession } = await import('../../src/api-transport/runtime.js');
      stopApiSession(_ctx);
    }
    return { success: true, output: 'ok:' + call.function.name };
  };
  h.streamImpl = async (opts) => {
    streamCalls++;
    if (streamCalls === 1) {
      return {
        text: '',
        think: '',
        finishReason: 'tool_calls',
        toolCalls: [toolCall('call_a', 'a'), toolCall('call_b', 'b')],
      };
    }
    capturedSecond = opts.messages;
    return { text: 'done', think: '', finishReason: 'stop', toolCalls: [] };
  };

  const { sendApiMessage } = await import('../../src/api-transport/runtime.js');
  const first = await sendApiMessage(ctx, '第一轮');
  assert.equal(first.success, false);
  assert.equal(first.code, 'stopped');

  // 第一轮停止后用户再发一条：历史里 assistant 的每个 tool_call 都必须有 tool 结果
  const second = await sendApiMessage(ctx, '第二轮');
  assert.equal(second.success, true);
  assert.ok(Array.isArray(capturedSecond));
  const assistant = capturedSecond.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistant, '应保留 assistant(tool_calls)');
  const ids = assistant.tool_calls.map((c) => c.id);
  for (const id of ids) {
    assert.ok(capturedSecond.some((m) => m.role === 'tool' && m.tool_call_id === id), '缺少 tool 结果: ' + id);
  }
  assert.ok(h.sent.some((e) => e.type === 'retry-state' && e.state === 'cancelled'));
});

test('停止后立刻新建对话：旧 turn 不能把 tool 结果留进新历史', async () => {
  const ctx = makeCtx();
  let streamCalls = 0;
  let capturedSecond = null;
  h.executeImpl = async (_ctx, call) => {
    if (call.function.name === 'a') {
      const runtime = await import('../../src/api-transport/runtime.js');
      runtime.stopApiSession(_ctx);
      runtime.resetApiSession(_ctx);
    }
    return { success: true, output: 'old-tool-result' };
  };
  h.streamImpl = async (opts) => {
    streamCalls++;
    if (streamCalls === 1) {
      return {
        text: '',
        think: '',
        finishReason: 'tool_calls',
        toolCalls: [toolCall('call_old', 'a')],
      };
    }
    capturedSecond = opts.messages.slice();
    return { text: 'new', think: '', finishReason: 'stop', toolCalls: [] };
  };

  const runtime = await import('../../src/api-transport/runtime.js');
  const first = await runtime.sendApiMessage(ctx, '旧消息');
  assert.equal(first.success, false);
  assert.equal(first.code, 'stopped');

  const second = await runtime.sendApiMessage(ctx, '新消息');
  assert.equal(second.success, true);
  assert.deepEqual(
    capturedSecond.map((m) => m.role),
    ['system', 'user'],
    '旧 turn 的工具结果 / assistant 不能残留到新对话',
  );
  assert.ok(!capturedSecond.some((m) => m.role === 'tool' && m.tool_call_id === 'call_old'));
});

test('空消息直接返回 empty，不创建会话请求', async () => {
  const ctx = makeCtx();
  const { sendApiMessage } = await import('../../src/api-transport/runtime.js');
  const r = await sendApiMessage(ctx, '   ');
  assert.equal(r.success, false);
  assert.equal(r.code, 'empty');
  assert.equal(h.sent.length, 0);
});

test('上游 400 拒绝图片块时自动降级纯文本重试，不让整轮失败', async () => {
  const ctx = makeCtx();
  const { ApiRequestError } = await import('../../src/api-transport/client.js');
  let streamCalls = 0;
  const captured = [];
  h.materializeImpl = async (messages, max) => {
    if (max === 0) return messages;
    return messages.map((m) => (m.role === 'user'
      ? { ...m, content: [{ type: 'text', text: String(m.content) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }
      : m));
  };
  h.streamImpl = async (opts) => {
    streamCalls++;
    captured.push(opts.messages);
    if (streamCalls === 1) throw new ApiRequestError('bad image part', 400, 'type=unknown');
    return { text: '文本降级成功', think: '', finishReason: 'stop', toolCalls: [] };
  };
  const { sendApiMessage } = await import('../../src/api-transport/runtime.js');
  const r = await sendApiMessage(ctx, '看图');
  assert.equal(r.success, true, JSON.stringify({ r, sent: h.sent }));
  assert.equal(r.text, '文本降级成功');
  assert.equal(streamCalls, 2);
  const second = captured[1];
  const user = second.find((m) => m.role === 'user');
  assert.equal(typeof user.content, 'string', '第二次请求必须退回纯文本 content');
  assert.ok(!JSON.stringify(second).includes('image_url'), '第二次请求不能带图片块');
  assert.ok(h.sent.some((e) => e.type === 'notice' && /纯文本重试/.test(e.text || '')), '应提示图片已降级');
});

test('图片 400 只影响当前模型；新对话后重新允许图片', async () => {
  const ctx = { ...makeCtx(), profileId: 'vision-scope' };
  const maxes = [];
  h.materializeImpl = async (messages, max) => {
    maxes.push(max);
    if (max === 0) return messages;
    return messages.map((m) => (m.role === 'user'
      ? { ...m, content: [{ type: 'text', text: String(m.content) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }
      : m));
  };
  let streamCalls = 0;
  h.streamImpl = async () => {
    streamCalls++;
    if (streamCalls === 1) {
      const { ApiRequestError } = await import('../../src/api-transport/client.js');
      throw new ApiRequestError('bad image part', 400, 'invalid image');
    }
    return { text: 'ok', think: '', finishReason: 'stop', toolCalls: [] };
  };
  const runtime = await import('../../src/api-transport/runtime.js');
  const first = await runtime.sendApiMessage(ctx, '看图');
  assert.equal(first.success, true);
  const second = await runtime.sendApiMessage(ctx, '再看');
  assert.equal(second.success, true);
  runtime.resetApiSession(ctx);
  const third = await runtime.sendApiMessage(ctx, '新对话看图');
  assert.equal(third.success, true);
  assert.deepEqual(maxes, [8, 0, 0, 8], '同模型降级后不再发图；新对话/切模型应恢复');
});

test('getApiHistory 只回传用户/助手正文，供 API 重启恢复界面', async () => {
  h.loadMessages = [
    { role: 'system', content: '系统提示词不应出现在界面历史里' },
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: [{ type: 'text', text: '第一答' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'read')] },
    { role: 'tool', tool_call_id: 'c1', content: '工具结果不应出现在界面历史里' },
    { role: 'user', content: null, attachments: [{ name: 'a.png', mime: 'image/png', path: 'x', size: 1, kind: 'image' }] },
  ];
  const ctx = { ...makeCtx(), profileId: 'hist-only' };
  const { getApiHistory } = await import('../../src/api-transport/runtime.js');
  const r = getApiHistory(ctx);
  assert.equal(r.success, true);
  assert.deepEqual(r.items, [
    { t: 'user', text: '第一句' },
    { t: 'assistant', text: '第一答' },
    { t: 'user', text: '[附件 1 个]' },
  ]);
});

test('隐藏技能/计划指令不进历史气泡：displayText 优先，content 仍完整发给模型', async () => {
  h.loadMessages = [];
  h.materializeImpl = null;
  const ctx = { ...makeCtx(), profileId: 'display-text' };
  let captured = null;
  h.streamImpl = async (opts) => {
    captured = opts.messages;
    return { text: '答', think: '', finishReason: 'stop', toolCalls: [] };
  };
  const runtime = await import('../../src/api-transport/runtime.js');
  const send = await runtime.sendApiMessage(ctx, '<skill>hidden</skill>\n真正问题', [], '真正问题');
  assert.equal(send.success, true);
  const user = captured.find((m) => m.role === 'user');
  assert.ok(String(user.content).includes('hidden'), '发送给模型的 content 保留隐藏指令');
  assert.equal(user.displayText, '真正问题', '本地消息保存展示文本');
  const hist = runtime.getApiHistory(ctx);
  const bubble = hist.items.find((it) => it.t === 'user');
  assert.equal(bubble.text, '真正问题', '界面历史只能看到展示文本');
  assert.ok(!bubble.text.includes('hidden'), '不能回显隐藏技能指令');
});

test('API 新对话继承当前项目目录并落盘到新会话', async () => {
  h.loadMessages = [];
  h.createdOpts = null;
  const ctx = { ...makeCtx(), profileId: 'new-session-project' };
  ctx.sessionStore.state.selectedProjectDir = 'D:\\work-a';
  const runtime = await import('../../src/api-transport/runtime.js');
  const r = await runtime.startNewApiSession(ctx);
  assert.equal(r.success, true);
  assert.equal(h.createdOpts.projectDir, 'D:\\work-a');
  assert.equal(ctx.sessionStore.state.selectedProjectDir, 'D:\\work-a');
  assert.ok(h.sent.some((e) => e.type === 'project-dir' && e.dir === 'D:\\work-a'));
});

test('API 编辑旧消息按“从后往前第 N 条 user”物理截断上下文，不是追加', async () => {
  h.loadMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
  ];
  h.savedMessages = null;
  const ctx = { ...makeCtx(), profileId: 'truncate-api-context' };
  const runtime = await import('../../src/api-transport/runtime.js');
  const r = runtime.truncateApiHistory(ctx, 1);
  assert.equal(r.success, true);
  assert.equal(r.removed, 4);
  assert.deepEqual(h.savedMessages.map((m) => m.role + ':' + m.content), [
    'system:sys',
    'user:q1',
    'assistant:a1',
  ]);
  const hist = runtime.getApiHistory(ctx);
  assert.deepEqual(hist.items.map((m) => m.t + ':' + m.text), ['user:q1', 'assistant:a1']);
});

test('cuckoo-js 模式走独立循环，不调用 native streamChat', async () => {
  h.toolMode = 'cuckoo-js';
  h.snapToolMode = 'cuckoo-js';
  h.loadMessages = [];
  h.streamImpl = async () => { throw new Error('native streamChat 不应被调用'); };
  let called = null;
  h.cuckooImpl = async (input) => {
    called = input;
    input.state.turn = null;
    input.state.controller = null;
    return { success: true, text: 'cuckoo ok' };
  };
  const ctx = { ...makeCtx(), profileId: 'cuckoo-mode' };
  const runtime = await import('../../src/api-transport/runtime.js');
  const r = await runtime.sendApiMessage(ctx, 'hi');
  assert.equal(r.success, true);
  assert.equal(r.text, 'cuckoo ok');
  assert.ok(called, '必须进入 cuckoo-js 循环');
  assert.equal(called.runtime.toolMode, 'cuckoo-js');
  assert.equal(called.runtime.tools.length, 0, 'cuckoo-js 不能构建 native tools');
  assert.equal(called.state.projectDir, 'D:\\work');
  h.toolMode = 'native';
  h.snapToolMode = null;
});

test('cuckoo-js 的 internal 工具消息不出现在恢复后的 UI 历史', async () => {
  h.toolMode = 'cuckoo-js';
  h.snapToolMode = 'cuckoo-js';
  h.loadMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '真实问题' },
    { role: 'assistant', content: '```cuckoo\nawait bash("dir")\n```', internal: true, displayText: '' },
    { role: 'user', content: '工具结果', internal: true },
    { role: 'assistant', content: '最终回答', displayText: '最终回答' },
  ];
  const ctx = { ...makeCtx(), profileId: 'cuckoo-history' };
  const runtime = await import('../../src/api-transport/runtime.js');
  const hist = runtime.getApiHistory(ctx);
  assert.deepEqual(hist.items, [
    { t: 'user', text: '真实问题' },
    { t: 'assistant', text: '最终回答' },
  ]);
  h.toolMode = 'native';
  h.snapToolMode = null;
});

test('空会话跟随当前模式，不误报 mode_mismatch', async () => {
  h.toolMode = 'cuckoo-js';
  h.snapToolMode = 'native';
  h.loadMessages = [{ role: 'system', content: 'sys' }];
  h.streamImpl = async () => { throw new Error('应走 cuckoo 分支'); };
  h.cuckooImpl = async (input) => {
    input.state.turn = null;
    input.state.controller = null;
    return { success: true, text: 'ok' };
  };
  const ctx = { ...makeCtx(), profileId: 'empty-mode-adopt' };
  const runtime = await import('../../src/api-transport/runtime.js');
  const r = await runtime.sendApiMessage(ctx, 'hi');
  assert.equal(r.success, true);
  h.toolMode = 'native';
  h.snapToolMode = null;
});

test('旧会话工具模式与当前设置不一致时拒绝发送，避免污染历史', async () => {
  h.toolMode = 'native';
  h.snapToolMode = 'cuckoo-js';
  h.loadMessages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }];
  h.streamImpl = async () => { throw new Error('模式不一致时不应请求上游'); };
  const ctx = { ...makeCtx(), profileId: 'mode-mismatch' };
  const runtime = await import('../../src/api-transport/runtime.js');
  const r = await runtime.sendApiMessage(ctx, 'hi');
  assert.equal(r.success, false);
  assert.equal(r.code, 'mode_mismatch');
  h.snapToolMode = null;
});

test('API 截断到不存在的消息返回失败，不写盘', async () => {
  h.loadMessages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q1' }];
  h.savedMessages = null;
  const ctx = { ...makeCtx(), profileId: 'truncate-api-missing' };
  const runtime = await import('../../src/api-transport/runtime.js');
  const r = runtime.truncateApiHistory(ctx, 9);
  assert.equal(r.success, false);
  assert.equal(h.savedMessages, null);
});
