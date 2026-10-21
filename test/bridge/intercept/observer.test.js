'use strict';
import { test, afterEach } from 'vitest';
import assert from 'node:assert';
import {
  startInterceptObserver,
  processInterceptedResponse,
  getLastInterceptedText,
  onInterceptedResponse,
  onAiError,
  onTaskIdle,
  stripToolBlocks,
} from '../../../src/bridge/intercept/observer.js';

// 收集注册的监听器，测试后统一取消，避免模块级 Set 跨用例泄漏
const offs = [];
function track(off) { offs.push(off); return off; }
afterEach(() => {
  while (offs.length) offs.pop()();
});

// ---- 测试用 window / document 模拟（外部边界，不是 mock 内部模块）----
function makeFakeWindow() {
  const listeners = {};
  const win = {
    location: { href: '' },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    electronAPI: { showAiNotification: () => Promise.resolve() },
  };
  return { win, listeners };
}

function dispatch(listeners, type, detail) {
  const fns = listeners[type] || [];
  for (const fn of fns) fn({ detail });
}

function setupGlobals(idMap) {
  const { win, listeners } = makeFakeWindow();
  globalThis.window = win;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.document = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: (id) => (idMap && idMap[id]) || null,
    createElement: () => ({
      id: '', className: '', textContent: '', style: {},
      classList: { add() {}, remove() {} },
    }),
    body: { appendChild() {} },
  };
  return listeners;
}

// 极简假元素：只保留遮罩用到的 classList 语义
function makeFakeMask() {
  const classes = new Set(['cuckoo-hidden']);
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

test('onInterceptedResponse 返回可取消函数', () => {
  const got = [];
  const off = track(onInterceptedResponse((t) => got.push(t)));
  assert.strictEqual(typeof off, 'function');
  off();
  offs.pop(); // 已手动取消，避免重复
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：stopped 不通知监听器', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t) => got.push(t)));
  dispatch(listeners, 'cuckoo-ai-response', { status: 'stopped', finished: true, text: 'x' });
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：未 finished 不通知', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t) => got.push(t)));
  dispatch(listeners, 'cuckoo-ai-response', { status: 'streaming', finished: false, text: 'partial' });
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：finished 通知监听器并携带 meta', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t, meta) => got.push({ t, meta })));
  dispatch(listeners, 'cuckoo-ai-response', {
    status: 'finished',
    finished: true,
    text: '这是普通文本回复',
    tokenUsage: { input: 1 },
    msgIds: ['m1'],
  });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].t, '这是普通文本回复');
  assert.deepStrictEqual(got[0].meta.tokenUsage, { input: 1 });
  assert.deepStrictEqual(got[0].meta.msgIds, ['m1']);
});

test('startInterceptObserver：无 detail 安全返回', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t) => got.push(t)));
  dispatch(listeners, 'cuckoo-ai-response', null);
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：error 事件通知 onAiError', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onAiError((d) => got.push(d)));
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500, text: 'err' });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].httpStatus, 500);
});

test('startInterceptObserver：error 事件无 detail 传空对象', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onAiError((d) => got.push(d)));
  dispatch(listeners, 'cuckoo-ai-error', null);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0], {});
});

test('onAiError 取消后不再触发', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  const off = track(onAiError((d) => got.push(d)));
  off();
  offs.pop();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  assert.deepStrictEqual(got, []);
});

test('getLastInterceptedText：初始为空串', () => {
  assert.strictEqual(typeof getLastInterceptedText(), 'string');
});

test('getLastInterceptedText：finished 后缓存文本', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-response', { status: 'finished', finished: true, text: '缓存内容' });
  assert.strictEqual(getLastInterceptedText(), '缓存内容');
});

test('processInterceptedResponse：空文本直接返回', async () => {
  setupGlobals();
  await processInterceptedResponse('');
  await processInterceptedResponse('   ');
});

test('processInterceptedResponse：普通文本不抛错', async () => {
  setupGlobals();
  await processInterceptedResponse('一段没有工具调用的普通说明文字');
});

test('processInterceptedResponse：JSON 格式工具调用发提示', async () => {
  setupGlobals();
  await processInterceptedResponse('{"tool": "bash", "arguments": {"command": "echo hi"}}');
});

test('processInterceptedResponse：XML 格式工具调用发提示', async () => {
  setupGlobals();
  await processInterceptedResponse('<invoke name="bash"></invoke>');
});

test('processInterceptedResponse：JS 工具块执行期间显示遮罩，发送结束后隐藏', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  let visibleDuringExec = false;
  globalThis.window.electronAPI.executeJs = async () => {
    visibleDuringExec = !mask.classList.contains('cuckoo-hidden');
    return { success: true, output: 'ok' };
  };
  await processInterceptedResponse('\`\`\`cuckoo\nawait read({ filePath: "a.txt" });\n\`\`\`');
  assert.strictEqual(visibleDuringExec, true, '执行期间遮罩应可见');
  assert.ok(mask.classList.contains('cuckoo-hidden'), '结束后遮罩应隐藏');
});

test('processInterceptedResponse：执行阶段点停止 → 丢弃结果不回传', async () => {
  const mask = makeFakeMask();
  const fakeBtn = {
    className: '',
    classList: {
      _s: new Set(['cuckoo-hidden']),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
    onclick: null,
  };
  setupGlobals({ 'cuckoo-tool-mask': mask, 'cuckoo-tool-mask-cancel': fakeBtn });
  // 执行期间，按钮应可见（不被 cuckoo-hidden）
  let btnVisibleDuringExec = false;
  let sentAfterCancel = 0;
  globalThis.window.electronAPI.executeJs = async () => {
    btnVisibleDuringExec = !fakeBtn.classList.contains('cuckoo-hidden');
    // 模拟"用户在执行阶段点了停止"
    if (typeof fakeBtn.onclick === 'function') fakeBtn.onclick();
    return { success: true, output: 'ok' };
  };
  // 拦截发送：取消后不应调用
  // 拦截发送：取消后不应调用
  globalThis.window.electronAPI.sendEnterToChat = async () => { sentAfterCancel++; return true; };
  await processInterceptedResponse('```cuckoo\nawait write({ filePath: "stop-test-unique.txt", content: "x" });\n```');
  assert.strictEqual(btnVisibleDuringExec, true, '执行期间停止按钮应可见');
  assert.ok(mask.classList.contains('cuckoo-hidden'), '取消后遮罩应隐藏');
  assert.strictEqual(sentAfterCancel, 0, '点停止后应丢弃结果，不得再回传/发送到聊天框');
});

test('processInterceptedResponse：非工具回复不显示遮罩', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  await processInterceptedResponse('一段没有工具调用的普通说明文字');
  assert.ok(mask.classList.contains('cuckoo-hidden'), '普通回复不应显示遮罩');
});

test('processInterceptedResponse：force 跳过去重重复执行', async () => {
  setupGlobals();
  const text = '重复的普通文本回复';
  await processInterceptedResponse(text);
  // 第二次 force=true 应仍能执行而不抛错
  await processInterceptedResponse(text, true);
});

// ========== onTaskIdle（任务空闲信号，供自动压缩用）==========

test('onTaskIdle 返回可取消函数', () => {
  const off = track(onTaskIdle(() => {}));
  assert.strictEqual(typeof off, 'function');
  off();
  offs.pop();
});

test('processInterceptedResponse：普通文本回复触发 onTaskIdle（工具循环结束）', async () => {
  setupGlobals();
  let idle = 0;
  track(onTaskIdle(() => idle++));
  await processInterceptedResponse('一段没有工具调用的普通说明文字');
  assert.strictEqual(idle, 1, '普通文本回复应派发一次任务空闲');
});

test('processInterceptedResponse：工具代码块不触发 onTaskIdle（工具循环未结束）', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  globalThis.window.electronAPI.executeJs = async () => ({ success: true, output: 'ok' });
  let idle = 0;
  track(onTaskIdle(() => idle++));
  await processInterceptedResponse('\`\`\`cuckoo\nawait read({ filePath: "a.txt" });\n\`\`\`');
  assert.strictEqual(idle, 0, '有工具调用时不应派发任务空闲');
});

test('onTaskIdle 取消后不再触发', async () => {
  setupGlobals();
  let idle = 0;
  const off = track(onTaskIdle(() => idle++));
  off();
  offs.pop();
  await processInterceptedResponse('取消后的普通文本回复');
  assert.strictEqual(idle, 0);
});

test('onTaskIdle：空文本不触发', async () => {
  setupGlobals();
  let idle = 0;
  track(onTaskIdle(() => idle++));
  await processInterceptedResponse('');
  assert.strictEqual(idle, 0);
});

// ===== B-006：finished 稳定文本的语法错误不再空跑重试 =====

test('B-006: cuckoo 块抛语法错误时只执行一次（不重跑 3 次）', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  let calls = 0;
  globalThis.window.electronAPI.executeJs = async () => {
    calls++;
    return { success: false, error: 'SyntaxError: Unexpected end of input' };
  };
  // 拦截发送，避免真实投递
  globalThis.window.electronAPI.sendEnterToChat = async () => true;
  // 已闭合的 cuckoo 块，但 JS 本身有语法错误（括号未闭合）——隔离 B-006 行为
  const text = '```cuckoo\nawait write({ filePath: "x", content: "half"\n```';
  await processInterceptedResponse(text, true);
  // 历史实现会重跑 4 次（1+3）；修复后只跑 1 次
  assert.strictEqual(calls, 1, '语法错误不应重跑，executeJs 调用次数=' + calls);
});

// ========== stripToolBlocks：格式检测前置剥离（防 cuckoo 块内示例误报）==========

test('stripToolBlocks 剥离 cuckoo 块，保留块外文字', () => {
  const BT3 = String.fromCharCode(96, 96, 96);
  const input = ['说明文字', BT3 + 'cuckoo', '{"tool":"read"}', BT3, '后续'].join('\n');
  const out = stripToolBlocks(input);
  assert.ok(!out.includes('{"tool"'), '块内 JSON 应被剥离');
  assert.ok(out.includes('说明文字'), '块外文字应保留');
  assert.ok(out.includes('后续'), '块外后续文字应保留');
});

test('stripToolBlocks 剥离 js / javascript 块', () => {
  const BT3 = String.fromCharCode(96, 96, 96);
  assert.ok(!stripToolBlocks([BT3 + 'js', '{"tool":"x"}', BT3].join('\n')).includes('tool'));
  assert.ok(!stripToolBlocks([BT3 + 'javascript', '<invoke>', BT3].join('\n')).includes('invoke'));
});

test('stripToolBlocks 不剥离 json / python 等其他块（真错误不放过）', () => {
  const BT3 = String.fromCharCode(96, 96, 96);
  const input = [BT3 + 'json', '{"tool":"read"}', BT3].join('\n');
  assert.ok(stripToolBlocks(input).includes('{"tool"'), 'json 块不应被剥离');
});

test('stripToolBlocks 未闭合的 cuckoo 块也剥离（流式截断场景）', () => {
  const BT3 = String.fromCharCode(96, 96, 96);
  const input = ['说明', BT3 + 'cuckoo', '{"tool":"read"}'].join('\n');
  const out = stripToolBlocks(input);
  assert.ok(!out.includes('{"tool"'), '未闭合块的内部也应剥离');
});

test('stripToolBlocks 无围栏时原样返回（快速路径不破坏原文）', () => {
  const input = '{"tool":"read"}';
  assert.strictEqual(stripToolBlocks(input), input);
});
