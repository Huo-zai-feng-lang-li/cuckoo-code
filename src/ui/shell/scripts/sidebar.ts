/**
 * 侧边栏：标签切换 + 收起/展开 + 拖拽调宽。
 * 用注册表解耦（各页面自己注册 tab 名 → 加载函数）。
 */
import { api } from './shared.js';
import { hidePreview, restorePreview } from './preview.js';
import { pushLayout } from './layout-sync.js';

const sidebar = document.getElementById('ck-sidebar') as any;
// 默认展开宽度：460px（插件市场/详情要放得下卡片网格）
const SIDEBAR_EXPANDED = 460;
const SIDEBAR_COLLAPSED = 46;
const MIN_WIDTH = 240;   // 最小宽度：保证内容区不至于挤成一条
const MAX_WIDTH = 4000;  // 实际上不限（避免极端值）
const WIDTH_KEY = 'cuckoo-sidebar-width';
// 旧默认宽度（320）。用户没手动拖过的话，localStorage 里会存着它——
// 那种情况直接当成"未设置"，用新默认，否则用户永远停在窄版。
const LEGACY_DEFAULT = 320;

/** tab 名 → 切换时调用的加载函数（各页面注册） */
const tabLoaders: Record<string, () => void> = {};

export function registerTab(tab: string, loader: () => void): void {
  tabLoaders[tab] = loader;
}

/** 当前展开宽度（持久化，重开记住） */
let expandedWidth = (() => {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    // 旧默认 320：不是用户主动选的，直接升到新默认（须在 MIN_WIDTH 判断之前）
    if (Number.isFinite(v) && v === LEGACY_DEFAULT) return SIDEBAR_EXPANDED;
    if (Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH) return Math.round(v);
  } catch (_) { /* ignore */ }
  return SIDEBAR_EXPANDED;
})();

function saveWidth(w: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (_) { /* ignore */ }
}

/** 主进程推来新宽度（拖拽中）→ 实时更新（拖拽期间不动 AI 视图，结束后主进程统一重排） */
function applySidebarWidth(w: number): void {
  if (!sidebar) return;
  if (typeof w !== 'number' || !Number.isFinite(w)) return;
  expandedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
  saveWidth(expandedWidth);
  if (!sidebar.classList.contains('ck-collapsed')) {
    sidebar.style.width = expandedWidth + 'px';
  }
}

/**
 * 应用来自跨窗口同步的侧栏宽度。
 * 与 applySidebarWidth 的区别：此处不是拖拽中，必须同时重排 AI 视图
 * （api.toggleSidebar），否则会出现"侧栏变宽但 AI 页面没让位"。
 */
export function applySyncedSidebarWidth(raw: string): void {
  // 本窗口正在拖拽：忽略远端值，否则拖到一半被别的窗口打断
  if (draggingSidebar) return;
  const w = Number(raw);
  if (!Number.isFinite(w)) return;
  expandedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
  saveWidth(expandedWidth);
  if (sidebar && !sidebar.classList.contains('ck-collapsed')) {
    sidebar.style.width = expandedWidth + 'px';
    if (api.toggleSidebar) { try { api.toggleSidebar(expandedWidth); } catch (_) { /* ignore */ } }
  }
}

export function setCollapsed(collapsed: boolean): void {
  if (!sidebar) return;
  if (collapsed) {
    try { hidePreview(); } catch (_) { /* ignore */ }
    sidebar.classList.add('ck-collapsed');
    sidebar.style.width = ''; // 交给 CSS 的 46px
    if (api.toggleSidebar) api.toggleSidebar(SIDEBAR_COLLAPSED);
  } else {
    sidebar.classList.remove('ck-collapsed');
    sidebar.style.width = expandedWidth + 'px';
    if (api.toggleSidebar) api.toggleSidebar(expandedWidth);
  }
}

function activateTab(item: any, tab: string): void {
  document.querySelectorAll('.ck-ab-item').forEach((i: any) => i.classList.remove('ck-ab-active'));
  item.classList.add('ck-ab-active');
  document.querySelectorAll('.ck-tab').forEach((p: any) => {
    if (p.dataset.panel === tab) p.classList.add('ck-tab-active');
    else p.classList.remove('ck-tab-active');
  });
  // 预览区：切走 → 临时隐藏；切回「文件」→ 恢复
  if (tab === 'files') restorePreview();
  else hidePreview();
}

// 事件委托：动态添加的插件图标也能响应（不再只绑定初始的 abItems）
const abContainer = document.querySelector('.ck-activitybar');
if (abContainer) {
  abContainer.addEventListener('click', (e: any) => {
    const item = e.target && e.target.closest ? e.target.closest('.ck-ab-item') : null;
    if (!item) return;
    const tab = item.dataset.tab;
    if (!tab) return;
    const isCollapsed = sidebar && sidebar.classList.contains('ck-collapsed');
    const isActive = item.classList.contains('ck-ab-active');
    const run = () => { const f = tabLoaders[tab]; if (f) { try { f(); } catch (_) { /* ignore */ } } };
    if (isCollapsed) { setCollapsed(false); activateTab(item, tab); run(); return; }
    if (isActive) { setCollapsed(true); return; }
    activateTab(item, tab);
    run();
  });
}

// ===== 初始宽度应用（开机就用持久化的宽度，而不是等用户拖）=====
if (sidebar && !sidebar.classList.contains('ck-collapsed')) {
  sidebar.style.width = expandedWidth + 'px';
  if (api.toggleSidebar) { try { api.toggleSidebar(expandedWidth); } catch (_) { /* ignore */ } }
}

// ===== 拖拽调宽 =====
let draggingSidebar = false;
if (sidebar) {
  const resizer = document.createElement('div');
  resizer.className = 'ck-sidebar-resizer';
  resizer.title = '拖动调整宽度';
  sidebar.appendChild(resizer);
  resizer.addEventListener('mousedown', (e: any) => {
    if (sidebar.classList.contains('ck-collapsed')) return; // 收起状态下不拖
    e.preventDefault();
    draggingSidebar = true;
    if (api.startSidebarDrag) api.startSidebarDrag();
  });
  // 拖拽中：主进程推来实时宽度
  if (api.onSidebarDrag) api.onSidebarDrag((w: number) => applySidebarWidth(w));
  // 松开鼠标 → 结束拖拽（拖拽期间 AI 视图已移出，故鼠标必在壳页面）
  // 松开鼠标 → 结束拖拽（拖拽期间 AI 视图已移出，故鼠标必在壳页面）
  // 必须用 draggingSidebar 守卫：此监听挂在 document 上，否则页面任意一次点击
  // 都会广播宽度并触发所有窗口 toggleSidebar 重排 AI 视图（严重性能问题）。
  document.addEventListener('mouseup', () => {
    if (!draggingSidebar) return;
    draggingSidebar = false;
    if (api.endSidebarDrag) api.endSidebarDrag();
    // 跨窗口同步：本窗口拖完宽度后广播给其他窗口（apply 阶段不会回环）
    try { pushLayout(WIDTH_KEY, String(expandedWidth)); } catch (_) { /* ignore */ }
  });
}
