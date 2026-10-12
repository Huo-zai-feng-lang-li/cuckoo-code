/**
 * 全局统一自定义 Tooltip 引擎
 *
 * 核心机制：
 * 1. 拦截原生 title：
 *    在 pointerover 捕获阶段拦截带 [title] 的元素，将原生 title 属性暂存为
 *    [data-tooltip]，并立即 removeAttribute('title')，彻底杜绝系统原生黄色/灰色提示框。
 *
 * 2. 交互体验：
 *    - 首次悬停等待 120ms 展示（防划过误触闪烁）；
 *    - 若处于连贯巡视（warm）模式（300ms 内滑过相邻项），极速 20ms 切换显示；
 *    - 点击、离开、滚动、失焦、Esc 时立即隐藏。
 *
 * 3. 定位与自适应：
 *    - 基于 getBoundingClientRect() 计算最佳坐标，优先下方，空间不足翻转至上方；
 *    - 水平视口边界保护（两侧预留 8px 间距），永不溢出。
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
  // 识别末尾的快捷键标记，如 "返回网页模式 (Ctrl+Shift+H)"
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

  // 下方空间不足且上方放得下时，翻转到上方
  if (top + tipH > window.innerHeight - 8 && rect.top - tipH - gap >= 8) {
    top = rect.top - tipH - gap;
  }

  // 水平防溢出保护
  if (left < 8) {
    left = 8;
  } else if (left + tipW > window.innerWidth - 8) {
    left = window.innerWidth - 8 - tipW;
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function showTooltip(el: HTMLElement, text: string): void {
  const tip = ensureTooltipEl();
  renderTooltipContent(tip, text);
  positionTooltip(el, tip);
  tip.classList.add('show');
}

export function hideTooltip(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = 0;
  }
  activeTarget = null;
  if (tipEl && tipEl.classList.contains('show')) {
    tipEl.classList.remove('show');
    lastHideTime = Date.now();
  }
}

/** 元素（或其后代）内容是否被裁剪（显示不全）—— 用于判断原生 title 是否值得展示 */
function isClipped(el: HTMLElement): boolean {
  const nodes: Element[] = [el, ...Array.from(el.querySelectorAll('*'))];
  for (const n of nodes) {
    const h = n as HTMLElement;
    if (h.clientWidth === 0 && h.clientHeight === 0) continue;
    if (h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1) return true;
  }
  return false;
}

/** 元素是否"图标型"（无可视文字或极短缩写，如"元"）—— 此时 title 是唯一说明，应展示 */
function isIconLike(el: HTMLElement): boolean {
  return (el.textContent || '').trim().length <= 2;
}

function handlePointerOver(e: PointerEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const el = target.closest('[title], [data-tooltip], [data-ck-title]') as HTMLElement | null;
  if (!el) {
    if (activeTarget && !activeTarget.contains(target)) {
      hideTooltip();
    }
    return;
  }

  // 原生 title 转存为 data-ck-title 并移除，杜绝原生提示（幂等：转存后 title 即消失）
  const rawTitle = el.getAttribute('title');
  if (rawTitle) {
    el.setAttribute('data-ck-title', rawTitle);
    el.removeAttribute('title');
  }

  // 同一元素内移动（子元素间 pointerover 反复触发）→ 直接返回，
  // 避免重复跑下面的 isClipped（O(N) 遍历子元素）
  if (activeTarget === el) return;

  // data-tooltip：显式声明（如导航圆点），总是展示；
  // 原生 title（data-ck-title）：仅当内容被裁剪（显示不全）时才展示，避免到处弹提示。
  let text = (el.getAttribute('data-tooltip') || '').trim();
  if (!text) {
    const implicit = (el.getAttribute('data-ck-title') || '').trim();
    // 纯图标按钮（无可见文字）→ 展示；否则仅内容被裁剪时展示
    if (implicit && (isIconLike(el) || isClipped(el))) text = implicit;
  }
  if (!text) {
    hideTooltip();
    return;
  }

  if (showTimer) clearTimeout(showTimer);
  activeTarget = el;

  // 连贯滑动体验（warm mode）：300ms 内滑过多个目标时极速响应
  const isWarm = Date.now() - lastHideTime < 300;
  const delay = isWarm ? 20 : 120;

  showTimer = window.setTimeout(() => {
    if (activeTarget === el && el.isConnected) {
      showTooltip(el, text);
    }
  }, delay);
}

function handlePointerOut(e: PointerEvent): void {
  if (!activeTarget) return;
  const related = e.relatedTarget as Node | null;
  if (related && activeTarget.contains(related)) {
    return;
  }
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
  } catch (_) {
    /* ignore */
  }
}
