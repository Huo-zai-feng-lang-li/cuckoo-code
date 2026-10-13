/**
 * 纯净模式字号：把缩放应用到 harness 视图。
 *
 * 为什么不用 webContents.setZoomFactor：它是"视图缩放"，非整数倍（如 115%）时
 * Chromium 会把已光栅化的位图插值放大 → 文字模糊。改用 CSS `zoom`（布局缩放），
 * 元素按新尺寸重新布局并光栅化 → 保持清晰。
 *
 * 页面重载后 DOM 重置，需在 did-finish-load 再次调用（见 entry.ts）。
 */
export function applyHarnessZoom(webContents: any, zoom: number): void {
  if (!webContents || webContents.isDestroyed()) return;
  const z = Math.max(0.5, Math.min(2, Number(zoom) || 1));
  try {
    // zoom 只作用在 .app（主内容容器）上，不作用 documentElement：
    //  - .app 用 calc(100vw/zoom) / calc(100vh/zoom) 反向补偿尺寸，缩放后正好填满视口
    //  - tooltip / conv-nav 等 .app 外的 fixed 元素不受 zoom 影响，JS 定位坐标不错位
    const js = 'var app=document.querySelector(".app");'
      + 'if(app){app.style.zoom=' + z + ';app.style.setProperty("--ck-harness-zoom",' + z + ');}';
    webContents.executeJavaScript(js).catch(() => {});
  } catch (_) { /* ignore */ }
}
