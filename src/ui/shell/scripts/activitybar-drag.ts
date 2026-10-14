import { refreshActivitybarOverflow } from './activitybar-overflow.js';

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
// 底部固定区：这些项应始终沉底（靠 _spacer 的 flex:1 撑开）
const BOTTOM_KEYS = ['about', 'feishu', 'settings'];

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

/**
 * 规整 order 为「主区项 + _spacer + 底部固定项」。
 * 修两类旧数据：① _spacer 被存到末尾（底部三项不沉底）；
 * ② 主区图标被拖到 _spacer 之后（跑进底部固定区，表现为"跑到底部"）。
 */
function normalizeSpacer(order: string[]): string[] {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const k of order) {
    if (k === SPACER_KEY) continue;
    if (BOTTOM_KEYS.includes(k)) bottom.push(k);
    else top.push(k);
  }
  return top.concat([SPACER_KEY], bottom);
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
  // 归位 _spacer：修旧数据（末尾的 _spacer）+ 保证本次恢复正确
  order = normalizeSpacer(order);

  // 改 DOM 前断开 observer，改完再挂（否则自己触发自己 → 死循环）
  if (observer) observer.disconnect();

  // 建索引：key → element
  const byKey = new Map<string, HTMLElement>();
  Array.from(b.children).forEach((el: any) => {
    const k = keyOf(el);
    if (k) byKey.set(k, el);
  });
  // 算"期望顺序"：
  //   ① 按持久化 order 命中的元素（_spacer 也按其在 order 中的位置）
  //   ② 未命中的新元素（插件动态图标等）插到 _spacer **之前**（主区末尾）
  //      —— 不能追加到整体末尾，否则会落进底部固定区（关于/飞书/设置之后）
  const desired: HTMLElement[] = [];
  const used = new Set<HTMLElement>();
  for (const key of order) {
    const el = byKey.get(key);
    if (el && !used.has(el)) { desired.push(el); used.add(el); }
  }
  const newEls: HTMLElement[] = [];
  byKey.forEach((el) => {
    if (used.has(el)) return;
    newEls.push(el);
    used.add(el);
  });
  if (newEls.length) {
    const spacerIdx = desired.findIndex((el) => el.classList.contains('ck-ab-spacer'));
    if (spacerIdx >= 0) desired.splice(spacerIdx, 0, ...newEls);
    else desired.push(...newEls);
  }

  // 与当前顺序一致 → 不碰 DOM（避免无谓重排 / observer 抖动）
  const cur: HTMLElement[] = Array.from(b.children).filter((el: any) => keyOf(el)) as HTMLElement[];
  if (cur.length === desired.length && cur.every((el, i) => el === desired[i])) {
    if (observer) observer.observe(b, { childList: true });
    return;
  }
  for (const el of desired) b.appendChild(el);

  if (observer) observer.observe(b, { childList: true });
}

/** 实时把拖拽元素移到鼠标位置（仅限主区：_spacer 之前的图标之间排序）*/
function moveDrag(y: number): void {
  const b = bar();
  if (!b || !dragEl) return;
  const spacer = b.querySelector('.ck-ab-spacer');
  // _spacer 是硬边界：主区图标不得越过它进入底部固定区（否则会"跑到底部"）。
  const sortable: HTMLElement[] = [];
  for (const el of Array.from(b.children)) {
    if (el === spacer) break;
    if ((el as HTMLElement).classList.contains('ck-ab-item') && el !== dragEl) sortable.push(el as HTMLElement);
  }
  let placed = false;
  for (const it of sortable) {
    const r = it.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      if (dragEl.nextSibling !== it) b.insertBefore(dragEl, it);
      placed = true;
      break;
    }
  }
  if (!placed) {
    // 拖到主区末尾 → 插到 _spacer 之前（不越过它）
    if (spacer) { if (dragEl.nextSibling !== spacer) b.insertBefore(dragEl, spacer); }
    else if (sortable.length) {
      const last = sortable[sortable.length - 1];
      if (last.nextSibling !== dragEl) b.insertBefore(dragEl, last.nextSibling);
    }
  }
}

export function initActivitybarDrag(): void {
  const b = bar();
  if (!b) return;

  b.addEventListener('mousedown', (e: any) => {
    const item = e.target && e.target.closest ? e.target.closest('.ck-ab-item') : null;
    if (!item || !b.contains(item)) return;
    // 底部固定区（_spacer 之后）不可拖拽：保持"关于/飞书/设置"沉底
    const spacer = b.querySelector('.ck-ab-spacer');
    if (spacer && (spacer.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
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
      // 拖拽可能改变图标顺序（数量不变则溢出状态不变，但保险重算一次）
      try { refreshActivitybarOverflow(); } catch (_) { /* ignore */ }
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
      try { refreshActivitybarOverflow(); } catch (_) { /* ignore */ }
    });
    observer.observe(b, { childList: true });
  } catch (_) { observer = null; }
}
