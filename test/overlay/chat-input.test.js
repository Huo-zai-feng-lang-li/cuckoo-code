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
  const span = (60000 - 1000) * 0.25;
  // 短文本：命中 min 后只在 [min, min+25%区间] 抖动（保持「短文本快」语义）
  for (let i = 0; i < 20; i++) {
    const d = chat.randomDelay('ok');
    assert.ok(d >= 1000 && d <= 1000 + span + 1, '短文本延迟应迅速: ' + d);
  }

  // 极长文本（4000 字 = ratio 1）：必须能逼近配置上限 max，
  // 旧实现固定上限 23000ms，配置 max=36000 时永远够不着（用户实测分布偏低即此因）。
  const longText = 'a'.repeat(4000);
  let maxSeen = 0;
  for (let i = 0; i < 20; i++) {
    const d = chat.randomDelay(longText);
    assert.ok(d >= 1000 && d <= 60000, '不得突破配置区间: ' + d);
    if (d > maxSeen) maxSeen = d;
  }
  assert.ok(maxSeen > 40000, '极长文本必须能逼近配置上限: ' + maxSeen);
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
  // 回归：旧实现走 randomDelay(提示词自身长度)，数万字的系统提示词会算到配置上限（默认 36s），
  // 表现为「提示词只回显到输入框、迟迟不发送」。
  const origSetTimeout = globalThis.setTimeout;
  const delays = [];
  let sendTriggered = false;
  globalThis.setTimeout = ((fn, delay) => {
    delays.push(delay);
    return 1;
  });
  try {
    Object.defineProperty(globalThis.window.HTMLTextAreaElement.prototype, 'value', {
      set(v) { this._val = v; },
      configurable: true,
    });
    // 注意：不能自带 value 自有属性，否则会遮蔽原型访问器，写入后读回为空
    const input = {
      tagName: 'TEXTAREA',
      focus() {},
      setSelectionRange() {},
      getAttribute: () => null,
      dispatchEvent: () => true,
      __style: { display: 'block', visibility: 'visible', opacity: '1' },
    };
    // 原型级 value 存取器：setInputContent 走 HTMLTextAreaElement.prototype 的 desc.set，
    // 必须在原型上定义访问器才能让它与 getInputText 的读回保持一致。
    Object.defineProperty(globalThis.window.HTMLTextAreaElement.prototype, 'value', {
      get() { return this._val || ''; },
      set(v) { this._val = String(v); },
      configurable: true,
    });
    // 普通对象字面量的原型是 Object.prototype，必须显式接上 textarea 原型，
    // 否则上面定义的 value 访问器对 input.value 的读写都不生效。
    Object.setPrototypeOf(input, globalThis.window.HTMLTextAreaElement.prototype);
    globalThis.document.querySelector = () => input;
    globalThis.document.querySelectorAll = () => [input];
    globalThis.window.electronAPI = {
      sendEnterToChat: async () => { sendTriggered = true; return true; },
    };
    state.initialPromptContent = '系统提示词'.repeat(2000);
    state.pendingInitialPrompt = true;

    const ok = await chat.sendInitialPromptToInput();

    assert.strictEqual(ok, true, '初始提示应发送成功');
    assert.ok(delays.every((d) => d < 1000), '初始提示不得排随机延迟，实际延迟=' + JSON.stringify(delays));
    await new Promise((r) => origSetTimeout(r, 0));
    assert.strictEqual(sendTriggered, true, '应立即触发发送');
    assert.strictEqual(state.pendingInitialPrompt, false, '发送后必须清标志，否则重试逻辑卡死');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
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
