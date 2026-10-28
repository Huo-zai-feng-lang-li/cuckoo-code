/**
 * 动态生成"普通 Chrome" User-Agent。
 *
 * 背景：Electron 内嵌浏览器若 UA 与真实内核版本不一致（如写死 Chrome 130，
 * 实际内核是 Chrome 152），Google 等站点会因 UA/sec-ch-ua 矛盾判定"浏览器不安全"，
 * 拒绝登录。故改为从 process.versions.chrome 动态取真实版本。
 *
 * 主进程可用（依赖 process.versions）。preload 不用。
 */

/** 取主版本号（如 "152.0.7977.130" → "152"） */
function chromeMajor(): string {
  const v = (process.versions && process.versions.chrome) || '';
  const m = v.match(/^(\d+)/);
  return m ? m[1] : '0';
}

/**
 * 生成普通 Chrome UA（去掉 Electron 标识，内核版本与真实一致）。
 * 格式对齐真实 Chrome：Chrome/{主版本}.0.0.0
 */
function buildChromeUserAgent(): string {
  const major = chromeMajor();
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
}

/** 取完整内核版本（如 "152.0.7977.130"） */
function chromeFullVersion(): string {
  const v = (process.versions && process.versions.chrome) || '';
  return v || (chromeMajor() + '.0.0.0');
}

/**
 * 生成与 UA 匹配的 Chrome 客户端提示请求头（Sec-CH-UA*）。
 *
 * 为什么需要：Electron 默认发的 sec-ch-ua 缺少 "Google Chrome" 品牌，
 * Google 据此判定"浏览器或应用不安全"而拒绝登录。按真实 Chrome 补齐。
 */
function buildClientHintsHeaders(): Record<string, string> {
  const m = chromeMajor();
  return {
    'sec-ch-ua': '"Google Chrome";v="' + m + '", "Chromium";v="' + m + '", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

/**
 * 生成修正 navigator.userAgentData / webdriver 的主世界脚本。
 * 必须在页面脚本之前注入（preload 阶段），否则会被页面抢先读到 Electron 默认值。
 */
function buildUserAgentDataFix(): string {
  const m = chromeMajor();
  const full = chromeFullVersion();
  return `(function(){
  try {
    var brands = [
      { brand: "Google Chrome", version: "${m}" },
      { brand: "Chromium", version: "${m}" },
      { brand: "Not_A Brand", version: "24" }
    ];
    var fullList = [
      { brand: "Google Chrome", version: "${full}" },
      { brand: "Chromium", version: "${full}" },
      { brand: "Not_A Brand", version: "24.0.0.0" }
    ];
    var uad = {
      brands: brands,
      mobile: false,
      platform: "Windows",
      getHighEntropyValues: function() {
        return Promise.resolve({
          architecture: "x86",
          bitness: "64",
          brands: brands,
          fullVersionList: fullList,
          mobile: false,
          model: "",
          platform: "Windows",
          platformVersion: "10.0.0",
          uaFullVersion: "${full}",
          wow64: false
        });
      },
      toJSON: function() {
        return { brands: brands, mobile: false, platform: "Windows" };
      }
    };
    var nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav) {
      try {
        if (Object.prototype.hasOwnProperty.call(nav, "webdriver")) {
          delete nav.webdriver;
        }
      } catch (e) {}
      var navProto = Object.getPrototypeOf(nav) || (typeof Navigator !== "undefined" ? Navigator.prototype : null);
      if (navProto) {
        try {
          if (nav.webdriver !== false) {
            var getWd = function() { return false; };
            try {
              Object.defineProperty(getWd, "name", { value: "get webdriver" });
              getWd.toString = function() { return "function get webdriver() { [native code] }"; };
            } catch (e) {}
            Object.defineProperty(navProto, "webdriver", {
              get: getWd,
              enumerable: true,
              configurable: true
            });
          }
        } catch (e) {}
        try {
          Object.defineProperty(navProto, "userAgentData", {
            get: function() { return uad; },
            enumerable: true,
            configurable: true
          });
        } catch (e) {
          try {
            Object.defineProperty(nav, "userAgentData", {
              get: function() { return uad; },
              configurable: true
            });
          } catch (e2) {}
        }
      } else {
        try {
          Object.defineProperty(nav, "userAgentData", {
            get: function() { return uad; },
            configurable: true
          });
        } catch (e) {}
      }
    }
    if (typeof window !== "undefined") {
      try {
        if (!window.chrome) { window.chrome = {}; }
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
            OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
            PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
            PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
            PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
            RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" }
          };
        }
        if (!window.chrome.loadTimes) { window.chrome.loadTimes = function() {}; }
        if (!window.chrome.csi) { window.chrome.csi = function() {}; }
        if (!window.chrome.app) {
          window.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" }
          };
        }
      } catch (e) {}
    }
  } catch (e) {}
})();`;
}

/**
 * 为指定 session 补齐 Chrome 客户端提示请求头（Sec-CH-UA*）。
 * Electron 默认的 sec-ch-ua 缺 "Google Chrome" 品牌，Google OAuth 据此判定
 * "浏览器或应用不安全"而拒绝登录。与 UA 修正配套使用。
 *
 * 注：ses 由调用方传入（electron session 对象），本函数不 import electron，
 * 保持 infra 层"只依赖 node 内置"的约束。同一 session 只注册一次（WeakSet 去重），
 * 避免 onBeforeSendHeaders（替换式单监听器）被重复注册互相覆盖。
 */
const clientHintsSessions = new WeakSet<object>();

function ensureClientHints(ses: any): void {
  if (!ses || clientHintsSessions.has(ses)) return;
  clientHintsSessions.add(ses);
  try {
    const hints = buildClientHintsHeaders();
    ses.webRequest.onBeforeSendHeaders((details: any, callback: any) => {
      try {
        const h = details.requestHeaders || {};
        for (const k of Object.keys(h)) {
          const lk = k.toLowerCase();
          if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-mobile' || lk === 'sec-ch-ua-platform' ||
              lk === 'sec-ch-ua-full-version' || lk === 'sec-ch-ua-full-version-list') {
            delete h[k];
          }
        }
        Object.assign(h, hints);
        callback({ requestHeaders: h });
      } catch (_) {
        callback({ requestHeaders: details.requestHeaders });
      }
    });
  } catch (err: any) {
    console.error('[Cuckoo] 注册客户端提示请求头失败:', err && err.message);
  }
}

export { buildChromeUserAgent, chromeMajor, buildClientHintsHeaders, buildUserAgentDataFix, ensureClientHints };
