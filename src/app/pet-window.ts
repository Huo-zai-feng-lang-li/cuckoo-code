/**
 * 桌面宠物浮窗（最小化主窗口后的独立展示）
 *
 * 用途：主窗口最小化后，把宠物单独留在桌面上，继续反映运行态（生成中 / 工具运行中 / 完成）。
 * 特征：
 *  - 独立 BrowserWindow（frameless + 透明 + alwaysOnTop），无 AI 页面/无登录态
 *  - 可拖动（CSS -webkit-app-region: drag），位置由用户自己摆
 *  - 状态由主进程广播（setPetState），与纯净模式内的宠物各自独立渲染
 *
 * 与插件覆盖层（entry.ts 的 overlayWin）的区别：那个跟随主窗口、随窗口最小化隐藏；
 * 本窗口恰好相反 —— 只在主窗口最小化/隐藏时出现。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSrc } from '../infra/paths.js';
import * as windowState from './window.js';

const require = createRequire(import.meta.url);
const { BrowserWindow, ipcMain, screen } = require('electron');

/** 单例：全局只允许一只桌面宠物 */
let petWin: any = null;
/** 当前驱动这只宠物的主窗口 id（点击宠物时恢复它） */
let lastSourceWinId: number | null = null;
/** 最近一次状态（窗口重建时补发，避免新窗口空态） */
let lastState: { state: string; text: string; sticky: boolean; html: boolean; hint: string } =
  { state: 'idle', text: '', sticky: true, html: false, hint: '' };

/** 窗口尺寸跟随宠物大小：宽度给足，高度留出头顶气泡空间 */
function boundsFor(petPx: number): { width: number; height: number } {
  const px = Math.max(48, Math.min(256, petPx || 96));
  return {
    width: Math.max(220, Math.round(px * 1.9)),
    // 宠物 + 头顶 34px 间隙 + 两层气泡（每层约 34px）+ 间距 9px + 内边距，
    // 留足避免高个动画（box.y=0）时气泡被窗口上边缘裁掉
    height: Math.round(px + 220),
  };
}

/** 右下角定位（留 24px 边距），复用 alert-window 的显示器选择逻辑 */
function computeBounds(petPx: number): { x: number; y: number; width: number; height: number } {
  let wa = { x: 0, y: 0, width: 1280, height: 720 };
  try {
    let d: any = null;
    try {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) d = screen.getDisplayMatching(focused.getBounds());
    } catch (_) { /* ignore */ }
    if (!d) {
      try { d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); } catch (_) { /* ignore */ }
    }
    if (!d) d = screen.getPrimaryDisplay();
    const area = d && (d.workArea || d.bounds);
    if (area) wa = area;
  } catch (_) { /* ignore */ }
  const b = boundsFor(petPx);
  return {
    x: Math.max(wa.x + 8, wa.x + wa.width - b.width - 24),
    y: Math.max(wa.y + 8, wa.y + wa.height - b.height - 24),
    width: b.width,
    height: b.height,
  };
}

function pushState(): void {
  if (!petWin || petWin.isDestroyed()) return;
  try {
    petWin.webContents.send('pet-window-state', lastState);
  } catch (_) { /* ignore */ }
}

/** 显示桌面宠物（幂等）。已存在则仅前置，不重建。 */
function showPetWindow(size: number): void {
  if (petWin && !petWin.isDestroyed()) {
    // 窗口复用时也要跟上最新尺寸：applyPetPrefs 的 setPetWindowSize 有
    // isPetWindowVisible 守卫，窗口隐藏时不执行，若不在这里补一次，
    // 用户改完大小再最小化会看到旧尺寸（幂等安全）。
    setPetWindowSize(size);
    try { petWin.showInactive(); } catch (_) { /* ignore */ }
    pushState();
    return;
  }
  const bounds = computeBounds(size);
  try {
    petWin = new BrowserWindow({
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
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      title: 'Cuckoo Pet',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'pet-window-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
  } catch (err: any) {
    console.error('[PetWindow] 创建失败:', err && err.message);
    petWin = null;
    return;
  }

  // 置顶但让出焦点（不抢用户正在操作的窗口）
  try { petWin.setAlwaysOnTop(true, 'floating'); } catch (_) { /* ignore */ }
  try { petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false }); } catch (_) { /* ignore */ }

  petWin.webContents.on('did-finish-load', () => {
    try {
      petWin.webContents.send('pet-window-init', { size: size || 96 });
      pushState();
    } catch (_) { /* ignore */ }
    try { petWin.showInactive(); } catch (_) { /* ignore */ }
  });
  petWin.webContents.on('did-fail-load', (_e: any, code: any, desc: any) => {
    console.error('[PetWindow] 页面加载失败: ' + code + ' ' + desc);
    hidePetWindow();
  });
  petWin.on('closed', () => { petWin = null; });

  petWin.loadFile(resolveSrc('ui/pet-window.html'));
}

/**
 * 更新桌面宠物尺寸（设置页改大小、或窗口内滚轮改大小时调用）。
 * 窗口没开时忽略——下次 showPetWindow 会读最新偏好重建。
 */
function setPetWindowSize(size: number): void {
  if (!petWin || petWin.isDestroyed()) return;
  try { petWin.webContents.send('pet-window-size', { size: size || 96 }); } catch (_) { /* ignore */ }
  // 窗口跟着宠物长大/缩小：保持右下角锚点不动（否则放大会顶到屏幕外）
  try {
    const b = petWin.getBounds();
    const nb = boundsFor(size);
    if (b.width === nb.width && b.height === nb.height) return;
    petWin.setBounds({
      x: b.x + (b.width - nb.width),
      y: b.y + (b.height - nb.height),
      width: nb.width,
      height: nb.height,
    }, false);
  } catch (_) { /* ignore */ }
}

/** 隐藏（不销毁）：主窗口恢复时用，再次最小化可秒开 */
function hidePetWindow(): void {
  if (!petWin || petWin.isDestroyed()) return;
  try { petWin.hide(); } catch (_) { /* ignore */ }
}

/** 彻底关闭（设置里关掉开关、或窗口重建时用） */
function destroyPetWindow(): void {
  // 清掉僵尸状态：主窗口关闭后宠物窗口销毁，若保留 lastState/lastSourceWinId，
  // 下次重建会把上一个窗口的"工具执行中"原样补发，用户误以为任务还在跑。
  lastState = { state: 'idle', text: '', sticky: true, html: false, hint: '' };
  lastSourceWinId = null;
  if (!petWin || petWin.isDestroyed()) { petWin = null; return; }
  try { petWin.destroy(); } catch (_) { /* ignore */ }
  petWin = null;
}

function isPetWindowVisible(): boolean {
  return !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
}

/**
 * 更新桌面宠物状态（由 harness 的运行态转发）。
 * @param state idle | thinking | working | attention | error
 * @param text 气泡文案（空串 = 不冒泡）
 * @param sticky 常驻（忙态）还是瞬时
 * @param html 文案含我们自产的 <b> 强调（调用方保证内容可控，非 AI 原文）
 */
function setPetState(state: string, text: string, sticky: boolean, html?: boolean, hint?: string, sourceWinId?: number): void {
  // 记住"当前在替哪个窗口显示"：点击宠物时回到它，而不是随便一个窗口
  if (typeof sourceWinId === 'number') lastSourceWinId = sourceWinId;
  // 两层分别记忆：sticky 更新常驻层，瞬时更新提示层；未传的层保持不变
  lastState = {
    state: state || 'idle',
    text: text || '',
    sticky: !!sticky,
    html: !!html,
    // hint 是情绪层：只有显式传入才更新，未传保持原值（避免状态刷新把情绪冲掉）
    hint: typeof hint === 'string' ? hint : lastState.hint,
  };
  // 窗口没开（用户没启用 / 主窗口还开着）就不用推，避免无谓 IPC
  if (!petWin || petWin.isDestroyed()) return;
  pushState();
}

/** 注册 IPC（幂等：模块加载时注册一次） */
let ipcReady = false;
function registerPetWindowIpc(): void {
  if (ipcReady) return;
  ipcReady = true;
  // 窗口内拖动结束/关闭：预留给后续「记住桌面位置」，当前只处理关闭
  ipcMain.on('pet-window-close', () => { destroyPetWindow(); });
  // 点击宠物 → 恢复主窗口。多窗口时优先恢复「正在驱动宠物的那个」，
  // 它可能已经关闭，则退回最近活跃的主窗口。
  ipcMain.on('pet-window-activate', () => {
    try {
      let ctx = lastSourceWinId !== null ? windowState.getWindowContext(lastSourceWinId) : null;
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) ctx = windowState.getMainContext();
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
      if (ctx.win.isMinimized()) ctx.win.restore();
      ctx.win.show();
      ctx.win.focus();
    } catch (_) { /* ignore */ }
  });
  // 拖动宠物本体 → 移动窗口。用 getBounds/setBounds 逐帧跟手；
  // 限制在屏幕工作区内，避免拖到看不见的地方。
  ipcMain.on('pet-window-drag-by', (_e: any, d: any) => {
    if (!petWin || petWin.isDestroyed()) return;
    const dx = Math.round(Number(d && d.dx) || 0);
    const dy = Math.round(Number(d && d.dy) || 0);
    if (!dx && !dy) return;
    try {
      const b = petWin.getBounds();
      let area = { x: 0, y: 0, width: 1920, height: 1080 };
      try {
        const disp = screen.getDisplayMatching(b);
        if (disp) area = disp.workArea || disp.bounds || area;
      } catch (_) { /* ignore */ }
      // 允许部分露出屏幕（留 40px 可抓取），但不能整个拖出去
      const minX = area.x - b.width + 40;
      const maxX = area.x + area.width - 40;
      const minY = area.y - b.height + 40;
      const maxY = area.y + area.height - 40;
      petWin.setBounds({
        x: Math.max(minX, Math.min(maxX, b.x + dx)),
        y: Math.max(minY, Math.min(maxY, b.y + dy)),
        width: b.width,
        height: b.height,
      });
    } catch (_) { /* ignore */ }
  });
}

export {
  showPetWindow, hidePetWindow, destroyPetWindow, isPetWindowVisible,
  setPetState, setPetWindowSize, registerPetWindowIpc,
};
