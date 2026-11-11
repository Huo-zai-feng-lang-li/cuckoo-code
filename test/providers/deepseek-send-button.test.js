import { expect, test, afterEach } from 'vitest';
import { deepseek } from '../../src/providers/deepseek.js';

const ARROW = 'M8.3125 0.980206C8.667';
const SQUARE = 'M2 4.88C2 3.68';

function makeBtn(cls, pathD) {
  return {
    tagName: 'DIV',
    className: cls,
    offsetWidth: 34,
    offsetHeight: 34,
    disabled: false,
    querySelector: (sel) =>
      sel === 'svg path' ? { getAttribute: () => pathD } : null,
  };
}

function installDoc(btn) {
  globalThis.document = {
    querySelector: (sel) => (sel === '.ds-button--primary' ? btn : null),
  };
}

afterEach(() => {
  delete globalThis.document;
});

test('DeepSeek 发送按钮兜底能定位 DIV 主按钮（箭头、非禁用）', () => {
  const btn = makeBtn('ds-button ds-button--primary ds-button--filled', ARROW);
  installDoc(btn);
  expect(deepseek.findSendButton()).toBe(btn);
});

test('生成中方块停止态主按钮不得被当作发送按钮', () => {
  const btn = makeBtn('ds-button ds-button--primary ds-button--filled', SQUARE);
  installDoc(btn);
  expect(deepseek.findSendButton()).toBeNull();
});

test('禁用态（ds-button--disabled）主按钮不得被命中', () => {
  const btn = makeBtn('ds-button ds-button--primary ds-button--disabled', ARROW);
  installDoc(btn);
  expect(deepseek.findSendButton()).toBeNull();
});

test('纯净模式后台隐藏（offsetWidth为0）但computedStyle正常时判定可见', () => {
  const el = {
    offsetWidth: 0,
    offsetHeight: 0,
    isConnected: true,
  };
  globalThis.window = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  try {
    expect(deepseek.isElementVisible(el)).toBe(true);
  } finally {
    delete globalThis.window;
  }
});

test('DeepSeek setupNewSession: 正确开「深度思考」、关「联网搜索」', () => {
  const eventsA = [];
  const eventsB = [];
  const btnThink = {
    textContent: '深度思考 (R1)',
    getAttribute: (attr) => (attr === 'aria-pressed' ? 'false' : null),
    className: 'ds-toggle-button',
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 80, height: 32 }),
    dispatchEvent: (ev) => { eventsA.push(ev.type); return true; },
  };
  const btnSearch = {
    textContent: '联网搜索',
    getAttribute: (attr) => (attr === 'aria-pressed' ? 'true' : null),
    className: 'ds-toggle-button ds-toggle-button--selected',
    getBoundingClientRect: () => ({ left: 100, top: 10, width: 80, height: 32 }),
    dispatchEvent: (ev) => { eventsB.push(ev.type); return true; },
  };

  const doc = {
    querySelectorAll: (sel) => [btnThink, btnSearch],
  };
  class MockEvent {
    constructor(type, opts) {
      this.type = type;
      this.opts = opts;
    }
  }
  const win = {
    PointerEvent: MockEvent,
    MouseEvent: MockEvent,
  };

  const fn = deepseek.setupNewSession();
  const res = fn(doc, win);
  expect(res.ready).toBe(true);
  expect(res.found).toBe(2);
  // 深度思考应收到点击序列
  expect(eventsA).toContain('click');
  // 联网搜索应收到点击序列（关闭）
  expect(eventsB).toContain('click');
});

test('DeepSeek setupNewSession: 状态已符合预期时静默不点击', () => {
  const eventsA = [];
  const eventsB = [];
  const btnThink = {
    textContent: '深度思考 (R1)',
    getAttribute: (attr) => (attr === 'aria-pressed' ? 'true' : null),
    className: 'ds-toggle-button ds-toggle-button--selected',
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 80, height: 32 }),
    dispatchEvent: (ev) => { eventsA.push(ev.type); return true; },
  };
  const btnSearch = {
    textContent: '联网搜索',
    getAttribute: (attr) => (attr === 'aria-pressed' ? 'false' : null),
    className: 'ds-toggle-button',
    getBoundingClientRect: () => ({ left: 100, top: 10, width: 80, height: 32 }),
    dispatchEvent: (ev) => { eventsB.push(ev.type); return true; },
  };

  const doc = {
    querySelectorAll: (sel) => [btnThink, btnSearch],
  };
  const win = {};

  const fn = deepseek.setupNewSession();
  const res = fn(doc, win);
  expect(res.ready).toBe(true);
  expect(res.found).toBe(2);
  expect(eventsA.length).toBe(0);
  expect(eventsB.length).toBe(0);
});
