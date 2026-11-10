'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import {
  HARDWARE_PRESETS,
  generateFingerprint,
  normalizeFingerprintConfig,
  buildFingerprintScript,
} from '../../src/app/fingerprint.js';

test('HARDWARE_PRESETS: 预设池包含真实自洽的配置', () => {
  assert.ok(HARDWARE_PRESETS.length >= 4, '预设池至少包含 4 套真实机型');
  for (const preset of HARDWARE_PRESETS) {
    assert.ok(preset.id, '必须有 id');
    assert.ok(preset.hardwareConcurrency >= 4, 'CPU 核心数必须 >= 4');
    assert.ok(preset.deviceMemory >= 8, '内存必须 >= 8GB');
    assert.ok(preset.webglVendor.includes('Google Inc.'), '必须是 Google Inc. 规范');
    assert.ok(preset.webglRenderer.includes('ANGLE'), '必须符合 ANGLE 渲染器规范');
  }
});

test('generateFingerprint: 针对相同 profileId 具备稳定确定性，针对不同 profileId 离散', () => {
  const fp1 = generateFingerprint('profile-user-a');
  const fp2 = generateFingerprint('profile-user-a');
  assert.deepStrictEqual(fp1, fp2, '相同 profileId 生成的指纹配置必须严格一致');

  const fp3 = generateFingerprint('profile-user-b');
  assert.notStrictEqual(fp1.canvasSeed, fp3.canvasSeed, '不同 profileId 应有不同的 canvasSeed');
  assert.notStrictEqual(fp1.audioSeed, fp3.audioSeed, '不同 profileId 应有不同的 audioSeed');
});

test('normalizeFingerprintConfig: 防御脏数据并正确纠错与回退', () => {
  const fb = normalizeFingerprintConfig(null, 'test-id');
  assert.strictEqual(fb.enabled, true);
  assert.ok(fb.hardwareConcurrency > 0);

  const partial = normalizeFingerprintConfig({
    enabled: true,
    hardwareConcurrency: 32,
    deviceMemory: 64,
  }, 'test-id');
  assert.strictEqual(partial.hardwareConcurrency, 32);
  // deviceMemory 规范上限 8（GiB），超上限夹紧到 8，避免现实不可能值被风控识别
  assert.strictEqual(partial.deviceMemory, 8);
  assert.ok(partial.webglRenderer.includes('ANGLE'));
});

test('buildFingerprintScript: 未启用返回空，启用时生成包含原生伪装的高防脚本', () => {
  const disabledScript = buildFingerprintScript({ enabled: false });
  assert.strictEqual(disabledScript, '');

  const fp = generateFingerprint('profile-test-1');
  const script = buildFingerprintScript(fp);
  assert.ok(script.includes('window.__cuckooFpInjected'), '必须包含幂等保护');
  assert.ok(script.includes('[native code]'), '必须包含原生 toString 伪装');
  assert.ok(script.includes('hardwareConcurrency'), '必须覆盖 CPU 核心数');
  assert.ok(script.includes('deviceMemory'), '必须覆盖设备内存');
  assert.ok(script.includes('37445'), '必须拦截 UNMASKED_VENDOR_WEBGL');
  assert.ok(script.includes('37446'), '必须拦截 UNMASKED_RENDERER_WEBGL');
  assert.ok(script.includes('toDataURL'), '必须覆盖 Canvas toDataURL');
  assert.ok(script.includes('getChannelData'), '必须覆盖 AudioContext getChannelData');
  assert.ok(!script.includes("patchProtoGetter(Screen.prototype"), '不得覆盖 Screen 原型');
  assert.ok(!script.includes("patchProtoGetter(Window.prototype, 'devicePixelRatio'"), '不得覆盖 devicePixelRatio');
  assert.ok(script.includes('noisedBuffers'), '必须包含基于 WeakSet 的单次微扰守卫');
  // 防回潮守卫：尺寸类字段（screenWidth/screenHeight/devicePixelRatio）不在配置中建模，
  // 注入脚本的 cfgJson 绝不可出现这三个 key —— 它们既未被使用，出现只会让人误以为"分辨率已伪装"。
  assert.ok(!script.includes('screenWidth'), '注入脚本不得携带 screenWidth（该字段已从配置移除）');
  assert.ok(!script.includes('screenHeight'), '注入脚本不得携带 screenHeight（该字段已从配置移除）');
  const cfgMatch = script.match(/var FP = (\{[^}]*\});/);
  assert.ok(cfgMatch, '注入脚本必须包含 FP 配置对象');
  const cfg = JSON.parse(cfgMatch[1]);
  assert.deepStrictEqual(
    Object.keys(cfg).sort(),
    ['audioSeed', 'canvasSeed', 'deviceMemory', 'hardwareConcurrency', 'webglRenderer', 'webglVendor'],
    '指纹配置只应有 6 个实际生效的字段',
  );
});

test('buildFingerprintScript 不修改真实 4K Screen 与设备缩放比', () => {
  class MockScreen {
    get width() { return 3840; }
    get height() { return 2160; }
    get availWidth() { return 3840; }
    get availHeight() { return 2120; }
  }
  class MockWindow {
    get devicePixelRatio() { return 2; }
  }
  class MockNavigator {}

  const mockWindow = new MockWindow();
  mockWindow.screen = new MockScreen();
  const script = buildFingerprintScript(generateFingerprint('profile-4k'));
  const execute = new Function('window', 'Screen', 'Navigator', 'Window', script);

  execute(mockWindow, MockScreen, MockNavigator, MockWindow);

  assert.deepStrictEqual(
    [mockWindow.screen.width, mockWindow.screen.height, mockWindow.screen.availWidth, mockWindow.screen.availHeight],
    [3840, 2160, 3840, 2120],
    '4K 屏幕工作区尺寸必须保持 Electron/Chromium 的真实值',
  );
  assert.strictEqual(mockWindow.devicePixelRatio, 2, 'DPR 必须保持真实设备缩放比');
});

test('buildFingerprintScript 模拟执行：AudioBuffer 噪点单次注入、幂等性与零对象污染验证', () => {
  const fp = generateFingerprint('profile-test-audio');
  const script = buildFingerprintScript(fp);

  // 构造沙箱上下文验证脚本执行
  const mockAudioBuffer = {
    prototype: {
      getChannelData: function() {
        return new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      },
    },
  };
  const mockScreen = { prototype: {} };
  const mockWindow = {
    screen: mockScreen.prototype,
    AudioBuffer: mockAudioBuffer,
    Navigator: { prototype: {} },
    Screen: mockScreen,
    Window: { prototype: { get devicePixelRatio() { return 1.5; } } },
    document: {},
  };

  // 执行注入脚本
  const fn = new Function('window', 'Screen', 'AudioBuffer', 'Navigator', 'Window', script);
  fn(mockWindow, mockScreen, mockAudioBuffer, mockWindow.Navigator, mockWindow.Window);

  const getChannelData = mockAudioBuffer.prototype.getChannelData;
  assert.strictEqual(getChannelData.toString(), 'function getChannelData() { [native code] }');

  const buf = { length: 5 };
  const data1 = getChannelData.call(buf, 0);
  const firstSample = data1[0];

  // 验证零对象污染（杜绝 Reflect.ownKeys 反爬探测被识破）
  const ownKeys = Reflect.ownKeys(data1).map(String);
  assert.ok(!ownKeys.includes('__ckAudioNoised'), '绝不可在 Float32Array 上附加可被 ownKeys 探测的自有属性');

  // 第二次调用，应该命中 WeakSet 守卫，不应再次累加噪点
  const data2 = getChannelData.call(buf, 0);
  assert.strictEqual(data2[0], firstSample, '多次调用 getChannelData 必须严格保持恒定，不可叠加噪点');

  // 验证 window 自身没有被打上 ownProperty，必须干净继承自 Window.prototype
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mockWindow, 'devicePixelRatio'), false, 'window 实例自身不可有自有属性');
  assert.strictEqual(mockWindow.Window.prototype.devicePixelRatio, 1.5, 'Window.prototype 上的原生 DPR 不得被覆盖');
});

test('buildFingerprintScript 模拟执行：Canvas 2D 噪点单次微扰、幂等性与零 DOM 污染验证', () => {
  const fp = generateFingerprint('profile-test-canvas');
  const script = buildFingerprintScript(fp);

  let putImageDataCalled = 0;
  const mockCtx = {
    getImageData: () => ({
      data: new Uint8ClampedArray([100, 100, 100, 255, 120, 120, 120, 255]),
    }),
    putImageData: () => {
      putImageDataCalled++;
    },
  };

  const mockHTMLCanvasElement = {
    prototype: {
      toDataURL: function() { return 'data:image/png;base64,mocked'; },
    },
  };

  const mockWindow = {
    HTMLCanvasElement: mockHTMLCanvasElement,
    Window: { prototype: {} },
    Screen: { prototype: {} },
    Navigator: { prototype: {} },
    document: {},
  };

  const fn = new Function('window', 'HTMLCanvasElement', 'CanvasRenderingContext2D', 'Screen', 'Navigator', 'Window', script);
  fn(mockWindow, mockHTMLCanvasElement, undefined, mockWindow.Screen, mockWindow.Navigator, mockWindow.Window);

  const canvas = {
    width: 2,
    height: 1,
    getContext: (type) => (type === '2d' ? mockCtx : null),
  };

  // 第一次调用
  const toDataURL = mockHTMLCanvasElement.prototype.toDataURL;
  assert.strictEqual(toDataURL.toString(), 'function toDataURL() { [native code] }');

  toDataURL.call(canvas);
  assert.strictEqual(putImageDataCalled, 1, '第一次导出应进行微扰');

  // 第二次调用，命中 WeakSet，不再重复调用 putImageData
  toDataURL.call(canvas);
  assert.strictEqual(putImageDataCalled, 1, '第二次导出不可重复写回画布');

  // 验证 canvas DOM 对象自身 100% 纯净（无任何 __ckFpApplied 属性注入）
  const canvasKeys = Reflect.ownKeys(canvas).map(String);
  assert.ok(!canvasKeys.includes('__ckFpApplied'), '绝不可在 canvas 节点上挂载任何可被扫描的自有属性');
});

