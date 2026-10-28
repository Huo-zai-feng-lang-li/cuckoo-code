'use strict';
/**
 * infra/user-agent 测试（纯函数）
 *
 * 关键：UA 里的 Chrome 版本必须来自 process.versions.chrome（真实内核），
 * 否则与 sec-ch-ua 矛盾，会被 Google 判定"浏览器不安全"。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { buildChromeUserAgent, chromeMajor, buildUserAgentDataFix } from '../../src/infra/user-agent.js';

test('chromeMajor 取主版本号', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '152.0.7977.130', configurable: true });
    assert.strictEqual(chromeMajor(), '152');
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('chromeMajor 无版本时回退 0', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '', configurable: true });
    assert.strictEqual(chromeMajor(), '0');
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('buildChromeUserAgent 使用真实内核版本（非写死）', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '152.0.7977.130', configurable: true });
    const ua = buildChromeUserAgent();
    assert.ok(ua.includes('Chrome/152.0.0.0'), 'UA 应含真实主版本 152');
    assert.ok(!ua.includes('Electron'), 'UA 不应含 Electron 标识');
    assert.ok(ua.includes('Safari/537.36'));
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('buildChromeUserAgent 随内核版本变化（防写死回归）', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '160.1.2.3', configurable: true });
    assert.ok(buildChromeUserAgent().includes('Chrome/160.0.0.0'));
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('buildUserAgentDataFix 修正 webdriver 原型链且补齐 window.chrome', () => {
  const script = buildUserAgentDataFix();
  assert.ok(typeof script === 'string' && script.length > 0);

  // 模拟沙箱环境运行脚本
  class FakeNavigator {}
  const fakeNav = new FakeNavigator();
  fakeNav.webdriver = true; // 模拟原本被植入自动化标志
  const fakeWin = {
    Navigator: FakeNavigator,
    navigator: fakeNav,
  };

  const fn = new Function('window', 'navigator', 'Navigator', script);
  fn(fakeWin, fakeNav, FakeNavigator);

  assert.strictEqual(fakeNav.webdriver, false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(fakeNav, 'webdriver'), false, 'navigator 实例自身不应含有 webdriver 属性');
  assert.strictEqual('webdriver' in fakeNav, true);
  assert.strictEqual(FakeNavigator.prototype.webdriver, false, '原型链上应提供 webdriver getter 返回 false');
  const desc = Object.getOwnPropertyDescriptor(FakeNavigator.prototype, 'webdriver');
  assert.strictEqual(desc.get.toString(), 'function get webdriver() { [native code] }');
  assert.ok(fakeWin.chrome && fakeWin.chrome.runtime, '应补齐 window.chrome.runtime');
});

