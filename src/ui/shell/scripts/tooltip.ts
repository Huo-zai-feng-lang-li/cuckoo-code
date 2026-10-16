/**
 * 全局统一自定义 Tooltip 引擎
 *
 * 核心机制：
 * 1. 拦截原生 title：在 pointerover 捕获阶段拦截带 [title] 的元素，暂存为
 *    [data-ck-title]，并立即 removeAttribute('title')，杜绝系统原生提示框。
 *
 * 2. 交互：首次悬停延迟展示（防划过误触）；连贯巡视（warm）快速切换；
 *    点击、离开、滚动、失焦、Esc 立即隐藏。
 *
 * 3. 定位：基于 getBoundingClientRect() 优先下方，空间不足翻上方；水平边界保护。
 *
 * 注：DOM tooltip 会被 AI 页面（WebContentsView 原生视图）遮挡其右侧区域 —— 这是旧方案
 *     的固有局限，但换来的是**跟手、不闪**的体验（独立窗口方案已被弃用）。
 */

let tipEl: HTMLElement | null = null;
let activeTarget: HTMLElement | null = null;
let showTimer = 0;
let lastHideTime = 0;

function ensureTooltipEl(): HTMLElement {
  if (!tipEl) {
    tipEl = document.getElementById('ck-tooltip');
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.id = 'ck-tooltip';
      tipEl.className = 'ck-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
  }
  return tipEl;
}

/** 格式化 tooltip 内容，支持快捷键提取为徽标 */
function renderTooltipContent(container: HTMLElement, text: string): void {
  container.innerHTML = '';
  const m = text.match(/^(.*?)(?:\s*\((Ctrl|Shift|Alt|Cmd|Meta|Enter|Esc|Tab|F\d+)[^)]*\))$/i);
  if (m && m[1]) {
    const labelSpan = document.createElement('span');
    labelSpan.textContent = m[1].trim();
    container.appendChild(labelSpan);
    const kbd = document.createElement('span');
    kbd.className = 'ck-tooltip-kbd';
    kbd.textContent = text.slice(m[1].length).replace(/^\s*\(/, '').replace(/\)$/, '');
    container.appendChild(kbd);
  } else {
    container.textContent = text;
  }
}

function positionTooltip(el: HTMLElement, tip: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.classList.add('measuring');
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  tip.classList.remove('measuring');
  const gap = 6;
  let top = rect.bottom + gap;
  let left = rect.left + (rect.width - tipW) / 2;
  if (top + tipH > window.innerHeight - 8 && rect.top - tipH - gap >= 8) {
    top = rect.top - tipH - gap;
  }
  if (left < 8) left = 8;
  else if (left + tipW > window.innerWidth - 8) left = window.innerWidth - 8 - tipW;
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

function showTooltip(el: HTMLElement, text: string): void {
  const tip = ensureTooltipEl();
  renderTooltipContent(tip, text);
  positionTooltip(el, tip);
  tip.classList.add('show');
}

export function hideTooltip(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
  activeTarget = null;
  if (tipEl && tipEl.classList.contains('show')) {
    tipEl.classList.remove('show');
    lastHideTime = Date.now();
  }
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

  // 顶部工具栏：不显示自定义 tooltip（按钮语义直观，提示多余）。
  // 仍执行上面的 title 转存 → 杜绝浏览器原生提示。
  if (el.closest('.toolbar')) { hideTooltip(); return; }

  if (activeTarget === el) return;

  let text = (el.getAttribute('data-tooltip') || '').trim();
  if (!text) {
    const implicit = (el.getAttribute('data-ck-title') || '').trim();
    if (implicit && (isIconLike(el) || isClipped(el))) text = implicit;
  }
  if (!text) { hideTooltip(); return; }

  if (showTimer) clearTimeout(showTimer);
  activeTarget = el;

  const isWarm = Date.now() - lastHideTime < 300;
  // 延迟：首次 300ms、连贯巡视 120ms（跟手，又不至于划过就弹）
  const delay = isWarm ? 120 : 300;

  showTimer = window.setTimeout(() => {
    if (activeTarget === el && el.isConnected) showTooltip(el, text);
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
