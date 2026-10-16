/**
 * 全局 tooltip 独立窗口（主进程）
 *
 * 为什么需要独立窗口：AI 页面是 WebContentsView（原生视图），永远压在壳页面 DOM 之上，
 * CSS z-index 对它无效 —— 壳页面内画的 tooltip 会被 AI 视图遮挡。
 *
 * 设计（消除闪烁的关键）：
 *  - 每个主窗口一个**固定尺寸**的透明窗口（WIN_W × WIN_H，尺寸永不变）。
 *    尺寸不变 → setBounds 只改位置 → 无尺寸重绘 → 无闪烁。
 *    透明区不可见且鼠标穿透（setIgnoreMouseEvents），不影响交互。
 *  - 内容在窗口内**贴顶 + 水平居中**，可见区域就是 tooltip 本体。
 *  - 默认显示在 anchor 下方；下方放不下则翻转到上方（需测量内容高度）。
 *  - 首次 hover 才懒创建窗口；之后复用（不再 hide/show 造成闪烁）。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSrc } from '../infra/paths.js';

const require = createRequire(import.meta.url);
const { BrowserWindow, screen } = require('electron');

/** windowId(主窗口) → tooltip 窗口 */
const tips = new Map<number, any>();
/** windowId → 当前 anchor（屏幕坐标） */
const anchors = new Map<number, { x: number; y: number; w: number; h: number }>();
/** windowId → 当前展示代次（忽略迟到的旧测量回调） */
const gens = new Map<number, number>();

const GAP = 6;       // tooltip 与 anchor 的间距
const EDGE = 8;      // 距屏幕边缘留白
const WIN_W = 360;   // 固定窗口宽（> CSS max-width 320，留居中透明余量）
const WIN_H = 200;   // 固定窗口高（足够容纳多行；透明区不可见且鼠标穿透）

/** 取目标主窗口的 tooltip 窗口（懒创建） */
function ensureTipWin(parentWin: any): any {
  const wid = parentWin.id;
  const exist = tips.get(wid);
  if (exist && !exist.isDestroyed()) return exist;
  const w = new BrowserWindow({
    parent: parentWin,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'tooltip-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try { w.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
  try { w.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
  // 主窗口移动/缩放/最小化 → 隐藏 tooltip（位置失效）
  const hide = () => { try { if (!w.isDestroyed()) w.hide(); } catch (_) {} };
  try {
    parentWin.on('move', hide);
    parentWin.on('resize', hide);
    parentWin.on('minimize', hide);
    parentWin.on('blur', hide);
    parentWin.on('closed', () => { try { if (!w.isDestroyed()) w.destroy(); } catch (_) {} tips.delete(wid); gens.delete(wid); anchors.delete(wid); });
  } catch (_) {}
  w.loadFile(resolveSrc('ui/tooltip.html'));
  tips.set(wid, w);
  return w;
}

/** 取 anchor 所在显示器工作区 */
function workAreaOf(anchor: any): any {
  try {
    const d = screen.getDisplayMatching({ x: anchor.x, y: anchor.y, width: anchor.w, height: anchor.h });
    if (d && d.workArea) return d.workArea;
  } catch (_) {}
  return { x: 0, y: 0, width: 1920, height: 1080 };
}

/**
 * 计算窗口位置（固定尺寸，只算 x/y）。
 * 内容贴窗口顶部、水平居中，故：
 *  - 下方：窗口顶 = anchor 底 + GAP
 *  - 上方：窗口顶 = anchor 顶 - GAP - 内容高（需已知内容高）
 */
function computePos(anchor: any, contentH: number, measured: boolean): { x: number; y: number } {
  const wa = workAreaOf(anchor);
  let x = Math.round(anchor.x + anchor.w / 2 - WIN_W / 2);
  let y = Math.round(anchor.y + anchor.h + GAP);
  // 下方放不下且上方放得下 → 翻转到上方（仅当已测到内容高）
  if (measured && y + contentH > wa.y + wa.height - EDGE && anchor.y - GAP - contentH >= wa.y + EDGE) {
    y = Math.round(anchor.y - GAP - contentH);
  }
  // 水平防溢出（按固定窗口宽）
  if (x < wa.x + EDGE) x = wa.x + EDGE;
  else if (x + WIN_W > wa.x + wa.width - EDGE) x = wa.x + wa.width - EDGE - WIN_W;
  return { x, y };
}

/**
 * 显示 tooltip。
 * @param payload { rect: {left,top,width,height}, text }
 */
function showTooltip(parentWin: any, payload: any): void {
  if (!parentWin || parentWin.isDestroyed()) return;
  const rect = payload && payload.rect;
  const text = (payload && payload.text) || '';
  if (!rect || !text) return;
  const w = ensureTipWin(parentWin);
  const cb = parentWin.getContentBounds();
  const anchor = { x: cb.x + rect.left, y: cb.y + rect.top, w: rect.width, h: rect.height };
  anchors.set(parentWin.id, anchor);
  const gen = (gens.get(parentWin.id) || 0) + 1;
  gens.set(parentWin.id, gen);
  // 固定尺寸：只改位置（尺寸恒定 → 无尺寸重绘 → 不闪）
  const pos = computePos(anchor, 0, false);
  try { w.setBounds({ x: pos.x, y: pos.y, width: WIN_W, height: WIN_H }); } catch (_) {}
  sendContent(w, text, gen);
  if (!w.isVisible()) { try { w.showInactive(); } catch (_) { try { w.show(); } catch (_) {} } }
}

/** 内容测量完成 → 仅在"下方放不下"时翻转到上方（尺寸不变，只改 y） */
function measureTooltip(parentWin: any, size: any): void {
  if (!parentWin || parentWin.isDestroyed()) return;
  const w = tips.get(parentWin.id);
  if (!w || w.isDestroyed()) return;
  const gen = size && size.gen;
  if (typeof gen === 'number' && gens.get(parentWin.id) !== gen) return; // 迟到的旧测量，忽略
  const anchor = anchors.get(parentWin.id);
  if (!anchor) return;
  const contentH = Math.max(1, Math.round((size && size.h) || 28));
  const pos = computePos(anchor, contentH, true);
  try { w.setBounds({ x: pos.x, y: pos.y, width: WIN_W, height: WIN_H }); } catch (_) {}
}

/** 发内容给 tooltip 页面；若页面仍在加载，等加载完再发（防消息丢失） */
function sendContent(w: any, text: string, gen: number): void {
  try {
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', () => {
        try { w.webContents.send('tooltip-content', { text, gen }); } catch (_) {}
      });
    } else {
      w.webContents.send('tooltip-content', { text, gen });
    }
  } catch (_) {}
}

/** 隐藏 tooltip */
function hideTooltip(parentWin: any): void {
  if (!parentWin || parentWin.isDestroyed()) return;
  const w = tips.get(parentWin.id);
  if (w && !w.isDestroyed()) { try { w.hide(); } catch (_) {} }
}

export { showTooltip, measureTooltip, hideTooltip };
