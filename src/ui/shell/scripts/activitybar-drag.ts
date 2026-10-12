/**
 * 活动栏图标拖拽排序：拖动图标调整顺序，顺序持久化到 localStorage。
 *
 * 拖拽用 mouse 事件（比 HTML5 draggable 更可控）：移动超阈值才算拖拽，
 * 拖拽后抑制那次 click，避免误触发 tab 切换。
 *
 * 插件图标是异步动态挂载的，用 MutationObserver 监听——但 applyOrder 自己会改 DOM，
 * 会再次触发 observer。故 applyOrder 期间先 disconnect，改完再 observe（防死循环）。
 */
const BAR_SEL = '.ck-activitybar';
const ORDER_KEY = 'cuckoo-activitybar-order';
const DRAG_THRESHOLD = 6; // 移动超过 6px 才算拖拽
const SPACER_KEY = '_spacer';

let dragEl: HTMLElement | null = null;
let startY = 0;
let dragging = false;
let suppressClick = false;
let observer: MutationObserver | null = null;

function bar(): HTMLElement | null {
  return document.querySelector(BAR_SEL);
}

/** 取元素的排序 key（tab / 插件 tab / spacer） */
function keyOf(el: any): string {
  if (el.classList.contains('ck-ab-spacer')) return SPACER_KEY;
  if (el.classList.contains('ck-ab-item')) return el.dataset.tab || el.dataset.pluginTab || '';
  return '';
}

/** 保存当前 DOM 顺序 */
function saveOrder(): void {
  const b = bar();
  if (!b) return;
  const keys: string[] = [];
  Array.from(b.children).forEach((el: any) => {
    const k = keyOf(el);
    if (k) keys.push(k);
  });
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(keys)); } catch (_) { /* ignore */ }
}

/** 应用持久化的顺序（observer 回调 / 启动时调用） */
export function applyActivitybarOrder(): void {
  const b = bar();
  if (!b) return;
  let order: string[] = [];
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) order = p; }
  } catch (_) { return; }
  if (!order.length) return;

  // 改 DOM 前断开 observer，改完再挂（否则自己触发自己 → 死循环）
  if (observer) observer.disconnect();

  // 建索引：key → element
  const byKey = new Map<string, HTMLElement>();
  Array.from(b.children).forEach((el: any) => {
    const k = keyOf(el);
    if (k) byKey.set(k, el);
  });
  const spacerEl = b.querySelector('.ck-ab-spacer') as HTMLElement | null;

  // 算"期望顺序"：
  //   ① 按持久化 order 命中的元素
  //   ② spacer 固定在末尾（其前插入所有未命中的新元素）
  const desired: HTMLElement[] = [];
  const used = new Set<HTMLElement>();
  for (const key of order) {
    const el = byKey.get(key);
    if (el && el !== spacerEl && !used.has(el)) { desired.push(el); used.add(el); }
  }
  // 未命中的新元素（插件动态图标等）插到末尾（spacer 之后位置视作末尾）
  byKey.forEach((el) => {
    if (el === spacerEl || used.has(el)) return;
    desired.push(el);
    used.add(el);
  });
  if (spacerEl) desired.push(spacerEl);

  // 与当前顺序一致 → 不碰 DOM（避免无谓重排 / observer 抖动）
  const cur: HTMLElement[] = Array.from(b.children).filter((el: any) => keyOf(el)) as HTMLElement[];
  if (cur.length === desired.length && cur.every((el, i) => el === desired[i])) {
    if (observer) observer.observe(b, { childList: true });
    return;
  }
  for (const el of desired) b.appendChild(el);

  if (observer) observer.observe(b, { childList: true });
}

/** 实时把拖拽元素移到鼠标位置 */
function moveDrag(y: number): void {
  const b = bar();
  if (!b || !dragEl) return;
  const others = Array.from(b.querySelectorAll('.ck-ab-item:not(.ck-ab-dragging)')) as HTMLElement[];
  let placed = false;
  for (const it of others) {
    const r = it.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      if (dragEl.nextSibling !== it) b.insertBefore(dragEl, it);
      placed = true;
      break;
    }
  }
  if (!placed && others.length) {
    const last = others[others.length - 1];
    if (last.nextSibling !== dragEl) b.insertBefore(dragEl, last.nextSibling);
  }
}

export function initActivitybarDrag(): void {
  const b = bar();
  if (!b) return;

  b.addEventListener('mousedown', (e: any) => {
    const item = e.target && e.target.closest ? e.target.closest('.ck-ab-item') : null;
    if (!item || !b.contains(item)) return;
    dragEl = item;
    startY = e.clientY;
    dragging = false;
  });

  document.addEventListener('mousemove', (e: any) => {
    if (!dragEl) return;
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      dragEl.classList.add('ck-ab-dragging');
      document.body.style.cursor = 'grabbing';
    }
    e.preventDefault();
    moveDrag(e.clientY);
  });

  document.addEventListener('mouseup', () => {
    if (!dragEl) return;
    if (dragging) {
      dragEl.classList.remove('ck-ab-dragging');
      document.body.style.cursor = '';
      saveOrder();
      suppressClick = true; // 抑制拖拽后的 click，避免误切 tab
    }
    dragEl = null;
    dragging = false;
  });

  // 捕获阶段：吞掉拖拽后的那次 click
  b.addEventListener('click', (e: any) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);

  // 插件图标异步挂载 → 监听子节点变化，重新应用顺序（拖拽中不干预）
  try {
    observer = new MutationObserver(() => {
      if (dragEl) return;
      applyActivitybarOrder();
    });
    observer.observe(b, { childList: true });
  } catch (_) { observer = null; }
}
