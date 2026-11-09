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
  // 短文本快速响应（<5000ms）
  const shortDelay = chat.randomDelay('ok');
  assert.ok(shortDelay >= 1000 && shortDelay <= 5000, '短文本延迟应迅速: ' + shortDelay);

  // 超长文本自动延展模拟阅读思考（加上抖动在 8000ms ~ 30000ms 之间）
  const longText = 'a'.repeat(3000);
  const longDelay = chat.randomDelay(longText);
  assert.ok(longDelay >= 8000 && longDelay <= 30000, '长文本延迟应具有充足阅读思考时间: ' + longDelay);
  assert.ok(longDelay > shortDelay, '长文本延迟通常大于短文本');
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

test('insertSnippet: autoSend 走拟人化微延迟而非固定机械 300ms', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let scheduledDelay = 0;
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
      dispatchEvent: () => true,
      __style: { display: 'block', visibility: 'visible', opacity: '1' },
    };
    globalThis.document.querySelector = () => input;
    globalThis.document.querySelectorAll = () => [input];

    const ok = await chat.insertSnippet('请继续编写代码并运行测试', true);
    assert.strictEqual(ok, true, 'insertSnippet 应执行成功');
    assert.ok(scheduledDelay >= 600, '自动发送应设置至少 600ms 的拟人化延迟: ' + scheduledDelay);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});
