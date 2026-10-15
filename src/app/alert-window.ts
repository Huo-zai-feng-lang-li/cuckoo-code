/**
 * 限流自动切换告警浮窗（系统级独立 BrowserWindow）
 *
 * 用途：账号限流触发自动切换前，弹一个一定看得见的系统浮窗，给用户 10 秒叫停机会。
 * 特征：
 *  - 独立 BrowserWindow（非 WebContentsView），无 AI 页面/无登录态
 *  - alwaysOnTop + 任务栏可见 + 屏幕右下角
 *  - 无边框（frameless）+ 透明背景（CSS 自绘阴影 + 圆角）
 *  - 生命周期短（10s 内必然关闭）
 *
 * 对外 API：showSwitchAlert(options) → Promise<'cancel' | 'switch-now' | 'timeout' | 'superseded'>
 *  - cancel / switch-now：用户点击（或 Esc）
 *  - timeout：10 秒到点自动切换
 *  - superseded：被新告警顶替（多窗口同时限流，本轮静默放弃）
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSrc } from '../infra/paths.js';

const require = createRequire(import.meta.url);
const { BrowserWindow, ipcMain, screen } = require('electron');

/** 单例：同一时刻只允许一个告警浮窗 */
let currentAlert: { win: any; resolve: (v: string) => void; timer: any } | null = null;

/** 从底部右下角定位（留 24px 边距）。
 *  显示器选择优先级：焦点窗口所在屏 → 光标最近屏 → 主屏。
 *  避免"用户在主屏工作但告警弹副屏"导致看不到。 */
function computeBounds(width: number, height: number): { x: number; y: number; width: number; height: number } {
  let wa = { x: 0, y: 0, width: 1280, height: 720 };
  try {
    let d: any = null;
    try {
      const { BrowserWindow } = require('electron');
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) d = screen.getDisplayMatching(focused.getBounds());
    } catch (_) { /* ignore */ }
    if (!d) {
      try { d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); } catch (_) { /* ignore */ }
    }
    if (!d) d = screen.getPrimaryDisplay();
    if (d) {
      const wa0 = d.workArea;
      if (wa0) wa = wa0;
      else if (d.bounds) wa = d.bounds;
    }
  } catch (_) { /* ignore */ }
  const margin = 24;
  return {
    x: Math.max(wa.x + 8, wa.x + wa.width - width - margin),
    y: Math.max(wa.y + 8, wa.y + wa.height - height - margin),
    width,
    height,
  };
}

interface AlertInitData {
  /** 当前窗口显示名（限流源） */
  currentName?: string;
  /** 切换目标窗口显示名 */
  targetName?: string;
  /** 倒计时秒数，默认 10 */
  seconds?: number;
}

/** 显示告警浮窗；Promise 解析为用户决策（cancel | switch-now | timeout | superseded）。 */
function showSwitchAlert(data: AlertInitData): Promise<string> {
  // 已有浮窗：用 'superseded' 顶替（区别于用户主动取消，避免日志/埋点误导）
  if (currentAlert) {
    try { currentAlert.resolve('superseded'); } catch (_) {}
    try { currentAlert.win.close(); } catch (_) {}
    currentAlert = null;
  }
  const seconds = Math.max(3, Math.min(60, Number(data.seconds) || 10));
  const W = 400;
  const H = 236;
  const bounds = computeBounds(W, H);

  return new Promise((resolve) => {
    let win: any;
    try {
      win = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: false,
        alwaysOnTop: true,
        show: false,
        title: '账号限流',
        webPreferences: {
          preload: path.join(import.meta.dirname, 'alert-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
    } catch (err: any) {
      console.error('[Alert] 创建浮窗失败:', err && err.message);
      resolve('cancel');
      return;
    }

    // 置顶并跨虚拟桌面（确保用户切到任何桌面都能看到）
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}

    let settled = false;
    let timer: any = null;
    const settle = (v: string) => {
      if (settled) return;
      settled = true;
      if (currentAlert && currentAlert.win === win) currentAlert = null;
      if (timer) { try { clearTimeout(timer); } catch (_) {} timer = null; }
      try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
      resolve(v);
    };

    timer = setTimeout(() => { settle('timeout'); }, seconds * 1000);

    // 用户操作回执
    const onAction = (event: any, action: string) => {
      if (!win || win.isDestroyed()) return;
      if (event.sender !== win.webContents) return; // 只接受本浮窗
      if (action === 'cancel') settle('cancel');
      else if (action === 'switch-now') settle('switch-now');
    };
    ipcMain.on('alert-action', onAction);

    // 关窗（用户点 X / Alt+F4）→ 视为取消（保守）
    win.on('close', () => { if (!settled) settle('cancel'); });
    win.on('closed', () => {
      try { ipcMain.removeListener('alert-action', onAction); } catch (_) {}
      if (!settled) settle('cancel');
    });

    // 加载页面
    win.loadFile(resolveSrc('ui/alert-window.html'));

    // 页面就绪后推送初始化数据 + 显示
    win.webContents.on('did-finish-load', () => {
      try {
        win.webContents.send('alert-init', {
          currentName: data.currentName || '当前账号',
          targetName: data.targetName || '组内其他窗口',
          seconds,
        });
      } catch (_) { /* ignore */ }
      try {
        win.show();
        win.focus();
      } catch (_) { /* ignore */ }
    });

    win.webContents.on('did-fail-load', (_e: any, code: any, desc: any) => {
      console.error('[Alert] 页面加载失败:', code, desc);
      settle('cancel');
    });

    currentAlert = { win, resolve: settle, timer };
  });
}

export { showSwitchAlert };
