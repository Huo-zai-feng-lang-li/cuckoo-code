/**
 * IPC：底部状态栏「最近使用」全局存储（跨窗口共享）。
 * 壳页面通过 window.shellAPI 调用。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { loadRecent, addRecent, removeRecent, type RecentType } from '../recent-tools.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 广播最近列表变化给所有窗口壳页面 */
function broadcast(): void {
  for (const ctx of windowState.getAllContexts()) {
    try {
      if (ctx && ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('shell-recent-changed');
    } catch (_) { /* ignore */ }
  }
}

function registerRecentIpc(): void {
  ipcMain.handle('recent-list', async () => {
    return { success: true, list: loadRecent() };
  });

  ipcMain.handle('recent-add', async (_e: any, payload: any) => {
    const type = payload && payload.type;
    const name = payload && payload.name;
    if (!type || !name) return { success: false, error: 'missing' };
    const list = addRecent(type as RecentType, name, { payload: payload.payload, autoSend: payload.autoSend });
    broadcast();
    return { success: true, list };
  });

  ipcMain.handle('recent-remove', async (_e: any, payload: any) => {
    const type = payload && payload.type;
    const name = payload && payload.name;
    if (!type || !name) return { success: false, error: 'missing' };
    const list = removeRecent(type as RecentType, name);
    broadcast();
    return { success: true, list };
  });
}

export { registerRecentIpc };
