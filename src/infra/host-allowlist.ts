/**
 * Host 白名单（X-001 第一层：主进程无感硬校验）
 *
 * 所有执行面 IPC 在主进程入口校验：event.senderFrame.url 必须是
 *  - 已注册 provider 的域名（matchers：providers/registry 的 matchesUrl），或
 *  - 本应用自有窗口（file://、data:、about:blank）。
 * 否则一律拒绝（防第三方页面/导航逃逸页面后调执行面）。
 *
 * 纯函数、不依赖 electron，便于单测；classifySender 的组装在 app 层。
 */

/** 本应用自有窗口允许的协议 */
const OWN_WINDOW_PROTOCOLS = new Set(['file:', 'data:']);

/**
 * 判断 URL 是否属于本应用自有窗口（file://、data:、about:blank）。
 * 自定义协议是否加入由 C 层（app）核对 protocol.register 后决定；
 * 当前默认放行这三类。
 */
export function isOwnWindowUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let u: URL;
  try { u = new URL(url); } catch (_) { return false; }
  if (OWN_WINDOW_PROTOCOLS.has(u.protocol)) return true;
  if (u.protocol === 'about:' && (u.pathname === 'blank' || u.href === 'about:blank')) return true;
  return false;
}

/**
 * 判断 URL 是否命中任一 provider matcher。
 * @param url 完整 URL
 * @param matchers provider.matchesUrl 列表（由 app 层 getAllProviders 注入）
 */
export function isProviderHost(url: string, matchers: Array<(u: string) => boolean>): boolean {
  if (typeof url !== 'string' || !Array.isArray(matchers)) return false;
  for (const m of matchers) {
    try {
      if (typeof m === 'function' && m(url)) return true;
    } catch (_) { /* 单个 matcher 异常不影响其余 */ }
  }
  return false;
}

export interface SenderUrlCheck {
  ok: boolean;
  kind: 'provider' | 'own-window' | 'unknown';
  host?: string;
  reason?: string;
}

/**
 * 综合校验 sender URL：http(s) 必须命中 provider；其余协议必须是自有窗口。
 * 解析失败 / 不在白名单 → unknown（ok=false）。
 */
export function checkSenderUrl(url: string, matchers: Array<(u: string) => boolean>): SenderUrlCheck {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, kind: 'unknown', reason: 'empty sender url' };
  }
  let u: URL;
  try { u = new URL(url); } catch (_) {
    return { ok: false, kind: 'unknown', reason: 'url parse failed: ' + url };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (isProviderHost(url, matchers)) {
      return { ok: true, kind: 'provider', host: u.hostname };
    }
    return { ok: false, kind: 'unknown', host: u.hostname, reason: 'host not in provider allowlist: ' + u.hostname };
  }
  if (isOwnWindowUrl(url)) {
    return { ok: true, kind: 'own-window', host: u.hostname || u.protocol };
  }
  return { ok: false, kind: 'unknown', reason: 'non http(s) and not own-window: ' + u.protocol };
}
