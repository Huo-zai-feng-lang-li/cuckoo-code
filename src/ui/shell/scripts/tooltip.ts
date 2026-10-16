/**
 * 全局统一自定义 Tooltip 引擎
 *
 * ⚠️ tooltip 本体改由**独立透明置顶窗口**渲染（src/app/tooltip-window.ts）。
 * 原因：AI 页面是 WebContentsView（原生视图），永远压在壳页面 DOM 之上，
 *       壳页面内画的 tooltip 会被 AI 视图遮挡（CSS z-index 无效，真机实测）。
 *
 * 本模块职责：拦截原生 title → 判断是否需要展示 → 计算 anchor 视口矩形 → 通过 IPC
 * 让主进程在屏幕坐标上定位并显示 tooltip 窗口。
 *
 * 交互：
 *  - 首次悬停延迟 300ms 展示；连贯巡视（warm）120ms；
 *  - 点击、离开、滚动、失焦、Esc 立即隐藏。
 */
import { api } from './shared.js';

let activeTarget: HTMLElement | null = null;
let showTimer = 0;
let lastHideTime = 0;

/** 计算展示文案（无则不展示） */
function pickText(el: HTMLElement): string {
  const explicit = (el.getAttribute('data-tooltip') || '').trim();
  if (explicit) return explicit;
  const implicit = (el.getAttribute('data-ck-title') || '').trim();
  if (implicit && (isIconLike(el) || isClipped(el))) return implicit;
  return '';
}

/** 元素（或其后代）内容是否被裁剪（显示不全） */
function isClipped(el: HTMLElement): boolean {
  const nodes: Element[] = [el, ...Array.from(el.querySelectorAll('*'))];
  for (const n of nodes) {
    const h = n as HTMLElement;
    if (h.clientWidth === 0 && h.clientHeight === 0) continue;
    if (h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1) return true;
  }
  return false;
}

/** 元素是否"图标型"（无可视文字或极短缩写）——此时 title 是唯一说明，应展示 */
function isIconLike(el: HTMLElement): boolean {
  return (el.textContent || '').trim().length <= 2;
}

function showFor(el: HTMLElement, text: string): void {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // 元素不可见
  try {
    api.tooltipShow?.(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      text,
      window.innerWidth,
      window.innerHeight
    );
  } catch (_) { /* ignore */ }
}

export function hideTooltip(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
  activeTarget = null;
  try { api.tooltipHide?.(); } catch (_) { /* ignore */ }
  lastHideTime = Date.now();
}

function handlePointerOver(e: PointerEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const el = target.closest('[title], [data-tooltip], [data-ck-title]') as HTMLElement | null;
  if (!el) {
    if (activeTarget && !activeTarget.contains(target)) hideTooltip();
    return;
  }

  // 原生 title 转存为 data-ck-title 并移除，杜绝原生提示（幂等）
  const rawTitle = el.getAttribute('title');
  if (rawTitle) {
    el.setAttribute('data-ck-title', rawTitle);
    el.removeAttribute('title');
  }

  if (activeTarget === el) return; // 同一元素内移动，忽略

  const text = pickText(el);
  if (!text) { hideTooltip(); return; }

  if (showTimer) clearTimeout(showTimer);
  activeTarget = el;

  // 连贯滑动（warm）：300ms 内滑过多个目标时快速响应
  const isWarm = Date.now() - lastHideTime < 300;
  // 延迟放慢：首次 700ms、连贯巡视 280ms（给用户更从容的阅读节奏，防误触）
  const delay = isWarm ? 280 : 700;

  showTimer = window.setTimeout(() => {
    if (activeTarget === el && el.isConnected) showFor(el, text);
  }, delay);
}

function handlePointerOut(e: PointerEvent): void {
  if (!activeTarget) return;
  const related = e.relatedTarget as Node | null;
  if (related && activeTarget.contains(related)) return;
  hideTooltip();
}

export function initGlobalTooltip(): void {
  try {
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    document.addEventListener('pointerdown', hideTooltip, true);
    window.addEventListener('scroll', hideTooltip, true);
    window.addEventListener('blur', hideTooltip);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideTooltip();
    });
  } catch (_) { /* ignore */ }
}
