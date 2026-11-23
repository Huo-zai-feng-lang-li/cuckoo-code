/**
 * 登录/OAuth 页面判定（纯函数，供 preload 在注入前调用）。
 *
 * 为什么独立成模块：同一判定要用于 overlay 初始化与平台 hook 注入两处，
 * 放在 entry.ts 内联容易出现一处加守卫、另一处漏加；独立纯函数可单测。
 *
 * 判定只认明确的 host / path，不用宽泛的 query 参数：
 * `redirect_uri` 在正常对话深链里也可能出现，按 query 判会把正常页误判成登录页。
 */
const AUTH_PATH_RE = /^\/(?:sign[-_]?in|sign[-_]?up|log[-_]?in|login|auth|oauth|sso|passport|account\/login|connect\/(?:oauth|qrconnect|authorize))(?:\/|$)/i;
const AUTH_HOST_RE = /^(?:open\.weixin\.qq\.com|accounts\.google\.com|login\.microsoftonline\.com|auth\.openai\.com)$/i;
/** 常见统一登录子域：auth.example.com / login.example.com / sso.example.com */
const AUTH_HOST_PREFIX_RE = /^(?:auth|login|accounts|sso|passport)\./i;

/** 判断当前 URL 是否登录/OAuth 页面；解析失败一律按非登录页处理，避免误跳过正常注入。 */
export function isAuthPage(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (AUTH_HOST_RE.test(u.hostname) || AUTH_HOST_PREFIX_RE.test(u.hostname)) return true;
    return AUTH_PATH_RE.test(u.pathname.toLowerCase());
  } catch (_) {
    return false;
  }
}
