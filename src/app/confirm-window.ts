/**
 * 通用确认对话框浮窗（自绘，取代 dialog.showMessageBox）
 *
 * 用途：需要用户做出选择的场景（更新确认、错误重试等）。
 *       沿用限流切换浮窗（alert-window.ts）的窗口模式与视觉语言。
 *
 * 对外 API：showConfirmDialog(options) → Promise<boolean>
 *  - true：用户点了主按钮（primary，如「立即更新」）
 *  - false：点了次按钮（secondary，如「稍后」）/ 关闭 / Esc
 *
 * 更新场景扩展：当 kind='update' 且带 version/notes 时，弹窗切到专属版式
 *   （品牌头 + 版本跃迁 + 日志列表）；配合 keepOpenOnPrimary 可在用户
 *   点「立即更新」后保留窗口，用 updateConfirmProgress 推送下载进度。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSrc } from '../infra/paths.js';

const require = createRequire(import.meta.url);
const { BrowserWindow, ipcMain, screen } = require('electron');

export type ConfirmKind = 'info' | 'success' | 'warn' | 'error' | 'update';

export interface ConfirmDialogOptions {
  kind?: ConfirmKind;
  title: string;
  /** 主文案（一行，可省略） */
  body?: string;
  /** 细节（可多行，超出滚动；如错误原因） */
  detail?: string;
  /** 主按钮文案（必填） */
  primaryText: string;
  /** 次按钮文案（省略则只显示主按钮） */
  secondaryText?: string;
  /** 当前版本（如 "0.9.17"）；与 newVersion 同时提供时显示版本跃迁区 */
  version?: string;
  /** 新版本（如 "0.9.18"） */
  newVersion?: string;
  /** 更新日志条目（支持简单 HTML，如 <b>标签</b>） */
  notes?: string[];
  /** 体积提示（如 "82 MB"） */
  sizeText?: string;
  /**
   * 点主按钮后不关闭窗口（用于更新下载：保留窗口显示进度）。
   * Promise 仍会以 true 解析；窗口保持打开，直到 closeConfirmDialog 或被用户关闭。
   */
  keepOpenOnPrimary?: boolean;
}

/** 单例：同一时刻只允许一个确认框（新的顶替旧的，旧解析为 false） */
let current: { win: any; resolve: (v: boolean) => void } | null = null;

/** 右下角定位（焦点窗口所在屏 → 光标最近屏 → 主屏） */
function computeBounds(width: number, height: number): { x: number; y: number; width: number; height: number } {
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
  const margin = 24;
  return {
    x: Math.max(wa.x + 8, wa.x + wa.width - width - margin),
    y: Math.max(wa.y + 8, wa.y + wa.height - height - margin),
    width,
    height,
  };
}

/** 是否为 update 专属版式（有版本号或日志） */
function isUpdateLayout(opts: ConfirmDialogOptions): boolean {
  if (opts.kind !== 'update') return false;
  const hasVersion = !!(opts.version && opts.newVersion);
  const hasNotes = !!(opts.notes && opts.notes.length);
  return hasVersion || hasNotes;
}

/** 显示确认对话框；Promise 解析为用户选择（true=primary / false=secondary|关闭|Esc）。 */
function showConfirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  // 已有对话框：顶替（旧解析为 false）
  if (current) {
    try { current.resolve(false); } catch (_) {}
    try { current.win.close(); } catch (_) {}
    current = null;
  }
  const W = 420;
  // 高度按内容自适应
  const hasDetail = !!(opts.detail && opts.detail.trim());
  const updateLayout = isUpdateLayout(opts);
  let H = hasDetail ? 232 : 168;
  if (updateLayout) {
    // 品牌头 40 + 版本区 60 + 分隔 19 + 标签 16 + 页脚 66 + 上下内边距 44 = 245；每行日志约 42
    const noteCount = (opts.notes || []).length;
    H = 245 + noteCount * 42;
  }
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
        title: opts.title || 'Cuckoo Code',
        webPreferences: {
          preload: path.join(import.meta.dirname, 'confirm-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
    } catch (err: any) {
      console.error('[Confirm] 创建浮窗失败:', err && err.message);
      resolve(false);
      return;
    }

    // 置顶并跨虚拟桌面（切到任何桌面都能看到）
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}

    let settled = false;
    /** 关闭并解析（close=true 关窗，false 保留窗口） */
    const finalize = (v: boolean, close: boolean) => {
      if (settled) {
        // 已结算（keepOpenOnPrimary 模式下用户已确认）：仅按需关窗，不重复 resolve
        if (close) {
          if (current && current.win === win) current = null;
          try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
        }
        return;
      }
      settled = true;
      if (close) {
        if (current && current.win === win) current = null;
        try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
      }
      resolve(v);
    };

    // 用户操作回执
    const onAction = (event: any, action: string) => {
      if (!win || win.isDestroyed()) return;
      if (event.sender !== win.webContents) return; // 只接受本浮窗
      if (action === 'primary') finalize(true, !opts.keepOpenOnPrimary);
      else if (action === 'secondary') finalize(false, true);
    };
    ipcMain.on('confirm-action', onAction);

    // 关窗（用户点 X / Alt+F4）→ 视为取消（保守）
    win.on('close', () => { if (!settled) finalize(false, false); });
    win.on('closed', () => {
      try { ipcMain.removeListener('confirm-action', onAction); } catch (_) {}
      if (current && current.win === win) current = null;
      if (!settled) { settled = true; resolve(false); }
    });

    // 加载页面
    win.loadFile(resolveSrc('ui/confirm-window.html'));

    // 页面就绪后推送初始化数据 + 显示
    win.webContents.on('did-finish-load', () => {
      try {
        win.webContents.send('confirm-init', {
          kind: opts.kind || 'info',
          title: opts.title || '',
          body: opts.body || '',
          detail: opts.detail || '',
          primaryText: opts.primaryText || '确定',
          secondaryText: opts.secondaryText || '',
          version: opts.version || '',
          newVersion: opts.newVersion || '',
          notes: opts.notes || [],
          sizeText: opts.sizeText || '',
        });
      } catch (_) { /* ignore */ }
      try {
        win.show();
        win.focus();
      } catch (_) { /* ignore */ }
    });

    win.webContents.on('did-fail-load', (_e: any, code: any, desc: any) => {
      console.error('[Confirm] 页面加载失败:', code, desc);
      finalize(false, true);
    });

    current = { win, resolve: (v: boolean) => { if (!settled) { settled = true; resolve(v); } } };
  });
}

/** 向当前确认框推送下载进度（0-100）；无窗口或已关闭时忽略 */
function updateConfirmProgress(percent: number): void {
  if (!current || !current.win) return;
  try {
    if (current.win.isDestroyed()) return;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    current.win.webContents.send('confirm-progress', { percent: p });
  } catch (_) { /* ignore */ }
}

/** 关闭当前确认框（如更新下载完成/出错后）；无窗口时忽略 */
function closeConfirmDialog(): void {
  if (!current || !current.win) return;
  try { if (!current.win.isDestroyed()) current.win.close(); } catch (_) {}
}

export { showConfirmDialog, updateConfirmProgress, closeConfirmDialog };
