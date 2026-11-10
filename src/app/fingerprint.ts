/**
 * 每窗口硬件指纹伪装模块
 *
 * 核心设计原则：
 *  1. 真实自洽：显卡驱动、CPU核心、内存、分辨率在现实物理世界中完全匹配，拒绝荒谬随机组合。
 *  2. 原型链原生镜像（Native Cloaking）：被覆盖的 getter/方法严格对齐 V8 原生属性描述符，
 *     函数 toString 均返回 'function ...() { [native code] }'，隐藏调用栈，防反爬脚本探测。
 *  3. 重入 100% 幂等（Reentrancy Consistency）：Canvas 与 Audio 的微扰严格基于固定 Seed
 *     与像素/样本坐标做确定性伪随机运算，同一画板多次调用 toDataURL() 输出 100% 相同 Hash，
 *     绝不使用 Math.random()，杜绝被检测网站标记为"劣质噪点伪造"。
 *  4. 极致轻量：纯闭包在首帧注入执行（耗时 <0.1ms），无额外守护进程。
 */

export interface FingerprintPreset {
  id: string;
  name: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
}

export interface FingerprintConfig {
  enabled: boolean;
  presetId: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  canvasSeed: number;
  audioSeed: number;
}

/** 来源于全球主流真实 Windows PC 的自洽硬件预设池 */
export const HARDWARE_PRESETS: readonly FingerprintPreset[] = [
  {
    id: 'win-intel-uhd630',
    name: '商务主流机 (Intel UHD 630)',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win-intel-iris-xe',
    name: '主流轻薄本 (Intel Iris Xe)',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win-nvidia-rtx3060',
    name: '主流游戏/性能本 (NVIDIA RTX 3060)',
    hardwareConcurrency: 12,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win-nvidia-rtx4070',
    name: '高性能台式机 (NVIDIA RTX 4070)',
    hardwareConcurrency: 16,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win-amd-rx6600',
    name: 'AMD 独显台式机 (Radeon RX 6600)',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (AMD)',
    webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win-intel-uhd770',
    name: '新一代台式机 (Intel UHD 770)',
    hardwareConcurrency: 12,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
];

/** 简单的字符串正整数 Hash 函数（DJB2 变种） */
function stringHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * 为某个 Profile 自动生成一套自洽的硬件指纹配置（终生绑定）
 */
export function generateFingerprint(profileId: string): FingerprintConfig {
  const h = stringHash(profileId || 'default-profile');
  const presetIndex = h % HARDWARE_PRESETS.length;
  const preset = HARDWARE_PRESETS[presetIndex];

  // 种子保证同一 profileId 计算结果确定且不同 profileId 均匀离散
  const canvasSeed = 100000 + ((h * 13) % 899999);
  const audioSeed = 100000 + ((h * 37) % 899999);

  return {
    enabled: true,
    presetId: preset.id,
    hardwareConcurrency: preset.hardwareConcurrency,
    deviceMemory: preset.deviceMemory,
    webglVendor: preset.webglVendor,
    webglRenderer: preset.webglRenderer,
    canvasSeed,
    audioSeed,
  };
}

/**
 * 规范化并校验指纹配置，自动纠错与补全脏数据
 */
export function normalizeFingerprintConfig(input: any, profileId?: string): FingerprintConfig {
  const fallback = generateFingerprint(profileId || 'fallback');
  if (!input || typeof input !== 'object') return fallback;

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  const matchedPreset = HARDWARE_PRESETS.find(p => p.id === input.presetId);
  const base = matchedPreset || fallback;
  const finalPresetId = matchedPreset ? matchedPreset.id : fallback.presetId;

  const hwConcurrency = (typeof input.hardwareConcurrency === 'number' && input.hardwareConcurrency > 0)
    ? input.hardwareConcurrency
    : base.hardwareConcurrency;

  // navigator.deviceMemory 规范上限 8（>8 一律上报 8），超上限值是现实不可能的组合，必须夹紧
  const devMemory = (typeof input.deviceMemory === 'number' && input.deviceMemory > 0)
    ? Math.min(8, input.deviceMemory)
    : Math.min(8, base.deviceMemory);

  const webglVendor = typeof input.webglVendor === 'string' && input.webglVendor.trim()
    ? input.webglVendor.trim()
    : base.webglVendor;

  const webglRenderer = typeof input.webglRenderer === 'string' && input.webglRenderer.trim()
    ? input.webglRenderer.trim()
    : base.webglRenderer;

  const canvasSeed = (typeof input.canvasSeed === 'number' && Number.isInteger(input.canvasSeed) && input.canvasSeed > 0)
    ? input.canvasSeed
    : fallback.canvasSeed;

  const audioSeed = (typeof input.audioSeed === 'number' && Number.isInteger(input.audioSeed) && input.audioSeed > 0)
    ? input.audioSeed
    : fallback.audioSeed;

  return {
    enabled,
    presetId: finalPresetId,
    hardwareConcurrency: hwConcurrency,
    deviceMemory: devMemory,
    webglVendor,
    webglRenderer,
    canvasSeed,
    audioSeed,
  };
}

/**
 * 构建注入主世界的原生伪装指纹脚本
 */
export function buildFingerprintScript(fp: FingerprintConfig): string {
  if (!fp || !fp.enabled) return '';

  const cfgJson = JSON.stringify({
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    canvasSeed: fp.canvasSeed,
    audioSeed: fp.audioSeed,
  });

  return String.raw`
(function() {
  try {
    if (window.__cuckooFpInjected) return;
    // 不可枚举，避免 Reflect.ownKeys/Object.keys(window) 枚举到伪装标记
    try {
      Object.defineProperty(window, '__cuckooFpInjected', { value: true, enumerable: false, configurable: true, writable: true });
    } catch (_) { window.__cuckooFpInjected = true; }

    var FP = ${cfgJson};

    // ========== 1. 原生伪装引擎 (Native Cloaking Engine) ==========
    var nativeToString = Function.prototype.toString;
    var customToStrings = new WeakMap();

    // 伪装函数一律以「对象方法简写」创建（无自有 prototype、不可 new，与原生内置方法一致）。
    function markNative(fn, name) {
      if (typeof fn !== 'function') return fn;
      if (name) {
        try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) {}
      }
      customToStrings.set(fn, 'function ' + (name || '') + '() { [native code] }');
      return fn;
    }

    var hookedToString = ({
      toString() {
        if (customToStrings.has(this)) return customToStrings.get(this);
        return nativeToString.apply(this, arguments);
      }
    }).toString;
    markNative(hookedToString, 'toString');
    try { Function.prototype.toString = hookedToString; } catch (_) {}

    // ========== 2. Navigator 属性伪装 ==========
    function patchProtoGetter(proto, prop, val) {
      if (!proto) return;
      try {
        var origDesc = Object.getOwnPropertyDescriptor(proto, prop);
        var getter = ({ ['get ' + prop]() { return val; } })['get ' + prop];
        markNative(getter, 'get ' + prop);
        Object.defineProperty(proto, prop, {
          configurable: true,
          enumerable: origDesc ? origDesc.enumerable : true,
          get: getter
        });
      } catch (_) {}
    }

    if (typeof Navigator !== 'undefined' && Navigator.prototype) {
      patchProtoGetter(Navigator.prototype, 'hardwareConcurrency', FP.hardwareConcurrency);
      patchProtoGetter(Navigator.prototype, 'deviceMemory', FP.deviceMemory);
      patchProtoGetter(Navigator.prototype, 'webdriver', false);
      try {
        if (typeof navigator !== 'undefined' && Object.prototype.hasOwnProperty.call(navigator, 'webdriver')) {
          delete navigator.webdriver;
        }
      } catch (_) {}
    }

    // 尺寸类（screen.* / devicePixelRatio / 视口）一律保持 Chromium/Electron 真实值，
    // 不在本配置中建模：锁死视口会与 WebContentsView.setBounds 冲突，
    // 且会制造 screen.width 与 innerWidth 的矛盾特征（真实浏览器视口永远 ≤ 屏幕）。

    // ========== 3. WebGL 厂商与渲染器伪装 ==========
    function patchWebGL(glProto) {
      if (!glProto || !glProto.getParameter) return;
      var origGetParam = glProto.getParameter;
      var fakeGetParam = ({
        getParameter(param) {
          if (param === 37445) return FP.webglVendor;
          if (param === 37446) return FP.webglRenderer;
          return origGetParam.apply(this, arguments);
        }
      }).getParameter;
      markNative(fakeGetParam, 'getParameter');
      try { glProto.getParameter = fakeGetParam; } catch (_) {}
    }
    if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);

    // ========== 4. Canvas 2D 确定性微扰 ==========
    if (typeof HTMLCanvasElement !== 'undefined') {
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      var origGetImageData = (typeof CanvasRenderingContext2D !== 'undefined') ? CanvasRenderingContext2D.prototype.getImageData : null;
      var noisedCanvases = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

      function applyCanvasNoise(canvas) {
        try {
          if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
          if (noisedCanvases && noisedCanvases.has(canvas)) return;
          var ctx = canvas.getContext('2d');
          if (!ctx) return;
          if (noisedCanvases) noisedCanvases.add(canvas);

          var w = canvas.width, h = canvas.height;
          var sampleW = Math.min(w, 800), sampleH = Math.min(h, 800);
          var imgData = origGetImageData ? origGetImageData.call(ctx, 0, 0, sampleW, sampleH) : ctx.getImageData(0, 0, sampleW, sampleH);
          var d = imgData.data;
          var seed = FP.canvasSeed;
          var totalPixels = sampleW * sampleH;
          var step = Math.max(1, Math.floor(totalPixels / 2048));

          for (var p = 0; p < totalPixels; p += step) {
            var i = p * 4;
            if (d[i + 3] > 10) {
              var deltaR = (((p * 17 + seed) % 3) - 1);
              var deltaG = (((p * 31 + seed) % 3) - 1);
              var deltaB = (((p * 47 + seed) % 3) - 1);
              var nr = d[i] + deltaR; d[i] = nr < 0 ? 0 : (nr > 255 ? 255 : nr);
              var ng = d[i + 1] + deltaG; d[i + 1] = ng < 0 ? 0 : (ng > 255 ? 255 : ng);
              var nb = d[i + 2] + deltaB; d[i + 2] = nb < 0 ? 0 : (nb > 255 ? 255 : nb);
            }
          }
          ctx.putImageData(imgData, 0, 0);
        } catch (_) {}
      }

      var fakeToDataURL = ({
        toDataURL() { applyCanvasNoise(this); return origToDataURL.apply(this, arguments); }
      }).toDataURL;
      markNative(fakeToDataURL, 'toDataURL');
      try { HTMLCanvasElement.prototype.toDataURL = fakeToDataURL; } catch (_) {}

      if (origToBlob) {
        var fakeToBlob = ({
          toBlob(cb) { applyCanvasNoise(this); return origToBlob.apply(this, arguments); }
        }).toBlob;
        markNative(fakeToBlob, 'toBlob');
        try { HTMLCanvasElement.prototype.toBlob = fakeToBlob; } catch (_) {}
      }

      if (origGetImageData) {
        var fakeGetImageData = ({
          getImageData(sx, sy, sw, sh) {
            if (this && this.canvas) applyCanvasNoise(this.canvas);
            return origGetImageData.apply(this, arguments);
          }
        }).getImageData;
        markNative(fakeGetImageData, 'getImageData');
        try { CanvasRenderingContext2D.prototype.getImageData = fakeGetImageData; } catch (_) {}
      }
    }

    // ========== 5. AudioContext 确定性微扰 ==========
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
      var origGetChannelData = AudioBuffer.prototype.getChannelData;
      var noisedBuffers = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      var cachedChannels = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
      var fakeGetChannelData = ({
        getChannelData(ch) {
          var data = origGetChannelData.apply(this, arguments);
          if (!data || !data.length) return data;
          var channelIndex = typeof ch === 'number' ? ch : 0;
          if (cachedChannels) {
            var bufMap = cachedChannels.get(this);
            if (bufMap && bufMap.has(channelIndex)) return bufMap.get(channelIndex);
          }
          if (noisedBuffers) {
            if (noisedBuffers.has(data)) return data;
            noisedBuffers.add(data);
          }
          var aSeed = FP.audioSeed || 12345;
          var step = Math.max(1, Math.floor(data.length / 100));
          var copy = new Float32Array(data);
          for (var i = 0; i < copy.length; i += step) {
            var noise = (((i * 17 + aSeed) % 10) - 5) * 1e-7;
            copy[i] += noise;
          }
          if (cachedChannels) {
            var map = cachedChannels.get(this);
            if (!map) { map = new Map(); cachedChannels.set(this, map); }
            map.set(channelIndex, copy);
          }
          return copy;
        }
      }).getChannelData;
      markNative(fakeGetChannelData, 'getChannelData');
      try { AudioBuffer.prototype.getChannelData = fakeGetChannelData; } catch (_) {}
    }
  } catch (_) {}
})();
  `;
}
