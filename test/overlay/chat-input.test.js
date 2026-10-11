'use strict';
/**
 * chat-input 纯逻辑测试：随机延迟、输入框可见性、输入框查找
 * window/document/provider 是外部边界，按需 mock。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({ ipcRenderer: { on: () => {}, invoke: async () => ({}) } }),
  };
});

vi.mock('../../src/providers/registry.js', () => ({
  getProviderByUrl: () => null,
}));

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
  vi.resetModules();
  setupGlobals();
  chat = await import('../../src/overlay/chat-input.js');
  state = (await import('../../src/overlay/state.js')).state;
});

test('randomDelay 在 [min, max) 范围内', () => {
  state.sendDelayMin = 1000;
  state.sendDelayMax = 2000;
  for (let i = 0; i < 50; i++) {
    const d = chat.randomDelay();
    assert.ok(d >= 1000 && d < 2000, '延迟应在范围内: ' + d);
  }
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

test('isInputVisible 当 isConnected 为 false 时直接返回 false', () => {
  const el = { isConnected: false, __style: { display: 'block', visibility: 'visible', opacity: '1' } };
  assert.strictEqual(chat.isInputVisible(el), false);
});

test('isInputVisible 优先支持原生 checkVisibility', () => {
  let checked = false;
  const el = {
    isConnected: true,
    checkVisibility: () => {
      checked = true;
      return true;
    },
  };
  assert.strictEqual(chat.isInputVisible(el), true);
  assert.strictEqual(checked, true);
});

test('findInputArea 找不到任何输入框返回 null', () => {
  chat.clearInputAreaCache();
  assert.strictEqual(chat.findInputArea(), null);
});

test('findInputArea 兜底返回第一个可见 textarea 并命中缓存', () => {
  chat.clearInputAreaCache();
  const ta = { isConnected: true, __style: { display: 'block', visibility: 'visible', opacity: '1' } };
  let scanCount = 0;
  document.querySelectorAll = () => {
    scanCount++;
    return [ta];
  };
  // 首次查询：扫描 DOM
  assert.strictEqual(chat.findInputArea(), ta);
  assert.strictEqual(scanCount, 1);
  // 二次查询：命中缓存，不再触发 querySelectorAll
  assert.strictEqual(chat.findInputArea(), ta);
  assert.strictEqual(scanCount, 1, '命中缓存时不应重复查询 DOM');

  // 清除缓存后再次查询：重新扫描 DOM
  chat.clearInputAreaCache();
  assert.strictEqual(chat.findInputArea(), ta);
  assert.strictEqual(scanCount, 2);
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

// ===== isSafeSendButton（防止误点上传附件打开文件管理器）=====

test('isSafeSendButton: 拒绝 null / undefined', () => {
  assert.strictEqual(chat.isSafeSendButton(null, {}), false);
  assert.strictEqual(chat.isSafeSendButton(undefined, {}), false);
});

test('isSafeSendButton: 拒绝 input[type=file]', () => {
  const fileInput = { tagName: 'INPUT', type: 'file' };
  assert.strictEqual(chat.isSafeSendButton(fileInput, {}), false);
});

test('isSafeSendButton: 拒绝内部包含 input[type=file] 的上传按钮', () => {
  const uploadBtn = {
    tagName: 'BUTTON',
    querySelector: (sel) => (sel === 'input[type="file"]' ? { tagName: 'INPUT' } : null),
  };
  assert.strictEqual(chat.isSafeSendButton(uploadBtn, {}), false);
});

test('isSafeSendButton: 拒绝 aria-label 或 title 包含上传附件词汇的按钮', () => {
  const btn1 = {
    getAttribute: (attr) => (attr === 'aria-label' ? '上传附件' : null),
  };
  const btn2 = {
    getAttribute: (attr) => (attr === 'title' ? 'Upload file' : null),
  };
  const btn3 = {
    getAttribute: (attr) => (attr === 'aria-label' ? '添加图片' : null),
  };
  assert.strictEqual(chat.isSafeSendButton(btn1, {}), false);
  assert.strictEqual(chat.isSafeSendButton(btn2, {}), false);
  assert.strictEqual(chat.isSafeSendButton(btn3, {}), false);
});

test('isSafeSendButton: 允许合法的发送按钮', () => {
  const sendBtn = {
    tagName: 'BUTTON',
    getAttribute: (attr) => (attr === 'aria-label' ? '发送消息' : null),
    querySelector: () => null,
  };
  assert.strictEqual(chat.isSafeSendButton(sendBtn, {}), true);
});
