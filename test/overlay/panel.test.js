'use strict';
import { test } from 'vitest';
import assert from 'node:assert';

// 只测纯函数：generateId、formatTime、truncate
// escapeHtml 等需要 DOM 的函数单独 mock

// 用简单 DOM stub
const mkEl = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } });
global.document = {
  createElement: () => mkEl(),
  getElementById: () => null,
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
};
global.requestAnimationFrame = (fn) => fn();
global.window = { location: { href: 'https://chat.deepseek.com/' } };
global.setInterval = () => 0;
global.clearInterval = () => {};
global.setTimeout = (_fn, _ms) => 0;
global.clearTimeout = () => {};

const ui = await import('../../src/overlay/panel.js');
const { state } = await import('../../src/overlay/state.js');

test('generateId 格式', () => {
  const id1 = ui.generateId();
  const id2 = ui.generateId();
  assert.match(id1, /^cmd_\d+_\d+$/);
  assert.notStrictEqual(id1, id2);
});

test('formatTime 格式 HH:mm:ss', () => {
  const s = ui.formatTime(new Date(2026, 0, 1, 9, 5, 3).getTime());
  assert.strictEqual(s, '09:05:03');
});

test('truncate 基本与默认长度', () => {
  assert.strictEqual(ui.truncate('hello'), 'hello');
  assert.strictEqual(ui.truncate('abcdefghij', 5), 'abcde...');
  assert.strictEqual(ui.truncate(''), '');
  assert.strictEqual(ui.truncate(null), '');
  const long = 'x'.repeat(60);
  assert.strictEqual(ui.truncate(long).length, 53);
});

test('escapeHtml 返回字符串', () => {
  assert.strictEqual(typeof ui.escapeHtml('<script>'), 'string');
});

test('updateHomeMode 首页模式', () => {
  assert.doesNotThrow(() => ui.updateHomeMode());
});

// 回归：曾因 updateHomeMode 依赖已被删除的 #cuckoo-overlay 元素，
// 导致 if(overlay) 整块跳过 → 首次初始化提示框永不显示。
function makeFakeDialog() {
  const classes = new Set(['cuckoo-hidden']);
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _has: (c) => classes.has(c),
  };
}

test('updateHomeMode：首页显示初始化提示框（回归）', () => {
  const dialog = makeFakeDialog();
  const prevGet = global.document.getElementById;
  const prevHref = global.window.location.href;
  global.document.getElementById = (id) => (id === 'cuckoo-first-time-dialog' ? dialog : null);
  global.window.location.href = 'https://chat.deepseek.com/';
  try {
    ui.updateHomeMode();
    assert.strictEqual(dialog._has('cuckoo-hidden'), false, '首页应移除 cuckoo-hidden（显示提示框）');
  } finally {
    global.document.getElementById = prevGet;
    global.window.location.href = prevHref;
  }
});

test('updateHomeMode：非首页隐藏初始化提示框', () => {
  const dialog = makeFakeDialog();
  const prevGet = global.document.getElementById;
  const prevHref = global.window.location.href;
  global.document.getElementById = (id) => (id === 'cuckoo-first-time-dialog' ? dialog : null);
  global.window.location.href = 'https://chat.deepseek.com/chat/s/abc';
  try {
    ui.updateHomeMode();
    assert.strictEqual(dialog._has('cuckoo-hidden'), true, '非首页应加回 cuckoo-hidden（隐藏提示框）');
  } finally {
    global.document.getElementById = prevGet;
    global.window.location.href = prevHref;
  }
});

test('updateHomeMode：已选项目时首页不显示提示框（由 state.currentProjectDir 控制）', () => {
  const dialog = makeFakeDialog();
  const prevGet = global.document.getElementById;
  const prevHref = global.window.location.href;
  global.document.getElementById = (id) => (id === 'cuckoo-first-time-dialog' ? dialog : null);
  global.window.location.href = 'https://chat.deepseek.com/';
  const prevDir = state.currentProjectDir;
  state.currentProjectDir = 'C:/proj';
  try {
    ui.updateHomeMode();
    assert.strictEqual(dialog._has('cuckoo-hidden'), true, '已选项目时应保持隐藏');
  } finally {
    state.currentProjectDir = prevDir;
    global.document.getElementById = prevGet;
    global.window.location.href = prevHref;
  }
});

test('showToast 不抛错', () => {
  assert.doesNotThrow(() => ui.showToast('test'));
});

test('setTaskStatus 不抛错', () => {
  assert.doesNotThrow(() => ui.setTaskStatus(true));
});

test('showOverlay/hideOverlay/forceShowOverlay 不抛错', () => {
  assert.doesNotThrow(() => ui.showOverlay());
  assert.doesNotThrow(() => ui.hideOverlay());
  assert.doesNotThrow(() => ui.forceShowOverlay());
});

test('displayCommand 更新预览', () => {
  assert.doesNotThrow(() => ui.displayCommand({ command: 'echo hi' }));
});

test('handleExecute/handleIgnore 不抛错', async () => {
  await ui.handleExecute();
  ui.handleIgnore();
});

test('addHistory 添加记录', () => {
  ui.commandHistory.length = 0;
  ui.addHistory({ id: '1', command: 'echo', success: true, canceled: false, output: 'x', timestamp: Date.now() });
  assert.strictEqual(ui.commandHistory.length, 1);
  assert.strictEqual(ui.commandHistory[0].id, '1');
});

test('renderHistory 空列表', () => {
  ui.commandHistory.length = 0;
  assert.doesNotThrow(() => ui.renderHistory());
});

test('flashBadge 不抛错', () => {
  assert.doesNotThrow(() => ui.flashBadge('test'));
});

test('startOverlayWatcher 不抛错', () => {
  assert.doesNotThrow(() => ui.startOverlayWatcher());
});

// ===== 遮罩阶段语义拆分（执行 → 发送）=====
// 本文件顶部把 setInterval/setTimeout 换成了立即返回的桩，这里临时恢复真实计时器，
// 才能验证"工具耗时定格、延迟单独计时"的行为。
function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
  };
}

async function withRealMaskDom(fn) {
  const timers = await import('node:timers');
  const prev = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    querySelector: global.document.querySelector,
    getElementById: global.document.getElementById,
    addEventListener: global.document.addEventListener,
    removeEventListener: global.document.removeEventListener,
  };
  global.setInterval = timers.setInterval;
  global.clearInterval = timers.clearInterval;
  global.setTimeout = timers.setTimeout;
  global.clearTimeout = timers.clearTimeout;

  // 实现用 innerHTML 渲染（数字包 <b> 做强调）；假元素用 setter 剥离标签同步到 textContent，
  // 既保留原有 textContent 断言，又能用 _html 断言强调标签确实存在。
  const textEl = {
    textContent: '',
    _html: '',
    set innerHTML(v) {
      this._html = v;
      this.textContent = String(v).replace(/<[^>]*>/g, '');
    },
    get innerHTML() { return this._html; },
  };
  const maskEl = { classList: makeClassList(['cuckoo-hidden']) };
  const btnEl = { classList: makeClassList(['cuckoo-hidden']), onclick: null };
  global.document.querySelector = (sel) =>
    sel === '#cuckoo-tool-mask .cuckoo-tool-mask-text' ? textEl : null;
  global.document.getElementById = (id) => {
    if (id === 'cuckoo-tool-mask') return maskEl;
    if (id === 'cuckoo-tool-mask-cancel') return btnEl;
    return null;
  };
  global.document.addEventListener = () => {};
  global.document.removeEventListener = () => {};

  try {
    await fn({ textEl, maskEl, btnEl, sleep: (ms) => new Promise((r) => timers.setTimeout(r, ms)) });
  } finally {
    try { ui.hideToolMask(); } catch { /* ignore */ }
    global.setInterval = prev.setInterval;
    global.clearInterval = prev.clearInterval;
    global.setTimeout = prev.setTimeout;
    global.clearTimeout = prev.clearTimeout;
    global.document.querySelector = prev.querySelector;
    global.document.getElementById = prev.getElementById;
    global.document.addEventListener = prev.addEventListener;
    global.document.removeEventListener = prev.removeEventListener;
  }
}

test('遮罩：进入发送阶段后工具耗时定格，延迟单独计时', async () => {
  await withRealMaskDom(async ({ textEl, sleep }) => {
    ui.showToolMask(null);
    assert.match(textEl.textContent, /工具调用执行中/, '执行阶段应显示工具调用文案');
    await sleep(1100);
    // 阶段切换：工具耗时拍快照，延迟从 0 重新计
    ui.showToolMask(() => {}, true, '正在回传结果');
    // 工具耗时用区间断言：CI 卡顿时 1100ms 可能跨成 2s，硬编码 1s 会假失败
    assert.match(textEl.textContent, /正在回传结果（工具 [12]s · 延迟 0s），请不要有额外操作/);
    // 等两个 tick（interval 相位对齐用 2s，避免恰好落在边界内侧）
    await sleep(2100);
    // 延迟递增，工具耗时定格不变（仍是切换瞬间那个值）
    assert.match(textEl.textContent, /正在回传结果（工具 [12]s · 延迟 [12]s），请不要有额外操作/);
    // 数字必须带强调标签，且每个"秒数+单位"各一个（工具 Ns + 延迟 Ns）
    const bTags = textEl._html.match(/<b>\d+s<\/b>/g) || [];
    assert.strictEqual(bTags.length, 2, '两个秒数都应包 <b>，实际=' + JSON.stringify(bTags));
    // 工具耗时定格：两次读取必须一致（这才是本改动的核心不变量）
    const toolSec = (textEl.textContent.match(/工具 (\d+)s/) || [])[1];
    assert.ok(toolSec === '1' || toolSec === '2', '工具耗时应在 1~2s，实际=' + toolSec);
  });
});

test('遮罩：隐藏后重新显示从 0 开始（不残留上一轮快照）', async () => {
  await withRealMaskDom(async ({ textEl, maskEl, sleep }) => {
    // 完整一轮：执行 → 发送
    ui.showToolMask(null);
    await sleep(1100);
    ui.showToolMask(() => {}, true, '正在回传结果');
    await sleep(2100);
    assert.match(textEl.textContent, /正在回传结果（工具 [12]s · 延迟 [12]s）/);
    ui.hideToolMask();
    assert.strictEqual(maskEl.classList.contains('cuckoo-hidden'), true, '隐藏后遮罩应带 cuckoo-hidden');

    // 全新遮罩：不是 reuse 分支，快照应被清零
    ui.showToolMask(null);
    assert.match(textEl.textContent, /工具调用执行中/, '重新显示应回到执行阶段文案');
    assert.ok(!textEl.textContent.includes('延迟'), '重新显示不应残留发送阶段文案');

    // 再进发送阶段：延迟必须从 0 重新计（证明上一轮快照已清）
    ui.showToolMask(() => {}, true, '正在回传结果');
    assert.match(textEl.textContent, /正在回传结果（工具 [01]s · 延迟 0s）/);
  });
});

