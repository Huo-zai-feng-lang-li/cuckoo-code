/**
 * 动态生成"普通 Chrome" User-Agent 与客户端提示。
 *
 * 背景：Electron 内嵌浏览器若 UA 与真实内核版本不一致（如写死 Chrome 130，
 * 实际内核是 Chrome 152），Google 等站点会因 UA/sec-ch-ua 矛盾判定"浏览器不安全"，
 * 拒绝登录。故改为从 process.versions.chrome 动态取真实版本。
 *
 * 平台一致性（需求 100）：UA / sec-ch-ua-platform / userAgentData 三者必须与
 * 原生 navigator.platform 指向同一系统。此前全部写死 Windows，macOS 用户
 * UA 说 Windows、navigator.platform 说 MacIntel —— 一眼假。现按 process.platform 生成。
 *
 * 主进程可用（依赖 process.versions / process.platform）。preload 同样可用。
 */

/** 取主版本号（如 "152.0.7977.130" → "152"） */
function chromeMajor(): string {
  const v = (process.versions && process.versions.chrome) || '';
  const m = v.match(/^(\d+)/);
  return m ? m[1] : '0';
}

/** 取完整内核版本（如 "152.0.7977.130"） */
function chromeFullVersion(): string {
  const v = (process.versions && process.versions.chrome) || '';
  return v || (chromeMajor() + '.0.0.0');
}

/** 平台类别（与 navigator.platform 保持同一来源，避免自相矛盾） */
function platformKind(): 'win' | 'mac' | 'linux' {
  const p = process.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'linux') return 'linux';
  return 'win';
}

/**
 * 生成普通 Chrome UA（去掉 Electron 标识，内核版本与真实一致，平台与真实一致）。
 * 格式对齐真实 Chrome：Chrome/{主版本}.0.0.0
 */
function buildChromeUserAgent(): string {
  const major = chromeMajor();
  const tail = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
  const k = platformKind();
  if (k === 'mac') return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + tail;
  if (k === 'linux') return 'Mozilla/5.0 (X11; Linux x86_64) ' + tail;
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' + tail;
}

/**
 * 生成与 UA 匹配的 Chrome 客户端提示请求头（Sec-CH-UA*）。
 *
 * 为什么需要：Electron 默认发的 sec-ch-ua 缺少 "Google Chrome" 品牌，
 * Google 据此判定"浏览器或应用不安全"而拒绝登录。按真实 Chrome 补齐。
 */
function buildClientHintsHeaders(): Record<string, string> {
  const m = chromeMajor();
  const k = platformKind();
  const plat = k === 'mac' ? '"macOS"' : (k === 'linux' ? '"Linux"' : '"Windows"');
  return {
    'sec-ch-ua': '"Google Chrome";v="' + m + '", "Chromium";v="' + m + '", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': plat,
  };
}

/**
 * 生成修正 navigator.userAgentData / webdriver 的主世界脚本。
 * 必须在页面脚本之前注入（preload 阶段），否则会被页面抢先读到 Electron 默认值。
 *
 * 需求 100 改动：
 *  - 删除 chrome.loadTimes / chrome.csi 的伪造（Chrome 64 已移除，伪造它们比不伪造更可疑）
 *  - userAgentData 从"整体伪造"改为"最小覆盖"：只补 brands / fullVersionList 里缺的
 *    Google Chrome 品牌，platform / platformVersion / mobile 一律透传原生值
 *  - 增加「轮询重试」：实测 navigator.userAgentData 在 preload 早期可能尚未初始化，
 *    此前一次性执行会静默跳过、覆盖从未生效（真机探针实证 instanceOwnBrands=false）。
 *    现改为原型 getter + 实例 getter 双保险，并对 userAgentData 缺失时轮询重试（最多 1s）
 */
function buildUserAgentDataFix(): string {
  const m = chromeMajor();
  const full = chromeFullVersion();
  return `(function(){
  try {
    var MAJOR = "${m}";
    var FULL = "${full}";
    // 幂等标记必须放闭包内：挂到 window 或原型上等于给页面留了个
    // "本页被 Cuckoo 改过指纹" 的显式标签，是比原问题更明显的特征。
    var hevPatched = false;
    var uadDone = false;

    function makeBrands() {
      return [
        { brand: "Google Chrome", version: MAJOR },
        { brand: "Chromium", version: MAJOR },
        { brand: "Not_A Brand", version: "24" }
      ];
    }
    function makeFullList() {
      return [
        { brand: "Google Chrome", version: FULL },
        { brand: "Chromium", version: FULL },
        { brand: "Not_A Brand", version: "24.0.0.0" }
      ];
    }
    function hasGoogleChrome(arr) {
      try {
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].brand === "Google Chrome") return true;
        }
      } catch (e) {}
      return false;
    }
    // 覆盖 brands getter；对象不可写时静默失败
    function patchBrands(obj) {
      if (!obj) return false;
      try {
        var getBrands = function() { return makeBrands(); };
        // 与 webdriver / getHighEntropyValues 保持一致：getter 也要伪装成原生，
        // 否则 Object.getOwnPropertyDescriptor(proto,'brands').get.toString() 一行露馅。
        try {
          Object.defineProperty(getBrands, "name", { value: "get brands", configurable: true });
          getBrands.toString = function() { return "function get brands() { [native code] }"; };
        } catch (e0) {}
        Object.defineProperty(obj, "brands", {
          get: getBrands,
          enumerable: true,
          configurable: true
        });
        return true;
      } catch (e) { return false; }
    }
    // 包装 getHighEntropyValues，只补 fullVersionList；幂等（不重复包装）
    function patchHighEntropy(obj) {
      if (!obj) return;
      try {
        if (hevPatched) return;
        var orig = obj.getHighEntropyValues;
        if (typeof orig !== "function") return;
        var patched = function(hints) {
          // 用 apply 保留调用时的 this：原生方法要求 this 是 NavigatorUAData 实例，
          // 若固化 obj（可能是原型）会抛 "Illegal invocation"。
          return orig.apply(this, arguments).then(function(r) {
            try {
              if (!r.fullVersionList || !hasGoogleChrome(r.fullVersionList)) {
                r.fullVersionList = makeFullList();
              }
            } catch (e2) {}
            return r;
          });
        };
        try { patched.toString = function() { return "function getHighEntropyValues() { [native code] }"; }; } catch (e3) {}
        // 必须用 defineProperty：原生 getHighEntropyValues 是原型上的只读方法，
        // 实例上的普通赋值在非严格模式下会静默失败（此前 fullVersionList 一直没被补就是这原因）。
        try {
          Object.defineProperty(obj, "getHighEntropyValues", {
            value: patched, writable: true, configurable: true, enumerable: false
          });
        } catch (e5) {}
        try {
          Object.defineProperty(patched, "name", { value: "getHighEntropyValues", configurable: true });
        } catch (e6) {}
        hevPatched = true;
      } catch (e) {}
    }

    // ---------- 1) userAgentData：最小覆盖，只补 Google Chrome 品牌 ----------
    // 原型 getter 对所有实例生效，优先打原型；实例再兜一次（防浏览器把 brands
    // 变成实例自有属性）。轮询重试解决 preload 早期 userAgentData 尚未初始化的问题。
    function applyUad() {
      var nav = (typeof navigator !== "undefined") ? navigator : null;
      if (!nav) return false;
      var uad = nav.userAgentData;
      if (!uad) return false;
      var cur = null;
      try { cur = uad.brands; } catch (e) {}
      // 若已含 Google Chrome（真实 Chrome 或此前已打过补丁），不必再伪造
      if (hasGoogleChrome(cur)) { uadDone = true; return true; }
      var proto = null;
      try { proto = Object.getPrototypeOf(uad); } catch (e) {}
      // ⚠️ 必须只打原型：实测 navigator.userAgentData 每次访问返回**新对象**，
      // 打在实例上的补丁随对象一起丢弃（此前 brands 生效只是因为它走原型 getter）。
      // 高熵方法打原型也安全，前提是包装里用 apply 保留调用时的 this（见 patchHighEntropy）。
      if (proto) { patchBrands(proto); patchHighEntropy(proto); }
      uadDone = true;
      return true;
    }
    if (!uadDone) {
      if (!applyUad()) {
        var tries = 0;
        var timer = setInterval(function() {
          tries++;
          if (applyUad() || tries >= 50) { try { clearInterval(timer); } catch (e) {} }
        }, 20);
      }
    }

    // ---------- 2) 抹除自动化标记 navigator.webdriver ----------
    var nav2 = (typeof navigator !== "undefined") ? navigator : null;
    if (nav2) {
      try {
        if (Object.prototype.hasOwnProperty.call(nav2, "webdriver")) {
          delete nav2.webdriver;
        }
      } catch (e) {}
      var navProto = Object.getPrototypeOf(nav2) || (typeof Navigator !== "undefined" ? Navigator.prototype : null);
      if (navProto) {
        try {
          if (nav2.webdriver !== false) {
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
      }
    }

    // ---------- 3) window.chrome：只补现代 Chrome 仍有的对象 ----------
    // ⚠️ 不要补 chrome.loadTimes / chrome.csi —— 两者在 Chrome 64 已移除，
    //    在高版本 UA 下出现它们本身就是强特征（需求 100 已移除）。
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
        // 高熵头只在站点通过 Accept-CH 请求后才由浏览器发出。
        // 原本没发就别硬加（真实 Chrome 也不会无条件发），原本发了就用我们的值替换，
        // 避免「删而不补」让 Client Hints 画像比真实 Chrome 少一项。
        let hadFullVersion = false;
        let hadFullVersionList = false;
        for (const k of Object.keys(h)) {
          const lk = k.toLowerCase();
          if (lk === 'sec-ch-ua-full-version') hadFullVersion = true;
          if (lk === 'sec-ch-ua-full-version-list') hadFullVersionList = true;
          if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-mobile' || lk === 'sec-ch-ua-platform' ||
              lk === 'sec-ch-ua-full-version' || lk === 'sec-ch-ua-full-version-list') {
            delete h[k];
          }
        }
        Object.assign(h, hints);
        const full = chromeFullVersion();
        const major = chromeMajor();
        if (hadFullVersion) h['sec-ch-ua-full-version'] = '"' + full + '"';
        if (hadFullVersionList) {
          h['sec-ch-ua-full-version-list'] =
            '"Google Chrome";v="' + full + '", "Chromium";v="' + full + '", "Not_A Brand";v="24.0.0.0"';
        }
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

