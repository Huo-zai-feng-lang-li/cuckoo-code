/**
 * 活动栏溢出：主区（_spacer 之前）图标超过 MAX_MAIN 时，
 * 只显示前 MAX_MAIN-1 个 + 一个「⋯」按钮，其余收进 hover 弹框。
 *
 * 设计：**不改 DOM 结构**（隐藏项仍在原位，仅加 display:none）。
 *  - 拖拽排序（activitybar-drag）不受影响：顺序仍完整存在于 DOM。
 *  - 程序化 .click() 仍可触发（display:none 不阻止 JS 事件）→ 弹框里转发点击即可切 tab。
 */

/** 主区最多显示的位置数（含「⋯」）。当前 14 个图标全显示；再多才溢出。 */
const MAX_MAIN = 14;
const BAR_SEL = '.ck-activitybar';
const BTN_ID = 'ck-ab-overflow-btn';
const POP_ID = 'ck-ab-overflow-pop';
const HIDDEN_CLS = 'ck-ab-of-hidden';

function bar(): HTMLElement | null { return document.querySelector(BAR_SEL); }

/** 主区图标（_spacer 之前，排除「⋯」按钮） */
function mainIcons(): HTMLElement[] {
  const b = bar();
  if (!b) return [];
  const spacer = b.querySelector('.ck-ab-spacer');
  const out: HTMLElement[] = [];
  for (const el of Array.from(b.children) as HTMLElement[]) {
    if (el === spacer) break;
    if (!el.classList.contains('ck-ab-item')) continue;
    if (el.id === BTN_ID) continue;
    out.push(el);
  }
  return out;
}

let hideTimer: any = null;

function popover(): HTMLElement {
  let p = document.getElementById(POP_ID);
  if (p) return p;
  p = document.createElement('div');
  p.id = POP_ID;
  p.className = 'ck-ab-overflow-pop';
  document.body.appendChild(p);
  p.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
  p.addEventListener('mouseleave', () => { scheduleHide(); });
  return p;
}

function showPopover(): void {
  const btn = document.getElementById(BTN_ID);
  if (!btn) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const hidden = mainIcons().filter((i) => i.classList.contains(HIDDEN_CLS));
  const p = popover();
  p.innerHTML = '';
  hidden.forEach((ic) => {
    const clone = ic.cloneNode(true) as HTMLElement;
    clone.classList.remove(HIDDEN_CLS);
    clone.removeAttribute('id');
    // 转发点击到原图标（触发 sidebar 的 tab 切换）
    clone.addEventListener('click', (ev) => {
      ev.stopPropagation();
      try { ic.click(); } catch (_) { /* ignore */ }
      hidePopover();
    });
    p.appendChild(clone);
  });
  // 定位：按钮右侧、顶部对齐（不超出视口）
  const r = btn.getBoundingClientRect();
  p.style.left = (r.right + 6) + 'px';
  p.style.top = Math.max(8, Math.min(r.top, window.innerHeight - 40)) + 'px';
  p.classList.add('show');
}

function hidePopover(): void {
  const p = document.getElementById(POP_ID);
  if (p) p.classList.remove('show');
}

function scheduleHide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { hideTimer = null; hidePopover(); }, 160);
}

function ensureBtn(): HTMLElement {
  let btn = document.getElementById(BTN_ID) as HTMLElement | null;
  if (btn) return btn;
  btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.className = 'ck-ab-item ck-ab-more';
  btn.title = '更多';
  btn.innerHTML = '<span class="ck-ab-text">⋯</span>';
  btn.addEventListener('mouseenter', () => showPopover());
  btn.addEventListener('mouseleave', () => scheduleHide());
  return btn;
}

// observer 存模块级：refresh 期间先 disconnect，改完再 observe（防自激死循环）
let observer: MutationObserver | null = null;

/**
 * 重算溢出。
 * ⚠️ 必须「先 disconnect → 改 DOM → 再 observe」：否则自身 DOM 改动会触发 observer 再调本函数，
 *    形成无限递归（曾把渲染进程主线程卡死）。
 * 调用时机：init / 拖拽结束 / 插件图标挂载（observer 自动）。
 */
export function refreshActivitybarOverflow(): void {
  const b = bar();
  if (!b) return;
  if (observer) observer.disconnect();
  try {
    const spacer = b.querySelector('.ck-ab-spacer');
    const icons = mainIcons();
    const needBtn = icons.length > MAX_MAIN;
    const visibleCount = MAX_MAIN - 1;

    // 1) 显隐标记（仅在需要时改）
    icons.forEach((ic, idx) => {
      const shouldHide = needBtn && idx >= visibleCount;
      if (shouldHide !== ic.classList.contains(HIDDEN_CLS)) ic.classList.toggle(HIDDEN_CLS, shouldHide);
    });

    // 2)「⋯」按钮
    const btn = document.getElementById(BTN_ID) as HTMLElement | null;
    if (!needBtn) {
      if (btn) { btn.remove(); hidePopover(); }
      return;
    }
    const b2 = ensureBtn();
    const anchor = icons[visibleCount - 1];
    // 按钮应紧跟在 anchor 之后；已在位则不动（避免无谓 insertBefore）
    if (anchor) {
      if (anchor.nextSibling !== b2) b.insertBefore(b2, anchor.nextSibling || spacer);
    } else if (spacer && b2.nextSibling !== spacer) {
      b.insertBefore(b2, spacer);
    }
  } finally {
    if (observer) observer.observe(b, { childList: true });
  }
}

export function initActivitybarOverflow(): void {
  const b = bar();
  if (!b) return;
  refreshActivitybarOverflow();
  // 不另建 observer：由 activitybar-drag 的 observer 串行调用 refreshActivitybarOverflow()，
  // 避免两个 observer 互相触发打架（都改同一容器的 DOM）。
  window.addEventListener('resize', () => hidePopover());
}
