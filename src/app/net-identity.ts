/**
 * 每窗口网络身份：代理 + 时区/语言/地理位置伪装 + WebRTC 防护
 *
 * 作用域（全部是 profile/partition 级，天然多窗口隔离）：
 *  - 代理：session.setProxy → partition 内所有请求（AI 页面 / harness / 壳）
 *  - 时区/语言/位置：CDP Emulation → Chromium 原生，零 JS 指纹风险
 *  - WebRTC：CDP Page.addScriptToEvaluateOnNewDocument → 主世界注入，防 UDP 直连泄露
 *
 * 关键设计：
 *  - 每个异步步骤都有超时（setProxy 5s / CDP 3s / 探测 6s），绝不挂死调用方
 *    （否则 entry.ts 的 loadPage 永不执行 → 窗口白屏 url:""）。
 *  - 时区/语言/经纬度默认由「自动跟随出口 IP」探测填入，用户可在高级区域手动覆盖。
 *  - 自动探测用 ses.fetch（自动走该 session 配置的代理），从出口视角看 IP 归属。
 *
 * 已知限制：CDP debugger 与 DevTools 互斥。用户按 F12 时先 detach（Emulation 暂失效）。
 */
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import { buildChromeUserAgent, buildUserAgentMetadata } from '../infra/user-agent.js';
import { buildFingerprintScript, normalizeFingerprintConfig, type FingerprintConfig } from './fingerprint.js';

const require = createRequire(import.meta.url);

/** 代理配置（持久化在 profile.proxy） */
interface ProxyConfig {
  enabled: boolean;
  /** 代理地址，如 "http://127.0.0.1:41576" 或 "socks5://127.0.0.1:7890" */
  rules: string;
  /** 绕过代理的规则，默认 "<local>,localhost,127.0.0.1" */
  bypass: string;
  /** 自动跟随出口 IP：true 时保存会通过代理探测出口国，自动填 timezone/locale/经纬度 */
  autoGeo?: boolean;
  /** IANA 时区，如 "America/Los_Angeles"（autoGeo 时自动填） */
  timezone?: string;
  /** BCP47 语言，如 "en-US"（autoGeo 时自动填） */
  locale?: string;
  /** 地理位置纬度（autoGeo 时自动填） */
  latitude?: number;
  /** 地理位置经度（autoGeo 时自动填） */
  longitude?: number;
  /** WebRTC 策略：spoof=伪造 mDNS / disable=禁用 / off=不处理 */
  webrtc: 'spoof' | 'disable' | 'off';
}

const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  rules: '',
  bypass: '<local>,localhost,127.0.0.1',
  autoGeo: true,      // 默认自动跟随出口 IP（用户无需手填时区/语言）
  // 默认 off：不给未启用代理的普通窗口注入 WebRTC 脚本 / attach debugger，
  // 保持原生行为（避免"新窗口凭空多一层 hook"）。用户明确选 spoof/disable 才生效。
  webrtc: 'off',
};

/** 规范化用户输入，防御脏数据 */
function normalizeProxyConfig(input: any): ProxyConfig {
  const cfg: ProxyConfig = { ...DEFAULT_PROXY };
  if (!input || typeof input !== 'object') return cfg;
  if (typeof input.enabled === 'boolean') cfg.enabled = input.enabled;
  if (typeof input.rules === 'string') cfg.rules = input.rules.trim();
  if (typeof input.bypass === 'string') cfg.bypass = input.bypass.trim() || DEFAULT_PROXY.bypass;
  if (typeof input.autoGeo === 'boolean') cfg.autoGeo = input.autoGeo;
  if (typeof input.timezone === 'string') cfg.timezone = input.timezone.trim() || undefined;
  if (typeof input.locale === 'string') cfg.locale = input.locale.trim() || undefined;
  if (typeof input.latitude === 'number' && isFinite(input.latitude)) cfg.latitude = input.latitude;
  if (typeof input.longitude === 'number' && isFinite(input.longitude)) cfg.longitude = input.longitude;
  if (input.webrtc === 'spoof' || input.webrtc === 'disable' || input.webrtc === 'off') {
    cfg.webrtc = input.webrtc;
  } else if (cfg.enabled) {
    // 启用代理但未明确指定时，默认推荐 spoof（防 WebRTC / DNS 泄露）
    cfg.webrtc = 'spoof';
  }
  return cfg;
}

// ========== 0. 工具 ==========

/** 给 Promise 加超时（防止 setProxy / sendCommand 挂起拖死窗口加载） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时 ' + ms + 'ms')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 国家代码 → 常见 BCP47 语言（自动跟随 IP 时用） */
function countryToLocale(cc: string): string {
  const map: Record<string, string> = {
    US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ',
    JP: 'ja-JP', KR: 'ko-KR', SG: 'en-SG', HK: 'zh-HK', TW: 'zh-TW', CN: 'zh-CN',
    DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', NL: 'nl-NL',
    RU: 'ru-RU', BR: 'pt-BR', IN: 'en-IN', TH: 'th-TH', VN: 'vi-VN', MY: 'ms-MY',
    ID: 'id-ID', PH: 'en-PH', TR: 'tr-TR', PL: 'pl-PL', SE: 'sv-SE',
    AE: 'ar-AE', SA: 'ar-SA', IL: 'he-IL', ZA: 'en-ZA', MX: 'es-MX', AR: 'es-AR',
  };
  return map[(cc || '').toUpperCase()] || 'en-US';
}

/**
 * 将用户配置的代理规则转换为 Chromium 接受的格式。
 * 核心：Chromium 底层网络协议栈不识别 socks5h:// 协议头，直接传会导致 ERR_NO_SUPPORTED_PROXIES 或规则失效。
 * Chromium 的 socks5:// 原生即向代理发送域名进行远程 DNS 解析，
 * 因此将 socks5h:// 规范化映射为 socks5://。
 */
function toChromiumProxyRules(rules: string): string {
  if (!rules || typeof rules !== 'string') return '';
  return rules.trim()
    .replace(/\bsocks5h:\/\//gi, 'socks5://')
    .replace(/\bsocks5h=/gi, 'socks5=');
}

// ========== 0b. 代理连通性探测 ==========

/** 解析代理地址为 { host, port }；支持 "127.0.0.1:51081"（无协议时按 http） */
function parseProxyTarget(rules: string): { host: string; port: number } | null {
  let s = String(rules || '').trim();
  if (!s) return null;
  // 用户可能只填 "127.0.0.1:51081"（无协议头）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    const host = u.hostname;
    if (!host) return null;
    const proto = u.protocol.replace(':', '').toLowerCase();
    const defPort = proto === 'https' ? 443
      : (proto === 'socks4' || proto === 'socks4a' || proto === 'socks5' || proto === 'socks5h' || proto === 'socks' ? 1080 : 80);
    const port = u.port ? parseInt(u.port, 10) : defPort;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch (_) { return null; }
}

/**
 * TCP 探测代理端口是否可连（默认 2 秒超时，绝不挂起调用方）。
 * 只验证"端口活着"，不验证协议/认证/出口质量（那需要真实请求，代价太高）。
 * @returns true=端口可连；false=不可连或地址非法
 */
function checkProxyReachable(rules: string, timeoutMs = 2000): Promise<boolean> {
  const target = parseProxyTarget(rules);
  if (!target) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: any = null;
    let sock: any = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (timer) { try { clearTimeout(timer); } catch (_) {} }
      try { if (sock) sock.destroy(); } catch (_) {}
      resolve(ok);
    };
    try {
      sock = netConnect({ host: target.host, port: target.port });
    } catch (_) { finish(false); return; }
    timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

// ========== 1. 代理（session/partition 级） ==========

async function applySessionProxy(ses: any, cfg: ProxyConfig): Promise<void> {
  if (!ses) return;
  // setProxy 在网络栈操作时偶发挂起（代理暂不可达、session 初始化中）。
  // 必须加超时，否则 entry.ts 的 loadPage 被永久阻塞 → 窗口白屏（url: ""）。
  try {
    if (!cfg.enabled || !cfg.rules) {
      await withTimeout(ses.setProxy({ mode: 'direct' }), 5000, 'setProxy(direct)');
      console.log('[NetIdentity] 代理已关闭（直连）');
      return;
    }
    const chromiumRules = toChromiumProxyRules(cfg.rules);
    await withTimeout(
      ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: chromiumRules,
        proxyBypassRules: cfg.bypass || '<local>',
      }),
      5000,
      'setProxy(fixed)',
    );
    console.log('[NetIdentity] 代理已设置:', cfg.rules, '-> Chromium:', chromiumRules, '| bypass:', cfg.bypass);
  } catch (err: any) {
    console.error('[NetIdentity] 设置代理失败:', err && err.message);
  }
}

// ========== 2. 出口 IP 探测（自动跟随） ==========

/**
 * 通过该 session 的代理出口请求 IP 归属，返回时区/语言/经纬度。
 * 用 ses.fetch —— 会自动走该 session 配置的代理（正是"从出口看出去"）。
 * 主用 ipwho.is，备用 ip-api.com；各自 6 秒超时；均失败返回 null。
 */
async function detectExitGeo(ses: any): Promise<{
  ip?: string;
  country?: string;
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
} | null> {
  if (!ses || typeof ses.fetch !== 'function') return null;

  // 主源：ipwho.is
  try {
    const r = await withTimeout<any>(
      ses.fetch('https://ipwho.is/?fields=success,ip,country_code,timezone,latitude,longitude', { cache: 'no-store' }),
      6000,
      'ipwho.is',
    );
    const j: any = await r.json();
    if (j && j.success && j.timezone && j.timezone.id) {
      return {
        ip: j.ip,
        country: j.country_code,
        timezone: String(j.timezone.id),
        locale: countryToLocale(j.country_code),
        latitude: typeof j.latitude === 'number' ? j.latitude : undefined,
        longitude: typeof j.longitude === 'number' ? j.longitude : undefined,
      };
    }
  } catch (e: any) {
    console.warn('[NetIdentity] ipwho.is 探测失败:', e && e.message);
  }

  // 备用：ip-api.com
  try {
    const r = await withTimeout<any>(
      ses.fetch('http://ip-api.com/json/?fields=status,query,countryCode,timezone,lat,lon', { cache: 'no-store' }),
      6000,
      'ip-api.com',
    );
    const j: any = await r.json();
    if (j && j.status === 'success' && j.timezone) {
      return {
        ip: j.query,
        country: j.countryCode,
        timezone: String(j.timezone),
        locale: countryToLocale(j.countryCode),
        latitude: typeof j.lat === 'number' ? j.lat : undefined,
        longitude: typeof j.lon === 'number' ? j.lon : undefined,
      };
    }
  } catch (e: any) {
    console.warn('[NetIdentity] ip-api.com 探测失败:', e && e.message);
  }

  return null;
}

// ========== 3. 网络隐私盾脚本（CDP 主世界：DNS 泄露防护 + WebRTC 伪装） ==========

/** 构建主世界隐私盾脚本：彻底免疫 DNS 预取/预连接泄露，阻断/伪装 WebRTC STUN */
function buildShieldScript(cfg: ProxyConfig, fp?: FingerprintConfig): string {
  const dnsShield = String.raw`
    try {
      var meta = document.createElement('meta');
      meta.httpEquiv = 'x-dns-prefetch-control';
      meta.content = 'off';
      if (document.head) {
        document.head.prepend(meta);
      } else if (document.documentElement) {
        document.documentElement.prepend(meta);
      }
    } catch (_) {}

    try {
      var origRelDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'rel');
      if (origRelDesc && origRelDesc.set) {
        Object.defineProperty(HTMLLinkElement.prototype, 'rel', {
          configurable: true,
          enumerable: origRelDesc.enumerable,
          get: function() { return origRelDesc.get.call(this); },
          set: function(v) {
            var s = String(v || '').toLowerCase();
            if (s.indexOf('dns-prefetch') >= 0 || s.indexOf('preconnect') >= 0) {
              try { this.removeAttribute('href'); } catch (_) {}
              return origRelDesc.set.call(this, 'stylesheet-disabled');
            }
            return origRelDesc.set.call(this, v);
          }
        });
      }
    } catch (_) {}

    try {
      var origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, val) {
        if (this instanceof HTMLLinkElement && String(name).toLowerCase() === 'rel') {
          var s = String(val || '').toLowerCase();
          if (s.indexOf('dns-prefetch') >= 0 || s.indexOf('preconnect') >= 0) {
            try { this.removeAttribute('href'); } catch (_) {}
            return;
          }
        }
        return origSetAttr.apply(this, arguments);
      };
    } catch (_) {}

    function sanitizeNode(n) {
      if (!n || n.nodeType !== 1) return;
      if (n.nodeName === 'LINK') {
        var r = (n.getAttribute('rel') || n.rel || '').toLowerCase();
        if (r.indexOf('dns-prefetch') >= 0 || r.indexOf('preconnect') >= 0) {
          try { n.removeAttribute('href'); } catch (_) {}
          try { n.removeAttribute('rel'); } catch (_) {}
          n.rel = '';
          n.href = '';
        }
      }
    }

    try {
      var origAppend = Node.prototype.appendChild;
      Node.prototype.appendChild = function(child) {
        sanitizeNode(child);
        return origAppend.apply(this, arguments);
      };
      var origInsert = Node.prototype.insertBefore;
      Node.prototype.insertBefore = function(newChild, refChild) {
        sanitizeNode(newChild);
        return origInsert.apply(this, arguments);
      };
    } catch (_) {}

    try {
      var observer = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          for (var j = 0; j < m.addedNodes.length; j++) {
            var node = m.addedNodes[j];
            if (node && node.nodeType === 1) {
              sanitizeNode(node);
              if (node.querySelectorAll) {
                var links = node.querySelectorAll('link');
                for (var k = 0; k < links.length; k++) sanitizeNode(links[k]);
              }
            }
          }
        }
      });
      var root = document.documentElement || document;
      if (root) {
        observer.observe(root, { childList: true, subtree: true });
      } else {
        window.addEventListener('DOMContentLoaded', function() {
          if (document.documentElement) {
            observer.observe(document.documentElement, { childList: true, subtree: true });
          }
        });
      }
    } catch (_) {}
  `;

  let rtcPart = '';
  if (cfg.webrtc === 'disable') {
    rtcPart = String.raw`
      function Disabled() { throw new Error('WebRTC is not supported'); }
      var Native = window.RTCPeerConnection;
      if (Native) Disabled.prototype = Native.prototype;
      try { Object.defineProperty(Disabled, 'name', { value: 'RTCPeerConnection', configurable: true }); } catch (e) {}
      try { Disabled.toString = function() { return 'function RTCPeerConnection() { [native code] }'; }; } catch (e) {}
      window.RTCPeerConnection = Disabled;
      window.webkitRTCPeerConnection = Disabled;
    `;
  } else if (cfg.webrtc === 'spoof') {
    const mdnsSeed = (fp && fp.canvasSeed) ? fp.canvasSeed : 31415926;
    rtcPart = String.raw`
      var Native = window.RTCPeerConnection;
      if (Native) {
        var HEX = '0123456789abcdef';
        var seedState = ${mdnsSeed};
        function mdns() {
          var s = '';
          var state = seedState;
          for (var i = 0; i < 32; i++) {
            state = ((state * 1103515245 + 12345) & 0x7FFFFFFF);
            s += HEX.charAt((state >> 16) & 0x0F);
          }
          return s + '.local';
        }
        function Fake(cfg, cons) {
          var modified = {};
          if (cfg) for (var k in cfg) modified[k] = cfg[k];
          modified.iceServers = [];   // 断掉 STUN/TURN，防止真实公网 IP 泄露
          var pc = new Native(modified, cons);

          var origAdd = pc.addEventListener.bind(pc);
          var origRemove = pc.removeEventListener.bind(pc);
          var listenerMap = typeof WeakMap !== 'undefined' ? new WeakMap() : new Map();

          pc.addEventListener = function(type, listener, opts) {
            if (type === 'icecandidate' && typeof listener === 'function') {
              var listenerHandled = false;
              var wrapped = function(ev) {
                if (!ev || !ev.candidate) {
                  // 原生发出 null candidate 代表 ICE 收集完毕，必须透传给 listener，否则 WebRTC 永远卡在 gathering
                  try { listener.call(pc, ev); } catch (e) {}
                  return;
                }
                if (listenerHandled) return;
                listenerHandled = true;
                try {
                  var fake = new RTCIceCandidate({
                    candidate: 'candidate:1 1 udp 2113937151 ' + mdns() + ' 54400 typ host generation 0',
                    sdpMid: ev.candidate.sdpMid,
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                  });
                  // 继承原生事件对象原型链，保证 instanceof RTCPeerConnectionIceEvent 检验通过
                  var fakeEv = Object.create(ev);
                  Object.defineProperty(fakeEv, 'candidate', { value: fake, enumerable: true });
                  listener.call(pc, fakeEv);
                } catch (e) {
                  try { listener.call(pc, ev); } catch (_) {}
                }
              };
              listenerMap.set(listener, wrapped);
              return origAdd(type, wrapped, opts);
            }
            return origAdd(type, listener, opts);
          };

          pc.removeEventListener = function(type, listener, opts) {
            if (type === 'icecandidate' && typeof listener === 'function') {
              var wrapped = listenerMap.get(listener);
              if (wrapped) {
                listenerMap.delete(listener);
                return origRemove(type, wrapped, opts);
              }
            }
            return origRemove(type, listener, opts);
          };

          var onHandler = null;
          try {
            Object.defineProperty(pc, 'onicecandidate', {
              configurable: true,
              enumerable: true,
              set: function(fn) {
                if (onHandler) {
                  try { pc.removeEventListener('icecandidate', onHandler); } catch (e) {}
                }
                onHandler = (typeof fn === 'function') ? fn : null;
                if (onHandler) {
                  try { pc.addEventListener('icecandidate', onHandler); } catch (e) {}
                }
              },
              get: function() { return onHandler; }
            });
          } catch (e) {}
          try {
            var origSetConf = pc.setConfiguration.bind(pc);
            pc.setConfiguration = function(conf) {
              var mod = {};
              if (conf) for (var k in conf) mod[k] = conf[k];
              mod.iceServers = [];
              return origSetConf(mod);
            };
          } catch (e) {}
          return pc;
        }
        Fake.prototype = Native.prototype;
        try { Object.defineProperty(Fake, 'name', { value: 'RTCPeerConnection', configurable: true }); } catch (e) {}
        try {
          Fake.toString = function() { return 'function RTCPeerConnection() { [native code] }'; };
        } catch (e) {}
        window.RTCPeerConnection = Fake;
        window.webkitRTCPeerConnection = Fake;
      }
    `;
  }

  return `(function(){
    try {
      if (window.__cuckooShieldInjected) return;
      window.__cuckooShieldInjected = true;
      ${dnsShield}
      ${rtcPart}
    } catch (e) {}
  })();`;
}

// ========== 4. CDP debugger 管理 ==========

interface CdpState {
  attached: boolean;
  scriptId: string | null;
}
const cdpStates = new WeakMap<any, CdpState>();

async function ensureDebugger(wc: any): Promise<CdpState | null> {
  if (!wc || wc.isDestroyed()) return null;
  let st = cdpStates.get(wc);
  if (!st) { st = { attached: false, scriptId: null }; cdpStates.set(wc, st); }
  // 首次创建的 WebContentsView 处于未导航状态，Chromium 的 RenderFrameHost 尚未激活，
  // 会导致后续 Page.enable 与 addScript 挂起超时。先轻量导航到 about:blank 唤醒渲染管线。
  try {
    const curUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
    if (!curUrl || curUrl === '') {
      await wc.loadURL('about:blank');
    }
  } catch (_) {}

  try {
    wc.debugger.attach('1.3');
    st.attached = true;
    return st;
  } catch (err: any) {
    console.warn('[NetIdentity] debugger.attach 失败:', err && err.message);
    return null;
  }
}


/** 释放 CDP（DevTools 打开前调用，解除占用） */
function releaseDebugger(wc: any): void {
  if (!wc || wc.isDestroyed()) return;
  try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch (_) {}
  const st = cdpStates.get(wc);
  if (st) { st.attached = false; st.scriptId = null; }
}

// ========== 5. 统一入口 ==========

async function applyNetIdentity(view: any, cfg: ProxyConfig, fpCfg?: FingerprintConfig | null): Promise<void> {
  const ses = view && view.webContents && view.webContents.session;
  const wc = view && view.webContents;

  // 1. 代理（session 级，幂等 + 超时保护）
  await applySessionProxy(ses, cfg);

  // 1b. WebRTC 底层网络策略（物理阻断非代理 UDP 直连与 DNS 泄露）：
  //     启用代理且 webrtc !== 'off' 时，强制禁止非代理 UDP（WebRTC 流量只能走代理 TCP 或直接阻断发包，掐断本地 STUN DNS 查询）；
  //     代理未启用且 webrtc === 'off' 时恢复 'default'。
  if (wc && typeof wc.setWebRTCIPHandlingPolicy === 'function') {
    try {
      const policy = (cfg.enabled && cfg.webrtc !== 'off') ? 'disable_non_proxied_udp' : 'default';
      wc.setWebRTCIPHandlingPolicy(policy);
    } catch (err: any) {
      console.warn('[NetIdentity] setWebRTCIPHandlingPolicy 失败:', err && err.message);
    }
  }

  // 2. 是否需要 CDP
  const fp = (fpCfg && typeof fpCfg === 'object') ? normalizeFingerprintConfig(fpCfg) : null;
  const hasFingerprint = !!(fp && fp.enabled);
  const hasProxy = !!(cfg.enabled && cfg.rules);
  const hasWebRTC = cfg.webrtc === 'spoof' || cfg.webrtc === 'disable';
  const hasEmulation = !!(cfg.timezone || cfg.locale ||
    (typeof cfg.latitude === 'number' && typeof cfg.longitude === 'number'));
  const needShield = hasProxy || hasWebRTC || hasFingerprint;
  // 若从未 attach 过且完全无配置，无需 attach（省一次 target 交互）
  if (!needShield && !hasEmulation && !hasFingerprint && !cdpStates.has(wc)) return;
  if (!wc || wc.isDestroyed()) return;

  const st = await ensureDebugger(wc);
  if (!st) return;
  const dbg = wc.debugger;

  // 3. 启用 Page domain（addScriptToEvaluateOnNewDocument 依赖 Page.enable）。
  //    漏了这一步时命令在某些环境下会挂起，导致后续全部超时。
  try {
    await withTimeout(dbg.sendCommand('Page.enable', {}), 3000, 'Page.enable');
  } catch (err: any) { console.warn('[NetIdentity] Page.enable 失败:', err && err.message); }

  // 3b. 恢复原生窗口视口布局（绝不使用 Emulation.setDeviceMetricsOverride 锁死视口，
  // 否则会导致网页脱离窗口自适应排版、被硬性放大、偏左无法居中）。屏幕指标已在主世界脚本中原生伪装。
  try {
    await withTimeout(dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {}), 3000, 'clearDeviceMetricsOverride');
  } catch (_) {}


  // 4. 时区/语言/位置：即使配置为空也显式清除旧覆盖（否则从"设了"→"不设"后仍卡住）。
  try {
    if (cfg.timezone) {
      await withTimeout(dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: cfg.timezone }), 3000, 'setTimezoneOverride');
      console.log('[NetIdentity] 时区:', cfg.timezone);
    } else {
      await withTimeout(dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' }), 3000, 'clearTimezoneOverride');
    }
  } catch (err: any) {
    if (cfg.timezone) console.warn('[NetIdentity] setTimezoneOverride 失败:', err && err.message);
  }

  try {
    if (cfg.locale) {
      await withTimeout(dbg.sendCommand('Emulation.setLocaleOverride', { locale: cfg.locale }), 3000, 'setLocaleOverride');
      console.log('[NetIdentity] 语言(Intl):', cfg.locale);
    } else {
      await withTimeout(dbg.sendCommand('Emulation.setLocaleOverride', { locale: '' }), 3000, 'clearLocaleOverride');
    }
  } catch (err: any) {
    if (cfg.locale) console.warn('[NetIdentity] setLocaleOverride 失败:', err && err.message);
  }

  // 4b. navigator.language / languages + HTTP Accept-Language：
  try {
    const meta = buildUserAgentMetadata();
    const platMap: Record<string, string> = { Windows: 'Win32', macOS: 'MacIntel', Linux: 'Linux x86_64' };
    const uaPayload: any = {
      userAgent: buildChromeUserAgent(),
      acceptLanguage: cfg.locale || '',
      platform: platMap[meta.platform] || 'Win32',
    };
    if (cfg.locale) uaPayload.userAgentMetadata = meta;
    await withTimeout(dbg.sendCommand('Emulation.setUserAgentOverride', uaPayload), 3000, 'setUserAgentOverride');
    if (cfg.locale) console.log('[NetIdentity] 语言(Accept-Language):', cfg.locale);
  } catch (err: any) { console.warn('[NetIdentity] setUserAgentOverride 失败:', err && err.message); }

  try {
    if (typeof cfg.latitude === 'number' && typeof cfg.longitude === 'number') {
      await withTimeout(dbg.sendCommand('Emulation.setGeolocationOverride', {
        latitude: cfg.latitude,
        longitude: cfg.longitude,
        accuracy: 100,
      }), 3000, 'setGeolocationOverride');
      console.log('[NetIdentity] 地理位置:', cfg.latitude + ',' + cfg.longitude);
    } else {
      await withTimeout(dbg.sendCommand('Emulation.clearGeolocationOverride', {}), 3000, 'clearGeolocationOverride');
    }
  } catch (err: any) { console.warn('[NetIdentity] 地理位置覆盖失败:', err && err.message); }

  // 5. 网络隐私盾与硬件指纹防护盾：合并脚本注入
  if (st.scriptId) {
    try {
      await withTimeout(dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: st.scriptId }), 3000, 'removeScript');
    } catch (_) {}
    st.scriptId = null;
  }
  if (needShield) {
    let fullScript = '';
    if (hasProxy || hasWebRTC) {
      fullScript += buildShieldScript(cfg, fp || undefined) + '\n';
    }
    if (hasFingerprint && fp) {
      fullScript += buildFingerprintScript(fp) + '\n';
    }
    if (fullScript.trim()) {
      try {
        const res: any = await withTimeout(dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: fullScript }), 3000, 'addScript');
        st.scriptId = (res && res.identifier) || null;
        // 立即在当前文档上下文执行一次
        try {
          await withTimeout(dbg.sendCommand('Runtime.evaluate', { expression: fullScript }), 1000, 'evalShield');
        } catch (_) {}
        console.log('[NetIdentity] 隐私与指纹盾已就绪 (DNS=' + (hasProxy ? 'on' : 'off') + ', WebRTC=' + cfg.webrtc + ', 指纹=' + (hasFingerprint ? fp?.presetId : 'off') + ')');
      } catch (err: any) {
        console.warn('[NetIdentity] 注入盾牌脚本失败:', err && err.message);
      }
    }
  }

  console.log('[NetIdentity] 已应用: proxy=' + (cfg.enabled ? cfg.rules : '(直连)') +
    ' tz=' + (cfg.timezone || '-') + ' lang=' + (cfg.locale || '-') + ' rtc=' + cfg.webrtc +
    ' fp=' + (hasFingerprint ? fp?.presetId : '(未启用)'));
}

export {
  type ProxyConfig,
  type FingerprintConfig,
  DEFAULT_PROXY,
  toChromiumProxyRules,
  normalizeProxyConfig,
  checkProxyReachable,
  applyNetIdentity,
  releaseDebugger,
  detectExitGeo,
  countryToLocale,
};


