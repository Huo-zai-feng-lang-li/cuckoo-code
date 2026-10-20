'use strict';
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

// 拦截 chat-input：直接观测 sendToChat 是否被调用（B-001 回归）
const sendToChatMock = vi.fn(() => Promise.resolve(true));
vi.mock('../../../src/overlay/chat-input.js', () => ({
  sendToChat: (...a) => sendToChatMock(...a),
  sendCombinedJsResultsToChat: async () => true,
  sendMessageToChat: async () => true,
  cancelPendingSend: () => {},
  onMessageDelivered: () => () => {},
  findInputArea: () => null,
  getInputText: () => '',
}));
// panel/通知等打空，避免 DOM 副作用
vi.mock('../../../src/overlay/panel.js', () => ({
  showToast: () => {},
}));

let retry;
let observer;

function setupGlobals() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  const listeners = {};
  globalThis.window = {
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc123' },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent: () => true,
    electronAPI: { showAiNotification: () => Promise.resolve() },
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      classList: { add() {}, remove() {}, toggle() {} },
      style: {},
      appendChild() {},
      querySelector: () => ({ onclick: null, textContent: '' }),
      set innerHTML(v) {},
      get innerHTML() { return ''; },
    }),
    body: { appendChild() {} },
  };
  return { store, listeners };
}

function dispatch(listeners, type, detail) {
  const fns = listeners[type] || [];
  for (const fn of fns) fn({ detail });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  sendToChatMock.mockClear();
  globalThis.__obs = null;
});

afterEach(() => {
  vi.useRealTimers();
});

async function boot() {
  const { listeners } = setupGlobals();
  retry = await import('../../../src/bridge/loop/retry.js');
  observer = await import('../../../src/bridge/intercept/observer.js');
  return listeners;
}

test('readConfig 返回默认值', async () => {
  await boot();
  const cfg = retry.readConfig();
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.delayMin, 4000);
  assert.strictEqual(cfg.delayMax, 10000);
  assert.strictEqual(cfg.count, 10);
  assert.strictEqual(cfg.delay429, 120000);
  assert.strictEqual(cfg.count429, 40);
  assert.ok(cfg.prompt);
});

test('readConfig 从 localStorage 覆盖', async () => {
  await boot();
  localStorage.setItem('cuckoo-retry-enabled', '0');
  localStorage.setItem('cuckoo-retry-delay-min', '500');
  localStorage.setItem('cuckoo-retry-delay-max', '800');
  localStorage.setItem('cuckoo-retry-count', '3');
  localStorage.setItem('cuckoo-retry-429-delay', '1234');
  localStorage.setItem('cuckoo-retry-429-count', '5');
  localStorage.setItem('cuckoo-retry-prompt', '自定义');
  const cfg = retry.readConfig();
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.delayMin, 500);
  assert.strictEqual(cfg.delayMax, 800);
  assert.strictEqual(cfg.count, 3);
  assert.strictEqual(cfg.delay429, 1234);
  assert.strictEqual(cfg.count429, 5);
  assert.strictEqual(cfg.prompt, '自定义');
});

test('DEFAULT_PROMPT 存在', async () => {
  await boot();
  assert.ok(typeof retry.DEFAULT_PROMPT === 'string' && retry.DEFAULT_PROMPT.length > 0);
});

test('enabled=0 时错误不触发重试', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-enabled', '0');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  // 无计时器被创建 → 推进时间无副作用
  vi.advanceTimersByTime(200000);
});

test('启用时错误触发重试（普通失败）', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-enabled', '1');
  localStorage.setItem('cuckoo-retry-delay-min', '1000');
  localStorage.setItem('cuckoo-retry-delay-max', '1000');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  // 无异常即通过；推进到重试延迟后触发 sendToChat
  vi.advanceTimersByTime(1001);
});

test('compacting 期间错误被忽略', async () => {
  const listeners = await boot();
  retry.setCompacting(true);
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  vi.advanceTimersByTime(200000);
  retry.setCompacting(false);
});

test('会话不匹配的错误被忽略', async () => {
  const listeners = await boot();
  retry.startRetryEngine();
  observer.startInterceptObserver();
  // 当前会话 abc123，错误来自 old-session
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500, sessionId: 'old-session' });
  vi.advanceTimersByTime(200000);
  // 无异常即通过
});

test('成功回复重置计数', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-delay-min', '1000');
  localStorage.setItem('cuckoo-retry-delay-max', '1000');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  dispatch(listeners, 'cuckoo-ai-response', { status: 'finished', finished: true, text: 'ok' });
  vi.advanceTimersByTime(200000);
});

test('普通失败达上限后停止重试', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-count', '1');
  localStorage.setItem('cuckoo-retry-delay-min', '500');
  localStorage.setItem('cuckoo-retry-delay-max', '500');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 }); // 第 1 次
  vi.advanceTimersByTime(501);
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 }); // 达上限，不再重试
  vi.advanceTimersByTime(200000);
});

test('429 使用独立计数与延迟', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-429-count', '1');
  localStorage.setItem('cuckoo-retry-429-delay', '500');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 429 }); // 第 1 次
  vi.advanceTimersByTime(501);
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 429 }); // 达上限
  vi.advanceTimersByTime(200000);
});

test('startRetryEngine 幂等', async () => {
  await boot();
  retry.startRetryEngine();
  retry.startRetryEngine();
  // 无异常即通过
});

// ===== B-001：倒计时期间切会话 → 发送前复核，不污染新会话 =====

test('B-001: 倒计时期间切到别的会话 → 取消发送', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-enabled', '1');
  localStorage.setItem('cuckoo-retry-delay-min', '1000');
  localStorage.setItem('cuckoo-retry-delay-max', '1000');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  // 倒计时进行中：SPA 无刷新切到另一个会话（hex 会话 id，与 abc123 不同）
  globalThis.window.location.href = 'https://chat.deepseek.com/a/chat/s/def456';
  vi.advanceTimersByTime(1001);
  assert.strictEqual(sendToChatMock.mock.calls.length, 0, '切会话后不应发送重试提示词');
});

test('B-001: 不切会话 → 正常发送（对照）', async () => {
  const listeners = await boot();
  localStorage.setItem('cuckoo-retry-enabled', '1');
  localStorage.setItem('cuckoo-retry-delay-min', '1000');
  localStorage.setItem('cuckoo-retry-delay-max', '1000');
  retry.startRetryEngine();
  observer.startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  vi.advanceTimersByTime(1001);
  assert.strictEqual(sendToChatMock.mock.calls.length, 1, '同会话应发送重试提示词');
});
