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
  stripInlineCodeAndQuotes,
} from '../../../src/bridge/intercept/observer.js';
import { state } from '../../../src/overlay/state.js';

// 收集注册的监听器，测试后统一取消，避免模块级 Set 跨用例泄漏
const offs = [];
function track(off) { offs.push(off); return off; }
afterEach(() => {
  while (offs.length) offs.pop()();
  // 恢复发送延迟，避免个别用例改 0 后污染后续
  state.sendDelayMin = 500;
  state.sendDelayMax = 1000;
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
  // node 环境无 KeyboardEvent；triggerSend 的 fallback 分支会 new 它
  if (typeof globalThis.KeyboardEvent === 'undefined') {
    globalThis.KeyboardEvent = class KeyboardEvent {
      constructor(type) { this.type = type; }
    };
  }
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

test('processInterceptedResponse：DSML 格式识别（含竖线后空格）', async () => {
  setupGlobals();
  // 旧行为：<|DSML|invoke> 竖线后无空格
  await processInterceptedResponse('<|DSML|invoke name="test">');
  // 新增能力：<|DSML| invoke> 竖线后带空格
  await processInterceptedResponse('<|DSML| invoke name="test">');
});

test('processInterceptedResponse：纠正提示不回显原始标签（防二次污染）', async () => {
  // 发送延迟归零：避免串行链挂起污染后续用例
  state.sendDelayMin = 0;
  state.sendDelayMax = 0;
  // 自定义 globals：提供可填充的 textarea，捕获填入内容
  let captured = '';
  class FakeTextarea {}
  Object.defineProperty(FakeTextarea.prototype, 'value', {
    set(v) { captured = v; },
    get() { return captured; },
    configurable: true,
  });
  const fakeTextarea = Object.assign(new FakeTextarea(), {
    tagName: 'TEXTAREA',
    focus: () => {},
    dispatchEvent: () => {},
    getAttribute: () => null,
  });
  globalThis.window = {
    location: { href: '' },
    addEventListener: () => {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    HTMLTextAreaElement: FakeTextarea,
    HTMLInputElement: FakeTextarea,
    electronAPI: {
      showAiNotification: () => Promise.resolve(),
      sendEnterToChat: async () => true,
    },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.document = {
    querySelectorAll: (sel) => sel === 'textarea' ? [fakeTextarea] : [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ id: '', className: '', textContent: '', style: {}, classList: { add() {}, remove() {} } }),
    body: { appendChild: () => {} },
  };

  await processInterceptedResponse('<|DSML|invoke name="foo">');
  await new Promise(r => setTimeout(r, 80));

  assert.ok(captured.length > 0, '应捕获到填入输入框的提示文本');
  assert.ok(captured.includes('错误格式的工具调用'), '提示应包含纠正说明');
  assert.ok(!captured.includes('<|DSML|'), '提示不得回显 <|DSML| 标签');
  assert.ok(!captured.includes('|DSML|'), '提示不得回显 DSML 标记');
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

// ========== stripInlineCodeAndQuotes：正文引用不误判 ==========

test('stripInlineCodeAndQuotes 剥离行内代码', () => {
  const input = '旧提示会回显 `<invoke name="x">` 标签';
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(!out.includes('invoke'), '行内代码内的标签应被剥离');
  assert.ok(out.includes('旧提示会回显'), '行内代码外的文字应保留');
});

test('stripInlineCodeAndQuotes 剥离引用块整行', () => {
  const input = ['正常说明', '> <invoke name="x">', '后续说明'].join('\n');
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(!out.includes('invoke'), '引用块内的标签应被剥离');
  assert.ok(out.includes('正常说明'), '引用块外的文字应保留');
});

test('stripInlineCodeAndQuotes 不剥离正文中的裸标签（真错误不放过）', () => {
  const input = '<invoke name="bash"></invoke>';
  assert.ok(stripInlineCodeAndQuotes(input).includes('invoke'), '裸标签不应被剥离');
});

test('processInterceptedResponse：正文行内引用标签不触发纠错', async () => {
  // 捕获发送内容
  let sent = 0;
  globalThis.window = {
    location: { href: '' },
    addEventListener: () => {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    electronAPI: {
      showAiNotification: () => Promise.resolve(),
      sendEnterToChat: async () => true,
    },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const ta = {
    tagName: 'TEXTAREA', focus: () => {}, dispatchEvent: () => {}, getAttribute: () => null,
    _v: '',
    get value() { return this._v; },
    set value(v) { this._v = v; if (v) sent++; },
  };
  globalThis.document = {
    querySelectorAll: (sel) => sel === 'textarea' ? [ta] : [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ id: '', className: '', textContent: '', style: {}, classList: { add() {}, remove() {} } }),
    body: { appendChild: () => {} },
  };
  state.sendDelayMin = 0;
  state.sendDelayMax = 0;

  await processInterceptedResponse('这段说明里提到 `<invoke name="x">` 这个写法，但它只是引用', true);
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(sent, 0, '正文行内引用不应触发纠错发送');
});
const INV = "<invoke name=\"zzz\"></invoke>";



// ========== 088：中文标点举例 / 伪代码不误报 ==========

test('stripInlineCodeAndQuotes 剥离中文引号包裹内容', () => {
  const input = '这个对象形如「{tool: "bash", args: []}」时要注意';
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(!out.includes('tool'), '中文引号内内容应被剥离');
  assert.ok(out.includes('这个对象形如'), '引号外文字应保留');
});

test('stripInlineCodeAndQuotes 剥离中文括号包裹内容', () => {
  const input = '举例说明（' + INV + '）结束';
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(!out.includes('invoke'), '中文括号内内容应被剥离');
  assert.ok(out.includes('举例说明'), '括号外文字应保留');
});

test('stripInlineCodeAndQuotes 剥离 Markdown 表格行', () => {
  const input = ['正常说明', '| 格式 | ' + INV + ' |', '后续说明'].join('\n');
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(!out.includes('invoke'), '表格行内的标签应被剥离');
  assert.ok(out.includes('正常说明'), '表格外文字应保留');
});

test('looksLikeJsonToolCall：伪代码无合法值时不命中', async () => {
  const { looksLikeJsonToolCall } = await import('../../../src/bridge/parser/json-detector.js');
  assert.strictEqual(looksLikeJsonToolCall('{tool: ...}'), false, '省略号不是合法 JSON 值');
  assert.strictEqual(looksLikeJsonToolCall('{tool: 伪代码}'), false, '中文不是合法 JSON 值');
});

test('looksLikeJsonToolCall：真实 JSON 工具调用仍命中', async () => {
  const { looksLikeJsonToolCall } = await import('../../../src/bridge/parser/json-detector.js');
  assert.strictEqual(looksLikeJsonToolCall('{"tool": "bash", "args": {}}'), true);
  assert.strictEqual(looksLikeJsonToolCall("{'toolName': 'read'}"), true);
  assert.strictEqual(looksLikeJsonToolCall('{"tool": [1,2]}'), true);
});

test('processInterceptedResponse：中文引号内伪代码不触发 JSON 纠错', async () => {
  let sent = 0;
  globalThis.window = {
    location: { href: '' },
    addEventListener: () => {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    electronAPI: { showAiNotification: () => Promise.resolve(), sendEnterToChat: async () => true },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const ta = {
    tagName: 'TEXTAREA', focus: () => {}, dispatchEvent: () => {}, getAttribute: () => null,
    _v: '', get value() { return this._v; }, set value(v) { this._v = v; if (v) sent++; },
  };
  globalThis.document = {
    querySelectorAll: (sel) => sel === 'textarea' ? [ta] : [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ id: '', className: '', textContent: '', style: {}, classList: { add() {}, remove() {} } }),
    body: { appendChild: () => {} },
  };
  state.sendDelayMin = 0;
  state.sendDelayMax = 0;

  await processInterceptedResponse('正文举例：「这个对象形如 {tool: "bash"}」而已', true);
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(sent, 0, '中文引号内伪代码不应触发纠错');
});

test('XML 纠错提示不回显标签属性串（intent）', async () => {
  let captured = '';
  class FakeTextarea {}
  Object.defineProperty(FakeTextarea.prototype, 'value', {
    set(v) { this._v = v; if (v) captured = v; },
    get() { return this._v; },
    configurable: true,
  });
  const ta = Object.assign(new FakeTextarea(), {
    tagName: 'TEXTAREA', focus: () => {}, dispatchEvent: () => {}, getAttribute: () => null,
  });
  globalThis.window = {
    location: { href: '' },
    addEventListener: () => {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    HTMLTextAreaElement: FakeTextarea,
    HTMLInputElement: FakeTextarea,
    electronAPI: { showAiNotification: () => Promise.resolve(), sendEnterToChat: async () => true },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.document = {
    querySelectorAll: (sel) => sel === 'textarea' ? [ta] : [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ id: '', className: '', textContent: '', style: {}, classList: { add() {}, remove() {} } }),
    body: { appendChild: () => {} },
  };
  state.sendDelayMin = 0;
  state.sendDelayMax = 0;

  await processInterceptedResponse(INV, true);
  await new Promise(r => setTimeout(r, 120));
  assert.ok(captured.length > 0, '应发送纠错提示');
  assert.ok(!captured.includes('zzz'), '提示不得回显属性串 name="zzz"');
  assert.ok(!captured.includes('你原本想执行'), '提示不得包含「你原本想执行」前缀');
});

const INV2 = "<invoke name=\"y\">";

test('中文标点剥离不跨行：多行裸标签仍被检出（真错误不放过）', () => {
  // 中文引号只剥单行内容，未闭合的多行标签不应被吞掉
  const input = '举例「未闭合的引号开始\n' + INV2 + '\n然后继续';
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(out.includes('invoke'), '跨行的裸标签应保留，确保真错误仍能检出');
});

test('中文标点剥离不吞噬相邻裸标签', () => {
  const input = '「这是引用」' + INV2;
  const out = stripInlineCodeAndQuotes(input);
  assert.ok(!out.includes('这是引用'), '引号内应被剥离');
  assert.ok(out.includes('invoke'), '引号外的裸标签应保留');
});
