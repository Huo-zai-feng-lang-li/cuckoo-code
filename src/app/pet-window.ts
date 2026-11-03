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

/**
 * 宠物本体命中矩形（窗口内 CSS 像素）。由渲染进程上报——只有渲染层知道
 * 当前动画帧的绘制框（每帧都在变），主进程无法自行推算。
 */
let hitRect: { x: number; y: number; w: number; h: number } | null = null;
/** 拖动中锁：穿透会让指针捕获失效，pointerup 丢失 → 拖动粘死 */
let dragLock = false;
/** 当前穿透状态（幂等缓存，避免每帧重复调 setIgnoreMouseEvents） */
let ignoreState: boolean | null = null;
/** 光标命中检测定时器 */
let hoverTimer: ReturnType<typeof setInterval> | null = null;

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

/**
 * 切换窗口鼠标穿透。
 * @param ignore true = 穿透（点击落到下面窗口）；false = 接收（可拖宠物）
 */
function setIgnore(ignore: boolean): void {
  if (!petWin || petWin.isDestroyed()) return;
  if (ignoreState === ignore) return;
  try {
    // forward:true 让穿透时仍能收到 mousemove（Electron 的转发语义），
    // 供后续若改用事件驱动时复用；当前用轮询，不依赖它。
    petWin.setIgnoreMouseEvents(ignore, { forward: true });
    ignoreState = ignore;
  } catch (_) { /* ignore */ }
}

/**
 * 按当前光标位置裁决穿透与否。
 *
 * 必须在主进程做：窗口一旦穿透，渲染进程收不到任何鼠标事件，
 * 无法"自己发现自己被悬停"。
 */
function updateMousePassthrough(): void {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
  // 拖动期间强制接收：穿透会让指针捕获失效，pointerup 丢失 → 拖动粘死
  if (dragLock) { setIgnore(false); return; }
  if (!hitRect || !(hitRect.w > 0) || !(hitRect.h > 0)) { setIgnore(true); return; }
  let inside = false;
  try {
    const pt = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    // 光标换算成窗口内坐标（与渲染层的 CSS 像素一致：本窗口无 zoom）
    const cx = pt.x - b.x;
    const cy = pt.y - b.y;
    // 命中区外扩 4px：像素画边缘带抗锯齿渐隐，严格贴矩形会"看得到点不到"
    const pad = 4;
    inside = cx >= hitRect.x - pad && cx <= hitRect.x + hitRect.w + pad
      && cy >= hitRect.y - pad && cy <= hitRect.y + hitRect.h + pad;
  } catch (_) { /* ignore */ }
  setIgnore(!inside);
}

/** 启动/停止光标轮询（窗口显示时开、隐藏/销毁时关，避免空转） */
function startHoverWatch(): void {
  if (hoverTimer) return;
  // 32ms 轮询（约 31 FPS）：足够灵敏跟手，且比 16ms 降低一半唤醒开销，节约电池与 CPU
  hoverTimer = setInterval(updateMousePassthrough, 32);
}
function stopHoverWatch(): void {
  if (!hoverTimer) return;
  clearInterval(hoverTimer);
  hoverTimer = null;
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
    // 重新显示：恢复光标轮询（隐藏时停过）
    setIgnore(true);
    startHoverWatch();
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

  // 默认整窗鼠标穿透：本窗口 220x316 只有宠物与气泡是可见像素，其余透明。
  // Windows 上透明像素不会自动穿透，不开这个会把下面整片桌面/程序挡住（需求 105）。
  ignoreState = null;
  hitRect = null;
  dragLock = false;
  setIgnore(true);

  petWin.webContents.on('did-finish-load', () => {
    try {
      petWin.webContents.send('pet-window-init', { size: size || 96 });
      pushState();
    } catch (_) { /* ignore */ }
    try { petWin.showInactive(); } catch (_) { /* ignore */ }
    startHoverWatch();
  });
  petWin.webContents.on('did-fail-load', (_e: any, code: any, desc: any) => {
    console.error('[PetWindow] 页面加载失败: ' + code + ' ' + desc);
    hidePetWindow();
  });
  petWin.on('blur', () => {
    // 窗口失焦（如用户按 Alt+Tab、Win+D 或系统弹窗夺焦）：
    // 若此前正在拖动，解除拖动锁定，防止 pointerup 丢失导致 dragLock 永久置 true，
    // 进而导致整窗永久不穿透（遮挡底层桌面图标）。
    if (dragLock) {
      dragLock = false;
      updateMousePassthrough();
    }
  });
  petWin.on('closed', () => {
    stopHoverWatch();
    petWin = null;
    hitRect = null;
    dragLock = false;
    ignoreState = null;
  });

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
  // 隐藏后光标轮询没有意义（且会白白唤醒定时器），停掉
  stopHoverWatch();
}

/** 彻底关闭（设置里关掉开关、或窗口重建时用） */
function destroyPetWindow(): void {
  // 清掉僵尸状态：主窗口关闭后宠物窗口销毁，若保留 lastState/lastSourceWinId，
  // 下次重建会把上一个窗口的"工具执行中"原样补发，用户误以为任务还在跑。
  lastState = { state: 'idle', text: '', sticky: true, html: false, hint: '' };
  lastSourceWinId = null;
  stopHoverWatch();
  hitRect = null;
  dragLock = false;
  ignoreState = null;
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
  // 渲染层上报宠物本体命中矩形（窗口内 CSS 像素）→ 主进程据此裁决鼠标穿透。
  // 矩形随动画帧变化，渲染层在上报前自行节流；这里只做钳位与落地。
  ipcMain.on('pet-window-hit-rect', (_e: any, r: any) => {
    if (!r || typeof r !== 'object') return;
    const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
    const w = Math.max(0, num(r.w));
    const h = Math.max(0, num(r.h));
    // 空矩形 = 当前无可点区域（如宠物未就绪），退化为全穿透
    hitRect = (w > 0 && h > 0) ? { x: num(r.x), y: num(r.y), w, h } : null;
  });
  // 拖动开始/结束：拖动期间强制接收鼠标事件，防止指针捕获被穿透打断
  ipcMain.on('pet-window-drag-lock', (_e: any, locked: any) => {
    dragLock = !!locked;
    updateMousePassthrough();
  });
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
  // 限制在所有显示器联合可视区内，支持跨屏拖动同时避免拖到看不见的地方。
  ipcMain.on('pet-window-drag-by', (_e: any, d: any) => {
    if (!petWin || petWin.isDestroyed()) return;
    const dx = Math.round(Number(d && d.dx) || 0);
    const dy = Math.round(Number(d && d.dy) || 0);
    if (!dx && !dy) return;
    try {
      const b = petWin.getBounds();
      const displays = screen.getAllDisplays();
      let minX = -10000, maxX = 10000, minY = -10000, maxY = 10000;
      if (displays.length) {
        minX = 10000;
        maxX = -10000;
        minY = 10000;
        maxY = -10000;
        for (let i = 0; i < displays.length; i++) {
          const a = displays[i].workArea || displays[i].bounds;
          if (a.x < minX) minX = a.x;
          if (a.x + a.width > maxX) maxX = a.x + a.width;
          if (a.y < minY) minY = a.y;
          if (a.y + a.height > maxY) maxY = a.y + a.height;
        }
        minX = minX - b.width + 40;
        maxX = maxX - 40;
        minY = minY - b.height + 40;
        maxY = maxY - 40;
      }
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
