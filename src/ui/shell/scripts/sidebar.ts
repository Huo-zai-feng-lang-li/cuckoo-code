/**
 * 侧边栏：标签切换 + 收起/展开 + 拖拽调宽。
 * 用注册表解耦（各页面自己注册 tab 名 → 加载函数）。
 *
 * 图标点击用**事件委托**（绑定在 .ck-activitybar 上），
 * 这样插件运行时动态挂载的图标也能响应。
 */
import { api } from './shared.js';
import { hidePreview, restorePreview } from './preview.js';

const sidebar = document.getElementById('ck-sidebar') as any;
const SIDEBAR_EXPANDED = 320;
const SIDEBAR_COLLAPSED = 46;
const MIN_WIDTH = 320;   // 最小 = 当前默认宽度（不能再变窄）
const MAX_WIDTH = 4000;  // 实际上不限（避免极端值）
const WIDTH_KEY = 'cuckoo-sidebar-width';

/** tab 名 → 切换时调用的加载函数（各页面注册） */
const tabLoaders: Record<string, () => void> = {};

export function registerTab(tab: string, loader: () => void): void {
  tabLoaders[tab] = loader;
}

/** 当前展开宽度（持久化，重开记住） */
let expandedWidth = (() => {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
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

/** 激活某标签：实时查询（含插件动态挂载的图标/面板） */
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

// 事件委托：动态挂载的图标（插件侧栏）也能响应点击
const activitybar = document.querySelector('.ck-activitybar');
if (activitybar) {
  activitybar.addEventListener('click', (e: any) => {
    const item = e.target && e.target.closest ? e.target.closest('.ck-ab-item') : null;
    if (!item || !activitybar.contains(item)) return;
    const tab = item.dataset.tab;
    if (!tab) return;
    const isCollapsed = sidebar && sidebar.classList.contains('ck-collapsed');
    const isActive = item.classList.contains('ck-ab-active');
    const run = () => { const f = tabLoaders[tab]; if (f) { try { f(); } catch (_) { /* ignore */ } } };
    // 收起状态下点图标 → 展开并切到该标签
    if (isCollapsed) {
      setCollapsed(false);
      activateTab(item, tab);
      run();
      return;
    }
    // 点"已激活"的图标 → 收起（VS Code 行为）
    if (isActive) { setCollapsed(true); return; }
    // 否则：切到该标签
    activateTab(item, tab);
    run();
  });
}

// ===== 拖拽调宽 =====
if (sidebar) {
  const resizer = document.createElement('div');
  resizer.className = 'ck-sidebar-resizer';
  resizer.title = '拖动调整宽度';
  sidebar.appendChild(resizer);
  resizer.addEventListener('mousedown', (e: any) => {
    if (sidebar.classList.contains('ck-collapsed')) return; // 收起状态下不拖
    e.preventDefault();
    if (api.startSidebarDrag) api.startSidebarDrag();
  });
  // 拖拽中：主进程推来实时宽度
  if (api.onSidebarDrag) api.onSidebarDrag((w: number) => applySidebarWidth(w));
  // 松开鼠标 → 结束拖拽（拖拽期间 AI 视图已移出，故鼠标必在壳页面）
  document.addEventListener('mouseup', () => {
    if (api.endSidebarDrag) api.endSidebarDrag();
  });
}
