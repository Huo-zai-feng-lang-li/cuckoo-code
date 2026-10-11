'use strict';
import { test } from 'vitest';
import assert from 'node:assert';

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

test('showToolMask/hideToolMask 不抛错', () => {
  assert.doesNotThrow(() => ui.showToolMask());
  assert.doesNotThrow(() => ui.showToolMask(() => {}));
  assert.doesNotThrow(() => ui.hideToolMask());
});

test('showFirstTimeDialog/hideFirstTimeDialog 不抛错', () => {
  assert.doesNotThrow(() => ui.showFirstTimeDialog());
  assert.doesNotThrow(() => ui.hideFirstTimeDialog());
});
