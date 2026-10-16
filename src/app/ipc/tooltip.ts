/**
 * IPC：全局 tooltip 独立窗口
 * 壳页面（渲染进程）请求显示/隐藏 tooltip；主进程负责定位与显示。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { showTooltip, measureTooltip, hideTooltip } from '../tooltip-window.js';

const require = createRequire(import.meta.url);
const { ipcMain, BrowserWindow } = require('electron');

/** 由 sender（壳页面）反查其所在主窗口 */
function winOf(event: any): any {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx && ctx.win && !ctx.win.isDestroyed()) return ctx.win;
  } catch (_) { /* ignore */ }
  try { return BrowserWindow.fromWebContents(event.sender); } catch (_) { return null; }
}

function registerTooltipIpc(): void {
  ipcMain.on('tooltip-show', (event: any, payload: any) => {
    const win = winOf(event);
    if (win) showTooltip(win, payload);
  });
  ipcMain.on('tooltip-hide', (event: any) => {
    const win = winOf(event);
    if (win) hideTooltip(win);
  });
  // tooltip 窗口回传测量尺寸（sender 是 tooltip 窗口 → 取其 parent 主窗口）
  ipcMain.on('tooltip-measure', (event: any, size: any) => {
    try {
      const tipWin = BrowserWindow.fromWebContents(event.sender);
      const parent = tipWin ? tipWin.getParentWindow() : null;
      if (parent && !parent.isDestroyed()) measureTooltip(parent, size);
    } catch (_) { /* ignore */ }
  });
}

export { registerTooltipIpc };
