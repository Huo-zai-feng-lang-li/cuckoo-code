'use strict';
/**
 * 滚动跟随测试：测真实集成逻辑，不做深 mock。
 * - shouldFollowToBottom 是纯决策函数，直接测边界。
 * - startScrollFollow 用最小 DOM stub 验证"离开记录→回来判断→滚底"的真实行为链。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { shouldFollowToBottom, startScrollFollow, resetScrollFollow, scheduleInitialScrollToBottom } from '../../src/bridge/scroll-follow.js';

// ===== shouldFollowToBottom 决策（纯函数）=====

test('无快照 → 不跟随', () => {
  assert.strictEqual(shouldFollowToBottom(null, 1000), false);
});

test('离开时不在底部（翻历史）→ 即使内容变高也不跟随', () => {
  const snap = { scrollTop: 100, scrollHeight: 2000, nearBottom: false };
  assert.strictEqual(shouldFollowToBottom(snap, 3000), false);
});

test('离开时在底部但内容没变高 → 不跟随', () => {
  const snap = { scrollTop: 900, scrollHeight: 1000, nearBottom: true };
  assert.strictEqual(shouldFollowToBottom(snap, 1000), false);
});

test('离开时在底部且内容变高 → 跟随', () => {
  const snap = { scrollTop: 900, scrollHeight: 1000, nearBottom: true };
  assert.strictEqual(shouldFollowToBottom(snap, 1500), true);
});

test('高度仅差 1px 以内视为未变（浮点容差）', () => {
  const snap = { scrollTop: 900, scrollHeight: 1000, nearBottom: true };
  assert.strictEqual(shouldFollowToBottom(snap, 1000.5), false);
  assert.strictEqual(shouldFollowToBottom(snap, 1001.5), true);
});

// ===== startScrollFollow 真实行为（最小 DOM stub）=====

/** 建一个可滚动元素的 stub：真实数值 + 真实 scrollTo 调用记录 */
function makeScroller(opts) {
  const el = {
    id: opts.id || '',
    isConnected: true,
    scrollTop: opts.scrollTop,
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    scrollToCalls: [],
    /** 模拟 DOM 包含关系：默认只包含自己；roots 用 children 列表判定 */
    contains(other) {
      if (other === this) return true;
      if (Array.isArray(this.children)) return this.children.indexOf(other) !== -1;
      return false;
    },
    scrollTo(arg) {
      this.scrollToCalls.push(arg);
      if (arg && typeof arg.top === 'number') this.scrollTop = arg.top;
    },
  };
  return el;
}

/**
 * 装一套最小 DOM 环境。
 * @param scroller 主滚动元素（默认会被 querySelectorAll('body *') 返回）
 * @param opts 可选：{ extraElements, cuckooRoots, byId }
 *   - extraElements: 额外候选元素（如模拟 overlay 面板内的滚动容器）
 *   - cuckooRoots: 模拟 Cuckoo 根节点（getElementById 能命中，且 contains 覆盖其内部元素）
 *   - byId: id → 元素映射（给 getElementById 用）
 * 返回 { fire(event) } 用于触发 visibilitychange / blur / focus。
 */
function installDom(scroller, opts = {}) {
  const listeners = { document: {}, window: {} };
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  const origRaf = globalThis.requestAnimationFrame;
  const origGcs = globalThis.getComputedStyle;

  const extra = opts.extraElements || [];
  const byId = opts.byId || {};
  const cuckooRoots = opts.cuckooRoots || [];
  const allElements = [scroller, ...extra];
  globalThis.document = {
    visibilityState: 'visible',
    querySelectorAll: (sel) => {
      // 插件根节点选择器 [id^="cuckoo-plugin-ui-"]
      if (typeof sel === 'string' && sel.indexOf('cuckoo-plugin-ui-') !== -1) {
        return cuckooRoots.filter((r) => (r.id || '').indexOf('cuckoo-plugin-ui-') === 0);
      }
      return allElements;
    },
    getElementById: (id) => byId[id] || cuckooRoots.find((r) => r.id === id) || null,
    scrollingElement: scroller,
    addEventListener: (ev, fn) => { listeners.document[ev] = fn; },
    removeEventListener: (ev) => { delete listeners.document[ev]; },
  };
  globalThis.window = {
    addEventListener: (ev, fn) => { listeners.window[ev] = fn; },
    removeEventListener: (ev) => { delete listeners.window[ev]; },
  };
  // rAF 同步执行，便于断言
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 0; };
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' });

  return {
    fireDoc(ev, arg) { listeners.document[ev] && listeners.document[ev](arg); },
    fireWin(ev) { listeners.window[ev] && listeners.window[ev](); },
    restore() {
      globalThis.document = origDoc;
      globalThis.window = origWin;
      globalThis.requestAnimationFrame = origRaf;
      globalThis.getComputedStyle = origGcs;
    },
  };
}

test('startScrollFollow: 离开在底部 + 回来内容变高 → 滚到底', () => {
  const el = makeScroller({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
  const dom = installDom(el);
  let stop = () => {};
  try {
    stop = startScrollFollow();
    // 离开：在底部（1000-900-100=0）
    dom.fireDoc('visibilitychange');
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    // 内容变高
    el.scrollHeight = 1500;
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(el.scrollToCalls.length, 1, '应触发一次滚动');
    assert.strictEqual(el.scrollToCalls[0].top, 1500);
    assert.strictEqual(el.scrollToCalls[0].behavior, 'smooth');
  } finally {
    stop();
    dom.restore();
  }
});

test('startScrollFollow: 离开在翻历史 → 回来不滚动', () => {
  const el = makeScroller({ scrollTop: 100, scrollHeight: 2000, clientHeight: 100 });
  const dom = installDom(el);
  let stop = () => {};
  try {
    stop = startScrollFollow();
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    el.scrollHeight = 3000;
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(el.scrollToCalls.length, 0, '翻历史时不应强制滚底');
  } finally {
    stop();
    dom.restore();
  }
});

test('startScrollFollow: 离开在底部但无新内容 → 不滚动', () => {
  const el = makeScroller({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
  const dom = installDom(el);
  let stop = () => {};
  try {
    stop = startScrollFollow();
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(el.scrollToCalls.length, 0);
  } finally {
    stop();
    dom.restore();
  }
});

test('startScrollFollow: window blur/focus 与 visibilitychange 去重，不重复记录', () => {
  const el = makeScroller({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
  const dom = installDom(el);
  let stop = () => {};
  try {
    stop = startScrollFollow();
    // 先 blur（窗口失焦）→ 记录
    dom.fireWin('blur');
    // 再 visibilitychange hidden → 应被去重，不覆盖快照
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    el.scrollHeight = 1500;
    dom.fireWin('focus');
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(el.scrollToCalls.length, 1, '去重后只滚一次');
  } finally {
    stop();
    dom.restore();
  }
});

test('startScrollFollow: 排除 Cuckoo 自身注入的滚动容器（会话短时不选错设置面板）', () => {
  // 主对话容器：溢出 200px，且在底部附近（1000-850-100=50 ≤ 80）
  const main = makeScroller({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 });
  // 设置面板里的滚动容器：溢出 600px（比主容器大，若不排除会被误选）
  const panelInner = makeScroller({ scrollTop: 0, scrollHeight: 700, clientHeight: 100 });
  // 模拟 Cuckoo 根节点，contains(panelInner) = true
  const cuckooRoot = {
    id: 'cuckoo-root',
    contains(other) { return other === panelInner; },
  };
  const dom = installDom(main, {
    extraElements: [panelInner],
    cuckooRoots: [cuckooRoot],
    byId: { 'cuckoo-root': cuckooRoot },
  });
  let stop = () => {};
  try {
    stop = startScrollFollow();
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    // 内容变高
    main.scrollHeight = 1400;
    panelInner.scrollHeight = 2000; // 面板也变高，但不该被滚
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(main.scrollToCalls.length, 1, '应滚主对话容器');
    assert.strictEqual(panelInner.scrollToCalls.length, 0, '不应滚 Cuckoo 面板容器');
    assert.strictEqual(main.scrollToCalls[0].top, 1400);
  } finally {
    stop();
    dom.restore();
  }
});

test('resetScrollFollow: 会话切换后清空快照，回来不滚（避免拿旧快照误判）', () => {
  const el = makeScroller({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
  const dom = installDom(el);
  let stop = () => {};
  try {
    stop = startScrollFollow();
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    // 模拟 URL 变化：清快照
    resetScrollFollow();
    el.scrollHeight = 1500;
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(el.scrollToCalls.length, 0, '快照已清，不应滚');
  } finally {
    stop();
    dom.restore();
  }
});

test('startScrollFollow: 无 overflow 容器时回退到 scrollingElement', () => {
  // 页面里没有任何 overflow:auto 的元素 → 走 scrollingElement 回退
  const se = makeScroller({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 });
  const origGcs = globalThis.getComputedStyle;
  const dom = installDom(se);
  globalThis.getComputedStyle = () => ({ overflowY: 'visible' }); // 全部不可滚动
  let stop = () => {};
  try {
    stop = startScrollFollow();
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    se.scrollHeight = 800;
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(se.scrollToCalls.length, 1, '应回退到 scrollingElement 并滚动');
    assert.strictEqual(se.scrollToCalls[0].top, 800);
  } finally {
    stop();
    dom.restore();
    globalThis.getComputedStyle = origGcs;
  }
});

test('startScrollFollow: 幂等，重复调用不重复挂监听', () => {
  const el = makeScroller({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
  const dom = installDom(el);
  let stop = () => {};
  try {
    stop = startScrollFollow();
    startScrollFollow();
    startScrollFollow();
    // 若重复注册，一次 hidden+visible 会触发多次 scrollTo
    globalThis.document.visibilityState = 'hidden';
    dom.fireDoc('visibilitychange');
    el.scrollHeight = 1500;
    globalThis.document.visibilityState = 'visible';
    dom.fireDoc('visibilitychange');
    assert.strictEqual(el.scrollToCalls.length, 1);
  } finally {
    stop();
    dom.restore();
  }
});

test('scheduleInitialScrollToBottom: 页面初次载入探测到主滚动容器后自动滚到底部', async () => {
  const el = makeScroller({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
  const dom = installDom(el);
  try {
    await new Promise((resolve) => {
      const cancel = scheduleInitialScrollToBottom(() => {
        resolve();
      });
      // 模拟 160ms 后完成第一轮探测并滚底
      setTimeout(() => {
        if (el.scrollToCalls.length > 0) {
          cancel();
          resolve();
        }
      }, 200);
    });
    assert.ok(el.scrollToCalls.length >= 1, '应至少触发一次滚到底部');
    assert.strictEqual(el.scrollToCalls[0].top, 2000);
  } finally {
    dom.restore();
  }
});

test('scheduleInitialScrollToBottom: cancel 后终止后续重试', async () => {
  const el = makeScroller({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
  const dom = installDom(el);
  try {
    const cancel = scheduleInitialScrollToBottom();
    cancel(); // 立即取消
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(el.scrollToCalls.length, 0, '取消后不应产生滚动调用');
  } finally {
    dom.restore();
  }
});
