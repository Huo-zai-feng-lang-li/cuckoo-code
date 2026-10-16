/**
 * 通用系统级通知浮窗（右下角，自绘，取代 new Notification）
 *
 * 用途：AI 任务完成、窗口组切换、更新提示等「被动通知」统一用它，
 *       沿用限流切换浮窗（alert-window.ts）的窗口模式与视觉语言。
 *
 * 特征：
 *  - 独立 BrowserWindow（frameless + transparent），无 AI 页面/无登录态
 *  - alwaysOnTop + 跨虚拟桌面 + 任务栏可见
 *  - 屏幕右下角，多条通知垂直堆叠（最多 MAX_VISIBLE 条，超出关最旧）
 *  - 自动消失（默认 4.2s）；hover 暂停倒计时；点击卡片触发 onClick 并关闭
 *
 * 对外 API：showSystemNotification(item)
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSrc } from '../infra/paths.js';

const require = createRequire(import.meta.url);
const { BrowserWindow, screen } = require('electron');

export type NotificationKind = 'success' | 'info' | 'warn' | 'error' | 'update';

export interface SystemNotificationItem {
  /** 语义类型（决定配色与图标） */
  kind?: NotificationKind;
  /** 标题（单行，超出省略） */
  title: string;
  /** 正文（最多约两行，超出省略） */
  body?: string;
  /** 自动关闭毫秒数；<=0 表示不自动关闭。默认 4200 */
  durationMs?: number;
  /** 点击卡片的回调（通常用于聚焦到对应窗口） */
  onClick?: () => void;
  /** 是否显示图片轮换区（任务完成等"喜庆"场景用；高度自动增加） */
  withImages?: boolean;
}

/** 单张卡片的固定尺寸（内容自适应到固定高度，超长省略） */
const WIDTH = 400;
const HEIGHT = 118;
const PIC_HEIGHT = 100; // 图片轮换区高度（withImages 时叠加到 HEIGHT 上；过高会喧宾夺主）
const GAP = 12;
const MARGIN = 24;
/** 同时最多显示的通知条数（超出关闭最旧的） */
const MAX_VISIBLE = 3;

interface ActiveItem {
  win: any;
  timer: any;
  height: number;
  onClose: () => void;
}

/** 活跃通知（数组尾部 = 最新 = 最靠下） */
const active: ActiveItem[] = [];

/** 图片轮换列表缓存（相对 HTML 的路径，如 notif-images/card_1.webp） */
let notifImagesCache: string[] | null = null;
function listNotifImages(): string[] {
  if (notifImagesCache !== null) return notifImagesCache;
  let result: string[] = [];
  try {
    const dir = resolveSrc('ui/notif-images');
    const names = require('node:fs').readdirSync(dir)
      .filter((f: string) => /\.(webp|png|jpe?g)$/i.test(f))
      .sort((a: string, b: string) => {
        const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
        const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
        return na - nb;
      });
    result = names.map((n: string) => 'notif-images/' + n);
  } catch (_) {
    result = [];
  }
  notifImagesCache = result;
  return result;
}

/** 计算右下角基准点（焦点窗口所在屏 → 光标最近屏 → 主屏） */
function computeWorkArea(): { x: number; y: number; width: number; height: number } {
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
    if (d) {
      const wa0 = d.workArea;
      if (wa0) wa = wa0;
      else if (d.bounds) wa = d.bounds;
    }
  } catch (_) { /* ignore */ }
  return wa;
}

/** 重排所有活跃通知：从底部向上堆叠（每项高度可能不同：带图更高） */
function relayout(): void {
  const wa = computeWorkArea();
  const x = Math.max(wa.x + 8, wa.x + wa.width - WIDTH - MARGIN);
  // 从底部往上：最后一条（最新）在最下
  let y = wa.y + wa.height - MARGIN;
  for (let i = active.length - 1; i >= 0; i--) {
    const it = active[i];
    const h = it.height || HEIGHT;
    y -= h;
    try {
      if (it.win && !it.win.isDestroyed()) {
        it.win.setBounds({ x, y, width: WIDTH, height: h });
      }
    } catch (_) { /* ignore */ }
    y -= GAP;
  }
}

/** 关闭某条通知（幂等） */
function closeItem(item: ActiveItem): void {
  const i = active.indexOf(item);
  if (i === -1) return;
  active.splice(i, 1);
  if (item.timer) { try { clearTimeout(item.timer); } catch (_) {} item.timer = null; }
  try { if (item.win && !item.win.isDestroyed()) item.win.close(); } catch (_) {}
  try { item.onClose(); } catch (_) {}
  relayout();
}

/**
 * 显示一条系统级通知浮窗。
 * 多条并存时垂直堆叠；超过 MAX_VISIBLE 关闭最旧的。
 */
function showSystemNotification(item: SystemNotificationItem): void {
  if (!item || !item.title) return;
  const kind: NotificationKind = item.kind || 'info';
  const durationMs = typeof item.durationMs === 'number' ? item.durationMs : 4200;
  // 图片轮换区：仅当显式开启且有图时叠加高度
  const images = item.withImages ? listNotifImages() : [];
  const height = images.length ? (HEIGHT + PIC_HEIGHT) : HEIGHT;

  let win: any;
  try {
    win = new BrowserWindow({
      width: WIDTH,
      height,
      x: 0,
      y: 0,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      alwaysOnTop: true,
      show: false,
      title: item.title,
      webPreferences: {
        preload: path.join(import.meta.dirname, 'notification-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
  } catch (err: any) {
    console.error('[Notify] 创建浮窗失败:', err && err.message);
    return;
  }

  // 置顶并跨虚拟桌面（切到任何桌面都能看到）
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}

  let closed = false;
  const entry: ActiveItem = {
    win,
    timer: null,
    height,
    onClose: () => { closed = true; },
  };

  // 页面就绪后推送数据 + 定位显示
  win.webContents.on('did-finish-load', () => {
    try {
      win.webContents.send('notification-init', {
        kind,
        title: item.title,
        body: item.body || '',
        durationMs,
        images,
      });
    } catch (_) { /* ignore */ }
    active.push(entry);
    relayout();
    // 超出上限：关闭最旧的（从头部移）
    while (active.length > MAX_VISIBLE) {
      const oldest = active[0];
      if (oldest && oldest !== entry) closeItem(oldest);
      else break;
    }
    try { win.showInactive(); } catch (_) { try { win.show(); } catch (_) {} }
  });

  win.webContents.on('did-fail-load', () => { closeItem(entry); });

  // 用户操作：点击（触发回调）| 关闭
  const onAction = (event: any, action: string) => {
    if (!win || win.isDestroyed()) return;
    if (event.sender !== win.webContents) return;
    if (action === 'click') {
      try { if (typeof item.onClick === 'function') item.onClick(); } catch (_) { /* ignore */ }
    }
    closeItem(entry);
  };
  try { require('electron').ipcMain.on('notification-action', onAction); } catch (_) { /* ignore */ }

  win.on('closed', () => {
    try { require('electron').ipcMain.removeListener('notification-action', onAction); } catch (_) { /* ignore */ }
    const i = active.indexOf(entry);
    if (i !== -1) active.splice(i, 1);
    relayout();
  });

  // 自动关闭
  if (durationMs > 0) {
    entry.timer = setTimeout(() => { closeItem(entry); }, durationMs);
  }

  win.loadFile(resolveSrc('ui/notification-window.html'));
}

export { showSystemNotification };
