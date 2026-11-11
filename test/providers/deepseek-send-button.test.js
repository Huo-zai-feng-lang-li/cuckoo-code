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
