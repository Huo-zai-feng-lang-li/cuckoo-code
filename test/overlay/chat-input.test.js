'use strict';
/**
 * chat-input 纯逻辑测试：随机延迟、输入框可见性、输入框查找
 * window/document/provider 是外部边界，按需 mock。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

const ipc = vi.hoisted(() => ({ listeners: new Map(), sent: [] }));
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({ ipcRenderer: {
      on: (channel, fn) => ipc.listeners.set(channel, fn),
      send: (channel, payload) => ipc.sent.push({ channel, payload }),
      invoke: async () => ({}),
    } }),
  };
});

let chat;
let state;

function setupGlobals() {
  globalThis.window = {
    location: { href: 'https://chat.deepseek.com/' },
    getComputedStyle: (el) => el.__style || { display: 'block', visibility: 'visible', opacity: '1' },
    HTMLTextAreaElement: { prototype: {} },
    HTMLInputElement: { prototype: {} },
  };
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  globalThis.document = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    body: { appendChild() {} },
    execCommand: () => true,
  };
  globalThis.Event = class { constructor() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  ipc.listeners.clear();
  ipc.sent.length = 0;
  setupGlobals();
  chat = await import('../../src/overlay/chat-input.js');
  state = (await import('../../src/overlay/state.js')).state;
});

afterEach(() => { vi.useRealTimers(); });

function composer() {
  const sent = [];
  const input = { tagName: 'TEXTAREA', value: '', focus() {}, dispatchEvent() {} };
  document.querySelectorAll = () => [input];
  window.electronAPI = {
    sendEnterToChat: async () => { sent.push(input.value); input.value = ''; return true; },
  };
  state.pauseEnabled = false;
  state.sendDelayMin = state.sendDelayMax = 0;
  return { input, sent };
}

test('取消覆盖尚未执行的工具结果，后续用户消息不串发', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  const first = chat.sendToChat('旧结果一', 'JS汇总', 5000);
  const queued = chat.sendToChat('旧结果二', 'JS汇总', 0);
  await vi.advanceTimersByTimeAsync(0);
  chat.cancelPendingSend();
  const fresh = chat.sendToChat('用户消息', 'harness', 0);
  await vi.runAllTimersAsync();
  assert.deepStrictEqual(await Promise.all([first, queued, fresh]), [false, false, true]);
  assert.deepStrictEqual(sent, ['用户消息']);
});

test('取消原生分块注入时停止剩余块及 DOM 回退，清理等待注入完成', async () => {
  vi.useFakeTimers();
  const { input, sent } = composer();
  let release;
  const inserting = new Promise((resolve) => { release = resolve; });
  window.electronAPI.insertTextToChat = async (text) => {
    await inserting;
    input.value += text;
    return true;
  };
  const old = chat.sendToChat('旧'.repeat(9000), 'JS汇总', 0);
  await vi.advanceTimersByTimeAsync(0);
  chat.cancelPendingSend();
  const cleared = chat.clearInputArea();
  release();
  await vi.runAllTimersAsync();
  assert.strictEqual(await old, false);
  assert.strictEqual(await cleared, true);
  assert.strictEqual(input.value, '');
  assert.deepStrictEqual(sent, []);
});

test('纯净模式快速连发保留每条用户消息，只撤销工具结果', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  const tool = chat.sendToChat('旧工具结果', 'JS汇总', 5000);
  await vi.advanceTimersByTimeAsync(0);
  const one = chat.sendUserMessageToChat('用户一');
  const two = chat.sendUserMessageToChat('用户二');
  await vi.runAllTimersAsync();
  assert.strictEqual(await tool, false);
  assert.deepStrictEqual(await Promise.all([one, two]), [true, true]);
  assert.deepStrictEqual(sent, ['用户一', '用户二']);
});

test('工具汇总长文本走附件，失败时完整回退文本', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  const uploads = [];
  window.electronAPI.sendAsFile = async (text) => { uploads.push(text); return { success: false }; };
  const text = '工具输出'.repeat(1500);
  const send = chat.sendToChat(text, 'JS汇总');
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, true);
  assert.deepStrictEqual(uploads, [text]);
  assert.deepStrictEqual(sent, [text]);
});

test('工具结果长暂停可取消且发出开始和结束通知', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  state.pauseEnabled = true;
  state.pauseChance = 1;
  state.pauseMinMs = state.pauseMaxMs = 30000;
  const pauses = [];
  chat.onSendPause((info) => pauses.push(info.active));
  const send = chat.sendToChat('工具结果', 'JS汇总');
  await vi.advanceTimersByTimeAsync(0);
  assert.deepStrictEqual(pauses, [true]);
  chat.cancelPendingSend();
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, false);
  assert.deepStrictEqual(pauses, [true, false]);
  assert.deepStrictEqual(sent, []);
});

test('工具结果长暂停结束后不再叠加常规发送延迟，直接填充并发送', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  state.pauseEnabled = true;
  state.pauseChance = 1;
  state.pauseMinMs = state.pauseMaxMs = 30000;
  // 设置长常规延迟，验证长暂停完成后不会再等待常规延迟
  state.sendDelayMin = state.sendDelayMax = 15000;
  const pauses = [];
  chat.onSendPause((info) => pauses.push(info.active));
  const send = chat.sendToChat('工具结果内容', 'JS汇总');
  await vi.advanceTimersByTimeAsync(0);
  assert.deepStrictEqual(pauses, [true]);
  assert.deepStrictEqual(sent, []);

  // 步进 30000ms（长暂停结束）：reactionMs 和 hesitationMs 为 0，
  // 分块注入后立即发送，不再等待 15000ms 常规延迟
  await vi.advanceTimersByTimeAsync(30000);
  await vi.advanceTimersByTimeAsync(500);
  assert.deepStrictEqual(sent, ['工具结果内容']);
  assert.strictEqual(await send, true);
  assert.deepStrictEqual(pauses, [true, false]);
});

test('Enter 打空（输入框残留）时判定未发出，不误报投递', async () => {
  vi.useFakeTimers();
  const { input } = composer();
  // 主进程 sendInputEvent 不抛异常即返回 true，但站点可能没收下（Enter 打空）：
  // 输入框残留 = 未发出，必须判 false 且不派发 delivered。
  window.electronAPI.sendEnterToChat = async () => true;
  const delivered = [];
  chat.onMessageDelivered(() => delivered.push(1));
  const send = chat.sendToChat('工具结果', 'JS汇总', 0);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, false);
  assert.strictEqual(input.value.length > 0, true);
  assert.deepStrictEqual(delivered, []);
});

test('切换-摘要属系统标签：即时投递、不上报为用户消息', () => {
  assert.strictEqual(chat.isSystemTag('切换-摘要'), true);
});

test('原生发送未结束时取消不能提前释放队列或发送新输入', async () => {
  vi.useFakeTimers();
  const { input, sent } = composer();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered = false;
  window.electronAPI.sendEnterToChat = async () => {
    if (!entered) { entered = true; await blocked; }
    sent.push(input.value);
    input.value = '';
    return true;
  };
  const old = chat.sendToChat('旧工具结果', 'JS汇总', 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.strictEqual(entered, true);
  chat.cancelPendingSend();
  const fresh = chat.sendUserMessageToChat('新用户消息');
  await vi.advanceTimersByTimeAsync(500);
  const beforeRelease = input.value;
  release();
  await vi.runAllTimersAsync();
  assert.strictEqual(beforeRelease, '旧工具结果');
  assert.deepStrictEqual(await Promise.all([old, fresh]), [false, true]);
  assert.deepStrictEqual(sent, ['旧工具结果', '新用户消息']);
});

test('用户消息已填充后第二条用户消息不会取消第一条', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  const one = chat.sendUserMessageToChat('用户一');
  await vi.advanceTimersByTimeAsync(1);
  const two = chat.sendUserMessageToChat('用户二');
  await vi.runAllTimersAsync();
  assert.deepStrictEqual(await Promise.all([one, two]), [true, true]);
  assert.deepStrictEqual(sent, ['用户一', '用户二']);
});

test('站点延迟清空输入时等待确认，避免误判失败与重复发送', async () => {
  vi.useFakeTimers();
  const { input, sent } = composer();
  window.electronAPI.sendEnterToChat = async () => {
    sent.push(input.value);
    setTimeout(() => { input.value = ''; }, 700);
    return true;
  };
  const send = chat.sendToChat('工具结果', 'JS汇总', 0);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, true);
  assert.deepStrictEqual(sent, ['工具结果']);
});

test('发送确认期间 URL 变化（站点创建新会话）不提前判失败，空框仍判投递成功', async () => {
  // 回归背景：首条消息触发站点创建新会话时 URL 会变；旧实现把 URL 变化直接当投递失败，
  // 触发上层重试 → 同一条消息双发。方案 A'：URL 变化不提前判失败，继续观察空框。
  vi.useFakeTimers();
  const { input } = composer();
  window.electronAPI.sendEnterToChat = async () => {
    window.location.href = 'https://chat.deepseek.com/a/new-session';
    document.querySelectorAll = () => [{ ...input, value: '' }];
    return true;
  };
  const delivered = [];
  chat.onMessageDelivered(() => delivered.push(1));
  const send = chat.sendToChat('首条消息', 'JS汇总', 0);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, true);
  assert.strictEqual(delivered.length, 1);
});

test('发送确认期间 URL 变化但输入框仍有残留，判未发出', async () => {
  vi.useFakeTimers();
  const { input } = composer();
  window.electronAPI.sendEnterToChat = async () => {
    window.location.href = 'https://chat.deepseek.com/a/new-session';
    document.querySelectorAll = () => [{ ...input, value: '旧会话内容' }];
    return true;
  };
  const delivered = [];
  chat.onMessageDelivered(() => delivered.push(1));
  const send = chat.sendToChat('旧会话内容', 'JS汇总', 0);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, false);
  assert.deepStrictEqual(delivered, []);
});

test('非 DeepSeek 平台长文本保持文本发送，不进入自动附件通道', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  window.location.href = 'https://example.invalid/chat';
  const uploads = [];
  window.electronAPI.sendAsFile = async (text) => { uploads.push(text); return { success: true }; };
  const text = '工具结果'.repeat(1500);
  const send = chat.sendToChat(text, 'JS汇总', 0);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, true);
  assert.deepStrictEqual(uploads, []);
  assert.deepStrictEqual(sent, [text]);
});

test('DeepSeek 平台超长系统提示词转为附件通道发送', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  window.location.href = 'https://chat.deepseek.com/';
  const uploads = [];
  window.electronAPI.sendAsFile = async (text, fileName) => {
    uploads.push({ text, fileName });
    return { success: true };
  };
  const text = '系统提示词设定内容'.repeat(600); // > 4000 字符
  const send = chat.sendToChat(text, '系统提示词', 0);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, true);
  assert.strictEqual(uploads.length, 1, '长系统提示词应调用 sendAsFile 上传附件');
  assert.ok(uploads[0].fileName.startsWith('系统设定-'), '文件名应以系统设定为前缀');
  assert.ok(sent[0].includes('系统设定与项目上下文已上传为附件'), '输入框应填入系统设定短提示词');
});

test('DeepSeek 平台用户长消息转为附件通道发送', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  window.location.href = 'https://chat.deepseek.com/';
  const uploads = [];
  window.electronAPI.sendAsFile = async (text, fileName) => {
    uploads.push({ text, fileName });
    return { success: true };
  };
  const text = '用户的长篇开发需求内容'.repeat(500); // > 4000 字符
  const send = chat.sendUserMessageToChat(text);
  await vi.runAllTimersAsync();
  assert.strictEqual(await send, true);
  assert.strictEqual(uploads.length, 1, '用户长文本应调用 sendAsFile 上传附件');
  assert.ok(uploads[0].fileName.startsWith('用户需求-'), '文件名应以用户需求为前缀');
  assert.ok(sent[0].includes('详细需求已整理为附件上传'), '输入框应填入用户需求短提示词');
});

test('初始提示回执只在网页确认清空后返回对应 requestId', async () => {
  vi.useFakeTimers();
  const { input, sent } = composer();
  window.electronAPI.sendEnterToChat = async () => {
    sent.push(input.value);
    setTimeout(() => { input.value = ''; }, 700);
    return true;
  };
  chat.registerIpcListeners();
  ipc.listeners.get('initial-prompt')({}, '承接上下文提示词', { requestId: 'switch-1' });
  await vi.advanceTimersByTimeAsync(500);
  assert.deepStrictEqual(ipc.sent, []);
  await vi.runAllTimersAsync();
  assert.deepStrictEqual(ipc.sent, [{ channel: 'initial-prompt-result', payload: { requestId: 'switch-1', success: true } }]);
  assert.deepStrictEqual(sent, ['承接上下文提示词']);
});

test('初始提示等待输入框期间停止，终止重试并回失败，不晚到复活', async () => {
  vi.useFakeTimers();
  chat.registerIpcListeners();
  ipc.listeners.get('initial-prompt')({}, '承接上下文提示词', { requestId: 'switch-stop' });
  await vi.advanceTimersByTimeAsync(10);
  chat.cancelPendingSend();
  const { sent } = composer();
  await vi.runAllTimersAsync();
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(ipc.sent, [{ channel: 'initial-prompt-result', payload: { requestId: 'switch-stop', success: false } }]);
});

test('randomDelay 在 [min, max] 范围内', () => {
  state.sendDelayMin = 1000;
  state.sendDelayMax = 2000;
  for (let i = 0; i < 50; i++) {
    const d = chat.randomDelay();
    assert.ok(d >= 1000 && d <= 2000, '延迟应在范围内: ' + d);
  }
});

test('randomDelay: 认知自适应按文本长度动态伸缩且不突破配置', () => {
  state.sendDelayMin = 1000;
  state.sendDelayMax = 60000;
  const span = (60000 - 1000) * 0.25;
  // 短文本：命中 min 后只在 [min, min+25%区间] 抖动（保持「短文本快」语义）
  for (let i = 0; i < 20; i++) {
    const d = chat.randomDelay('ok');
    assert.ok(d >= 1000 && d <= 1000 + span + 1, '短文本延迟应迅速: ' + d);
  }

  // 极长文本（16000 字 = ratio 1）：必须能逼近配置上限 max。
  // 旧实现固定上限 23000ms，配置 max=36000 时永远够不着（用户实测分布偏低即此因）。
  // 需求 114 后阈值提到 16000 并改用 sqrt 压缩：4000 字只到 ratio 0.5，
  // 故此处必须用 16000 字才能真正命中上限。
  const longText = 'a'.repeat(16000);
  let maxSeen = 0;
  for (let i = 0; i < 20; i++) {
    const d = chat.randomDelay(longText);
    assert.ok(d >= 1000 && d <= 60000, '不得突破配置区间: ' + d);
    if (d > maxSeen) maxSeen = d;
  }
  assert.ok(maxSeen > 40000, '极长文本必须能逼近配置上限: ' + maxSeen);
});

test('randomDelay: 中等长度内容不再贴死上限（需求 114 回归）', () => {
  // 痛点：工具回传动辄数千字符，旧实现 len/4000 直接 ratio=1，
  // 延迟永远贴死在配置上限（20 轮工具循环 = 10 分钟纯等待）。
  // 新实现 sqrt(len/16000)：4000 字只到 ratio 0.5，必须明显低于上限。
  state.sendDelayMin = 4000;
  state.sendDelayMax = 30000;
  const midText = 'a'.repeat(4000);
  const seen = [];
  for (let i = 0; i < 40; i++) seen.push(chat.randomDelay(midText));
  const avg = seen.reduce((a, b) => a + b, 0) / seen.length;
  assert.ok(avg < 22000, '4000 字内容的平均延迟应明显低于上限 30s: ' + Math.round(avg));
  assert.ok(avg > 9000, '也不应低到脱离认知模型: ' + Math.round(avg));
});

test('randomDelay: 短内容走快速通道（需求 114 回归）', () => {
  // 20 字的消息不该让用户等 12 秒。默认 4~30 下应落在 4~7 秒区间。
  state.sendDelayMin = 4000;
  state.sendDelayMax = 30000;
  for (let i = 0; i < 30; i++) {
    const d = chat.randomDelay('好的，继续');
    assert.ok(d <= 8000, '短消息延迟应贴近下限（≤8s），实际=' + d);
    assert.ok(d >= 4000, '不得低于配置下限: ' + d);
  }
});

test('planSendTiming: 总延迟严格遵守配置区间，R+S 恰好等于总延迟', () => {
  state.sendDelayMin = 6000;
  state.sendDelayMax = 36000;
  for (let i = 0; i < 50; i++) {
    const t = chat.planSendTiming('一段回传给 AI 的工具结果', 0);
    const total = t.reactionMs + t.hesitationMs;
    assert.ok(total >= 6000 && total <= 36000, '总延迟必须落在配置区间: ' + total);
    assert.ok(t.reactionMs >= 0 && t.hesitationMs >= 0, '两段均不应为负');
  }
});

test('planSendTiming: 上一条回复越长，R（反应）占比越高', () => {
  state.sendDelayMin = 6000;
  state.sendDelayMax = 6000; // 固定总时长，只观察 R/S 比例
  const shortReply = chat.planSendTiming('x', 10);
  const longReply = chat.planSendTiming('x', 5000);
  const shortRatio = shortReply.reactionMs / 6000;
  const longRatio = longReply.reactionMs / 6000;
  assert.ok(longRatio > shortRatio, '长回复应有更长反应停顿: ' + longRatio + ' vs ' + shortRatio);
  assert.ok(shortRatio >= 0.29 && shortRatio <= 0.56, 'R 占比下限约 0.3');
  assert.ok(longRatio >= 0.29 && longRatio <= 0.56, 'R 占比上限约 0.55');
});

test('randomDelay 短文本钳制到 min 时仍有抖动（不做固定节拍）', () => {
  state.sendDelayMin = 6000;
  state.sendDelayMax = 36000;
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(chat.randomDelay('ok'));
  assert.ok(seen.size > 5, '短文本延迟不应恒等于 min（固定节拍指纹）: 不同取值数=' + seen.size);
  for (const d of seen) assert.ok(d >= 6000 && d <= 36000, '抖动后仍须在配置区间: ' + d);
});

test('randomDelay min >= max 时返回 min', () => {
  state.sendDelayMin = 3000;
  state.sendDelayMax = 1000;
  assert.strictEqual(chat.randomDelay(), 3000);
});

test('randomDelay min === max 时返回 min', () => {
  state.sendDelayMin = 500;
  state.sendDelayMax = 500;
  assert.strictEqual(chat.randomDelay(), 500);
});

test('isInputVisible 隐藏元素返回 false', () => {
  assert.strictEqual(chat.isInputVisible({ __style: { display: 'none', visibility: 'visible', opacity: '1' } }), false);
  assert.strictEqual(chat.isInputVisible({ __style: { display: 'block', visibility: 'hidden', opacity: '1' } }), false);
  assert.strictEqual(chat.isInputVisible({ __style: { display: 'block', visibility: 'visible', opacity: '0' } }), false);
});

test('isInputVisible 可见元素返回 true', () => {
  assert.strictEqual(chat.isInputVisible({ __style: { display: 'block', visibility: 'visible', opacity: '1' } }), true);
});

test('isInputVisible null 返回 false', () => {
  assert.strictEqual(chat.isInputVisible(null), false);
});

test('findInputArea 找不到任何输入框返回 null', () => {
  assert.strictEqual(chat.findInputArea(), null);
});

test('findInputArea 兜底返回第一个可见 textarea', () => {
  const ta = { __style: { display: 'block', visibility: 'visible', opacity: '1' } };
  document.querySelectorAll = () => [ta];
  assert.strictEqual(chat.findInputArea(), ta);
});


// ===== applyResultTransform（provider 工具结果格式转换）=====

test('applyResultTransform: provider 未实现时保持原文', () => {
  assert.strictEqual(chat.applyResultTransform('原文', null), '原文');
  assert.strictEqual(chat.applyResultTransform('原文', {}), '原文');
  assert.strictEqual(chat.applyResultTransform('原文', { transformToolResult: 'not-fn' }), '原文');
});

test('applyResultTransform: provider 转换生效', () => {
  const p = { transformToolResult: (t) => t.replace('✅', '') };
  assert.strictEqual(chat.applyResultTransform('✅ 成功', p), ' 成功');
});

test('applyResultTransform: 转换函数抛错时回退原文', () => {
  const p = { transformToolResult: () => { throw new Error('boom'); } };
  assert.strictEqual(chat.applyResultTransform('原文', p), '原文');
});

test('applyResultTransform: 返回空串时保持原文（失败路径）', () => {
  assert.strictEqual(chat.applyResultTransform('原文', { transformToolResult: () => '' }), '原文');
  assert.strictEqual(chat.applyResultTransform('原文', { transformToolResult: () => null }), '原文');
  assert.strictEqual(chat.applyResultTransform('原文', { transformToolResult: () => 123 }), '原文');
});

test('triggerSend: 优先调用 electronAPI.sendEnterToChat 原生按键', async () => {
  let enterCalled = false;
  globalThis.window.electronAPI = {
    sendEnterToChat: async () => {
      enterCalled = true;
      return true;
    },
  };
  const mockInput = { focus() {} };
  await chat.triggerSend(mockInput);
  assert.strictEqual(enterCalled, true, '应优先调用原生 Enter 发送');
});

test('sendInitialPromptToInput: 系统提示词必须立即发送（不排随机延迟）', async () => {
  vi.useFakeTimers();
  const { sent } = composer();
  state.sendDelayMin = state.sendDelayMax = 30000;
  state.initialPromptContent = '系统提示词'.repeat(2000);
  state.pendingInitialPrompt = true;
  const result = chat.sendInitialPromptToInput();
  await vi.advanceTimersByTimeAsync(1);
  assert.strictEqual(await result, true);
  assert.deepStrictEqual(sent, [state.initialPromptContent]);
  assert.strictEqual(state.pendingInitialPrompt, false);
});

test('insertSnippet: autoSend 是用户手动触发，0ms 立即发送（不排延迟）', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let scheduledDelay = 0;
  let sendTriggered = false;
  globalThis.setTimeout = ((fn, delay) => {
    scheduledDelay = delay;
    return 1;
  });
  try {
    Object.defineProperty(globalThis.window.HTMLTextAreaElement.prototype, 'value', {
      set(v) { this._val = v; },
      configurable: true,
    });
    const input = {
      tagName: 'TEXTAREA',
      value: '',
      focus() {},
      setSelectionRange() {},
      getAttribute: () => null,
      dispatchEvent: () => { sendTriggered = true; return true; },
      __style: { display: 'block', visibility: 'visible', opacity: '1' },
    };
    globalThis.document.querySelector = () => input;
    globalThis.document.querySelectorAll = () => [input];

    const ok = await chat.insertSnippet('请继续编写代码并运行测试', true);
    assert.strictEqual(ok, true, 'insertSnippet 应执行成功');
    assert.strictEqual(scheduledDelay, 0, '手动触发不应排延迟（真人操作本身是人类证据）');
    // 等待 triggerSend 的微任务链完成后再断言发送已发生
    await new Promise((r) => origSetTimeout(r, 0));
    assert.strictEqual(sendTriggered, true, '应立即触发发送');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('isHarnessInput 不会误杀 placeholder 包含"输入消息"的真实站点输入框', () => {
  const deepseekInput = {
    tagName: 'TEXTAREA',
    id: 'chat-input',
    placeholder: '输入消息，Enter发送，Shift+Enter换行',
    hasAttribute: () => false,
  };
  assert.strictEqual(chat.isHarnessInput(deepseekInput), false, 'DeepSeek 真实输入框绝不能被判定为 harness 输入框');

  const harnessInput = {
    tagName: 'TEXTAREA',
    id: 'input',
    hasAttribute: (name) => name === 'data-cuckoo-harness',
  };
  assert.strictEqual(chat.isHarnessInput(harnessInput), true, '带 data-cuckoo-harness 的输入框应识别为 harness 输入框');
});

test('waitForInputArea 在输入框延迟出现时能有界轮询获取', async () => {
  const token = { cancelled: false };
  let calls = 0;
  const target = {
    tagName: 'TEXTAREA',
    __style: { display: 'block', visibility: 'visible', opacity: '1' },
  };
  globalThis.document.querySelectorAll = () => {
    calls++;
    return calls >= 3 ? [target] : [];
  };
  const res = await chat.waitForInputArea(token, 1000);
  assert.strictEqual(res, target, '应在轮询命中后返回输入框');
  assert.ok(calls >= 3, '应经历重试轮询');
});

test('sendCombinedJsResultsToChat 在重试时走快速通道并不重复拼接旧工具回传', async () => {
  vi.useFakeTimers();
  const { input, sent } = composer();
  state.sendDelayMin = state.sendDelayMax = 10000;
  state.pauseEnabled = false;

  // 模拟输入框残留上一轮的工具结果
  input.value = '执行结果：\n\n成功\n旧回传内容\n\n';

  const results = [{ code: 'log(1)', result: { success: true, output: '新结果' } }];
  // 传入 isRetry = true
  const sendPromise = chat.sendCombinedJsResultsToChat(results, undefined, 0, true);

  // isRetry 走 300ms 快速重发通道，不等待 10000ms 常规延迟
  await vi.advanceTimersByTimeAsync(350);
  await vi.advanceTimersByTimeAsync(100);

  assert.strictEqual(sent.length, 1, '应快速触发发送');
  assert.ok(!sent[0].includes('旧回传内容'), '重试时严禁把输入框旧工具回传作为用户输入重复拼接');
  assert.ok(sent[0].includes('新结果'), '应包含本次新执行结果');
});

