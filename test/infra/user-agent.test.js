'use strict';
/**
 * infra/user-agent 测试（纯函数）
 *
 * 关键：UA 里的 Chrome 版本必须来自 process.versions.chrome（真实内核），
 * 否则与 sec-ch-ua 矛盾，会被 Google 判定"浏览器不安全"。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { buildChromeUserAgent, chromeMajor, buildUserAgentDataFix, buildClientHintsHeaders, buildUserAgentMetadata, winPlatformVersionForBuild, formatUniversalApiContract } from '../../src/infra/user-agent.js';

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

  const origFnToString = Function.prototype.toString;
  try {
    const fn = new Function('window', 'navigator', 'Navigator', script);
    fn(fakeWin, fakeNav, FakeNavigator);

    assert.strictEqual(fakeNav.webdriver, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fakeNav, 'webdriver'), false, 'navigator 实例自身不应含有 webdriver 属性');
    assert.strictEqual('webdriver' in fakeNav, true);
    assert.strictEqual(FakeNavigator.prototype.webdriver, false, '原型链上应提供 webdriver getter 返回 false');
    const desc = Object.getOwnPropertyDescriptor(FakeNavigator.prototype, 'webdriver');
    assert.strictEqual(desc.get.toString(), 'function get webdriver() { [native code] }');
    assert.strictEqual(
      Function.prototype.toString.call(desc.get),
      'function get webdriver() { [native code] }',
      'Function.prototype.toString.call 不得读出 getter 源码',
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(desc.get, 'toString'), false, '原生函数不得有自有 toString');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(desc.get, 'prototype'), false, '原生 getter 不得有自有 prototype');
    assert.ok(fakeWin.chrome && fakeWin.chrome.runtime, '应补齐 window.chrome.runtime');
  } finally {
    Function.prototype.toString = origFnToString;
  }
});

test('buildUserAgentDataFix 的 brands / getHighEntropyValues 同样注册全局 toString', () => {
  const script = buildUserAgentDataFix();

  class FakeUAD {
    get brands() {
      return [
        { brand: 'Chromium', version: '152' },
        { brand: 'Not_A Brand', version: '24' },
      ];
    }
    getHighEntropyValues() {
      return Promise.resolve({ brands: this.brands, fullVersionList: [] });
    }
  }
  class FakeNavigator {
    constructor() { this.userAgentData = new FakeUAD(); }
  }

  const fakeNav = new FakeNavigator();
  const origFnToString = Function.prototype.toString;
  try {
    const fn = new Function('window', 'navigator', 'Navigator', script);
    fn({ chrome: {} }, fakeNav, FakeNavigator);

    const proto = Object.getPrototypeOf(fakeNav.userAgentData);
    const brandsDesc = Object.getOwnPropertyDescriptor(proto, 'brands');
    assert.ok(brandsDesc, '必须在 userAgentData 原型上安装 brands getter');
    assert.strictEqual(
      Function.prototype.toString.call(brandsDesc.get),
      'function get brands() { [native code] }',
      'brands getter 不得被全局 toString 读出源码',
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(brandsDesc.get, 'toString'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(brandsDesc.get, 'prototype'), false, 'brands getter 不得有自有 prototype');

    const hevDesc = Object.getOwnPropertyDescriptor(proto, 'getHighEntropyValues');
    assert.ok(hevDesc, '必须包装 getHighEntropyValues');
    assert.strictEqual(
      Function.prototype.toString.call(hevDesc.value),
      'function getHighEntropyValues() { [native code] }',
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(hevDesc.value, 'toString'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(hevDesc.value, 'prototype'), false, 'getHighEntropyValues 不得有自有 prototype');

    assert.ok(
      fakeNav.userAgentData.brands.some((b) => b.brand === 'Google Chrome'),
      '必须补齐 Google Chrome 品牌',
    );
  } finally {
    Function.prototype.toString = origFnToString;
  }
});

test('Chrome 152 的品牌顺序、GREASE 与 Sec-CH-UA 和真 Chrome 一致', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '152.0.7977.130', configurable: true });

    const meta = buildUserAgentMetadata();
    assert.deepStrictEqual(meta.brands, [
      { brand: 'Chromium', version: '152' },
      { brand: 'Not?A_Brand', version: '24' },
      { brand: 'Google Chrome', version: '152' },
    ]);
    assert.deepStrictEqual(meta.fullVersionList, [
      { brand: 'Chromium', version: '152.0.7977.130' },
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
      { brand: 'Google Chrome', version: '152.0.7977.130' },
    ]);

    const hints = buildClientHintsHeaders();
    assert.strictEqual(
      hints['sec-ch-ua'],
      '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
    );
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('Chrome 153 的品牌顺序、GREASE 与 Sec-CH-UA 和真 Chrome 一致', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '153.0.1.2', configurable: true });
    const meta = buildUserAgentMetadata();
    assert.deepStrictEqual(meta.brands, [
      { brand: 'Google Chrome', version: '153' },
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '153' },
    ]);
    assert.strictEqual(
      buildClientHintsHeaders()['sec-ch-ua'],
      '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    );
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('Chrome 154 的品牌顺序、GREASE 与 Sec-CH-UA 和真 Chrome 一致', () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '154.0.1.2', configurable: true });
    const meta = buildUserAgentMetadata();
    assert.deepStrictEqual(meta.brands, [
      { brand: 'Chromium', version: '154' },
      { brand: 'Google Chrome', version: '154' },
      { brand: 'Not A(Brand', version: '99' },
    ]);
    assert.strictEqual(
      buildClientHintsHeaders()['sec-ch-ua'],
      '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    );
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('buildUserAgentDataFix 保留原生 GREASE、顺序正确，且不凭空加未请求的 fullVersionList', async () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '152.0.7977.130', configurable: true });
    const script = buildUserAgentDataFix();

    class FakeUAD {
      get brands() {
        // Electron 原生值：没有 Google Chrome，GREASE 是 Not?A_Brand
        return [
          { brand: 'Not?A_Brand', version: '24' },
          { brand: 'Chromium', version: '152' },
        ];
      }
      getHighEntropyValues(hints) {
        const r = { brands: this.brands, mobile: false, platform: 'Windows', platformVersion: '15.0.0' };
        if (hints.includes('fullVersionList')) {
          r.fullVersionList = [
            { brand: 'Not?A_Brand', version: '24.0.0.0' },
            { brand: 'Chromium', version: '152.0.7977.130' },
          ];
        }
        return Promise.resolve(r);
      }
    }
    class FakeNavigator {
      constructor() { this.userAgentData = new FakeUAD(); }
    }

    const fakeNav = new FakeNavigator();
    const origFnToString = Function.prototype.toString;
    try {
      const fn = new Function('window', 'navigator', 'Navigator', script);
      fn({ chrome: {} }, fakeNav, FakeNavigator);

      const expectedBrands = [
        { brand: 'Chromium', version: '152' },
        { brand: 'Not?A_Brand', version: '24' },
        { brand: 'Google Chrome', version: '152' },
      ];
      assert.deepStrictEqual(fakeNav.userAgentData.brands, expectedBrands);

      const onlyPlatform = await fakeNav.userAgentData.getHighEntropyValues(['platformVersion']);
      assert.deepStrictEqual(onlyPlatform.brands, expectedBrands);
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(onlyPlatform, 'fullVersionList'),
        false,
        '未请求 fullVersionList 时不得凭空返回',
      );

      const withFull = await fakeNav.userAgentData.getHighEntropyValues(['fullVersionList']);
      assert.deepStrictEqual(withFull.fullVersionList, [
        { brand: 'Chromium', version: '152.0.7977.130' },
        { brand: 'Not?A_Brand', version: '24.0.0.0' },
        { brand: 'Google Chrome', version: '152.0.7977.130' },
      ]);
    } finally {
      Function.prototype.toString = origFnToString;
    }
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('buildUserAgentDataFix 即使原生已含 Google Chrome 也强制归一化（防 CDP 断开后露原生顺序）', async () => {
  const prev = process.versions.chrome;
  try {
    Object.defineProperty(process.versions, 'chrome', { value: '152.0.7977.130', configurable: true });
    const script = buildUserAgentDataFix();

    class FakeUAD {
      get brands() {
        return [
          { brand: 'Google Chrome', version: '152' },
          { brand: 'Chromium', version: '152' },
          { brand: 'Not_A Brand', version: '24' },
        ];
      }
      getHighEntropyValues() {
        return Promise.resolve({ brands: this.brands, mobile: false, platform: 'Windows', platformVersion: '15.0.0' });
      }
    }
    class FakeNavigator {
      constructor() { this.userAgentData = new FakeUAD(); }
    }

    const fakeNav = new FakeNavigator();
    const origFnToString = Function.prototype.toString;
    try {
      const fn = new Function('window', 'navigator', 'Navigator', script);
      fn({ chrome: {} }, fakeNav, FakeNavigator);
      assert.deepStrictEqual(fakeNav.userAgentData.brands, [
        { brand: 'Chromium', version: '152' },
        { brand: 'Not?A_Brand', version: '24' },
        { brand: 'Google Chrome', version: '152' },
      ]);
    } finally {
      Function.prototype.toString = origFnToString;
    }
  } finally {
    Object.defineProperty(process.versions, 'chrome', { value: prev, configurable: true });
  }
});

test('Windows platformVersion 兜底映射（Win11 23H2 = 15.0.0）', () => {
  // Chromium UA-CH 对 Windows build 的公开映射；本机 Win11 22631 实测 15.0.0。
  assert.strictEqual(winPlatformVersionForBuild(22631), '15.0.0');
  assert.strictEqual(winPlatformVersionForBuild(22621), '14.0.0');
  assert.strictEqual(winPlatformVersionForBuild(22000), '13.0.0');
  assert.strictEqual(winPlatformVersionForBuild(26100), '16.0.0');
  assert.strictEqual(winPlatformVersionForBuild(19045), '10.0.0');
});

test('Windows platformVersion 对异常 build 兜底 10.0.0', () => {
  assert.strictEqual(winPlatformVersionForBuild(0), '10.0.0');
  assert.strictEqual(winPlatformVersionForBuild(NaN), '10.0.0');
  assert.strictEqual(winPlatformVersionForBuild(-1), '10.0.0');
});

test('UniversalApiContract DWORD 按 HIWORD/LOWORD 转 platformVersion', () => {
  // 本机 Win11 22631 注册表值 0x000f0000 → 真 Chrome 返回 15.0.0。
  assert.strictEqual(formatUniversalApiContract(0x000f0000), '15.0.0');
  assert.strictEqual(formatUniversalApiContract(0x00100000), '16.0.0');
  assert.strictEqual(formatUniversalApiContract(0x000a0000), '10.0.0');
  assert.strictEqual(formatUniversalApiContract(0), null);
  assert.strictEqual(formatUniversalApiContract(-1), null);
  assert.strictEqual(formatUniversalApiContract(0.5), null);
});

