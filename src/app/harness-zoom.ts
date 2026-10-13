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
    // documentElement 上设 zoom，整页跟随；失败静默（页面可能尚未就绪）
    webContents.executeJavaScript('document.documentElement.style.zoom = ' + z + ';').catch(() => {});
  } catch (_) { /* ignore */ }
}
