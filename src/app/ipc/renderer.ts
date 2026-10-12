/**
 * IPC：与渲染进程的原生交互（通知、输入事件注入）
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import * as profileManager from '../profile.js';

const require = createRequire(import.meta.url);
const { ipcMain, Notification } = require('electron');

/**
 * 持有已展示通知的引用，防止被 GC。
 * Electron 已知坑：new Notification() 若只是局部变量、无其它引用，
 * 可能在 show() 后被回收，导致 click 事件不触发（"点通知没反应"）。
 *
 * 用定长数组 + 上限，避免依赖 'close' 事件（Windows 上不一定触发）
 * 造成 Set 只增不减的内存泄漏。
 */
const liveNotifications: any[] = [];
const MAX_LIVE_NOTIFICATIONS = 20;
function trackNotification(n: any): void {
  liveNotifications.push(n);
  while (liveNotifications.length > MAX_LIVE_NOTIFICATIONS) liveNotifications.shift();
}

/**
 * 把窗口强制带到前台。
 * Windows 前台锁定：仅 show()+focus() 常无法从后台抢焦点，
 * 用「先置顶再取消 + moveTop」双保险。
 */
function bringWindowToFront(win: any): void {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    // 临时置顶，绕过 Windows 前台锁定，再取消置顶
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
    if (typeof win.moveTop === 'function') win.moveTop();
  } catch (_) { /* ignore */ }
}

function registerRendererIpc(): void {
  // AI 回复完成时：窗口已聚焦则不打扰；否则弹通知并让任务栏/Dock 闪烁
  ipcMain.handle('show-ai-notification', async (event: any) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const win = ctx ? ctx.win : windowState.getMainWindow();

      if (win && !win.isDestroyed() && win.isFocused()) {
        return { success: true, skipped: true, reason: 'window-focused' };
      }

      if (win && !win.isDestroyed()) {
        let windowName = 'Cuckoo Code';
        const profileId = ctx ? ctx.profileId : null;
        if (profileId) {
          const profile = profileManager.getProfileById(profileId);
          if (profile && profile.name) windowName = profile.name;
        }

        const notification = new Notification({
          title: windowName + ' - AI任务已完成',
          body: 'AI 已完成回复',
        });
        // 点击通知 → 聚焦到对应窗口
        notification.on('click', () => {
          try {
            // 动态重查：优先按 profileId 找当前窗口（原窗口关闭后重开也能命中）；
            // 找不到再退回弹通知时捕获的 win（若未销毁）。
            let target: any = null;
            if (profileId) {
              const ctx2 = windowState.getWindowByProfileId(profileId);
              if (ctx2 && ctx2.win && !ctx2.win.isDestroyed()) target = ctx2.win;
            }
            if (!target && win && !win.isDestroyed()) target = win;
            if (!target) {
              // 原窗口已关闭且无同 profile 窗口：退回主窗口
              const main = windowState.getMainWindow();
              if (main && !main.isDestroyed()) target = main;
            }
            if (target) bringWindowToFront(target);
          } catch (_) { /* ignore */ }
        });
        trackNotification(notification);
        notification.show();

        win.flashFrame(true);
        win.once('focus', () => {
          if (!win.isDestroyed()) win.flashFrame(false);
        });
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 站点原生发送：向聚焦输入框注入真实级 Enter（智谱只响应 isTrusted=true 的输入，合成事件免疫）
  ipcMain.handle('chat-send-enter', async (event: any) => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return false;
    try {
      sender.sendInputEvent({ type: 'keyDown', keyCode: 'Return', key: 'Enter' });
      sender.sendInputEvent({ type: 'char', keyCode: 'Return', key: '\r' });
      sender.sendInputEvent({ type: 'keyUp', keyCode: 'Return', key: 'Enter' });
      return true;
    } catch (err: any) {
      console.error('[Cuckoo Code] ❌ 原生 Enter 发送失败:', err.message);
      return false;
    }
  });

  // 模拟真实鼠标事件（isTrusted=true），用于需要原生点击的站点
  // action: 'move' | 'click'；x/y 为相对视口的 CSS 像素坐标
  ipcMain.handle('simulate-mouse', async (event: any, { action, x, y }: any = {}) => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return false;
    const px = Math.round(Number(x) || 0);
    const py = Math.round(Number(y) || 0);
    try {
      if (action === 'move') {
        sender.sendInputEvent({ type: 'mouseMove', x: px, y: py });
      } else {
        sender.sendInputEvent({ type: 'mouseMove', x: px, y: py });
        sender.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
        sender.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
      }
      return true;
    } catch (err: any) {
      console.error('[Cuckoo Code] ❌ simulate-mouse 失败:', err.message);
      return false;
    }
  });
}

export { registerRendererIpc };
