/**
 * 平台 completion / stop 请求匹配（hook 共享纯函数）。
 *
 * 本模块被 esbuild 打包进各平台 hook 的自包含 IIFE（注入 AI 网页主世界），
 * 同时可被 vitest 在 Node 环境直接单测。不得引用 window/document/location——
 * 相对 URL 的基准 base 由调用方传入（hook 传 document.baseURI）。
 *
 * B-003：历史 DeepSeek 的 isCompletion / isStopStream 只比 pathname、不校验 host，
 * 页面主世界里任何脚本向 `https://任意域名/api/v0/chat/completion` 发 POST，其响应
 * 都会被当作 DeepSeek AI 回复解析并据此提取执行块。此处统一加 host 白名单，
 * 对齐 ChatGPT（chatgpt.com）/ Claude（claude.ai）。
 */

/**
 * 判断请求是否命中"指定平台 + 指定 method + 指定 pathname"的端点。
 * @param url 请求 URL（相对/绝对均可）
 * @param method HTTP 方法（不区分大小写）
 * @param base 相对 URL 的基准（hook 传 document.baseURI；Node 测试传字面量）
 * @param pathname 精确匹配的 pathname（如 /api/v0/chat/completion）
 * @param hostSnippets host 白名单子串列表；hostname 命中其一即放行；传空数组则不校验 host
 * @returns 是否命中
 */
function matchProviderEndpoint(
  url: any,
  method: any,
  base: string,
  pathname: string,
  hostSnippets: string[],
): boolean {
  if (!url) return false;
  if (String(method || 'GET').toUpperCase() !== 'POST') return false;
  try {
    var u = new URL(url, base);
    if (u.pathname !== pathname) return false;
    if (hostSnippets && hostSnippets.length) {
      var host = u.hostname || '';
      var ok = false;
      for (var i = 0; i < hostSnippets.length; i++) {
        if (host.indexOf(hostSnippets[i]) !== -1) { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  } catch (e) {
    // URL 解析失败（极少见）：退化到 pathname 子串匹配，与历史行为一致
    return String(url).indexOf(pathname) !== -1;
  }
}

export { matchProviderEndpoint };
