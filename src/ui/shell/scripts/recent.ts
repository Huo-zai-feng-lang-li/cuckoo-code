/**
 * 底部状态栏「最近使用」快捷工具。
 * 记录最近点击的 技能/MCP/子代理/提示词（最多 5 条），点击效果与对应页面卡片一致。
 * 存储：主进程全局（跨窗口共享，见 src/app/recent-tools.ts）。
 */
import { api, escapeHtml } from './shared.js';

export type RecentType = 'skill' | 'mcp' | 'agent' | 'snippet';

export interface RecentItem {
  type: RecentType;
  /** 显示名 */
  name: string;
  ts: number;
  /** snippet：触发用的内容 */
  payload?: string;
  /** snippet：是否自动发送 */
  autoSend?: boolean;
}

/** 追加到输入框的文案（与各页面一致） */
function snippetText(type: RecentType, name: string): string {
  if (type === 'skill') return '请使用 ' + name + ' 技能';
  if (type === 'mcp') return '请使用 ' + name + ' 这个 MCP';
  if (type === 'agent') return '请使用 ' + name + ' 子代理';
  return name; // snippet：直接是内容
}

function typeLabel(type: RecentType): string {
  if (type === 'skill') return '技能';
  if (type === 'mcp') return 'MCP';
  if (type === 'agent') return '子代理';
  return '提示词';
}

// 内存缓存：渲染用（主进程为真相源）
let _cache: RecentItem[] = [];

export function loadRecent(): RecentItem[] {
  return _cache;
}

/** 记录一次使用（异步走主进程，主进程广播后由 onRecentChanged 触发重渲染） */
export function addRecent(type: RecentType, name: string, extra?: { payload?: string; autoSend?: boolean }): void {
  if (!name) return;
  try {
    const p = (api as any).recentAdd ? (api as any).recentAdd(type, name, extra) : null;
    if (p && typeof p.then === 'function') {
      p.then((r: any) => { if (r && r.success) { _cache = r.list || []; renderRecent(); } }).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

/** 从最近列表中移除某项 */
export function removeRecent(type: RecentType, name: string): void {
  if (!name) return;
  try {
    const p = (api as any).recentRemove ? (api as any).recentRemove(type, name) : null;
    if (p && typeof p.then === 'function') {
      p.then((r: any) => { if (r && r.success) { _cache = r.list || []; renderRecent(); } }).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

/** 渲染底部状态栏的最近使用条 */
export function renderRecent(): void {
  const box = document.getElementById('sb-recent');
  if (!box) return;
  const list = _cache;
  if (list.length === 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<span class="sb-recent-label">最近</span>' + list.map((it) => {
    const cls = 'sb-chip sb-chip-' + it.type;
    const tip = typeLabel(it.type) + '：' + it.name + '（点击追加到输入框，点击 × 删除）';
    return '<span class="' + cls + '" data-type="' + it.type + '" data-name="' + escapeHtml(it.name) + '" title="' + escapeHtml(tip) + '">' +
      '<span class="sb-chip-name">' + escapeHtml(it.name) + '</span>' +
      '<button class="sb-chip-del" type="button" title="删除快捷方式" aria-label="删除">×</button>' +
      '</span>';
  }).join('');

  box.querySelectorAll('.sb-chip').forEach((el: any) => {
    const type = el.dataset.type as RecentType;
    const name = el.dataset.name as string;

    // 点击删除按钮删除
    const delBtn = el.querySelector('.sb-chip-del');
    if (delBtn) {
      delBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        removeRecent(type, name);
      });
    }

    // 右键直接删除
    el.addEventListener('contextmenu', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      removeRecent(type, name);
    });

    el.addEventListener('click', async (e: MouseEvent) => {
      // 若点击的是删除按钮，不触发追加
      if ((e.target as HTMLElement)?.closest('.sb-chip-del')) return;

      // 注意：点击底部快捷按钮【只执行动作】，不重新排序（排序只在侧边栏点击卡片时发生）
      // 底栏快捷方式：只把内容填到输入框（autoSend=false），不自动发送——留给用户确认后再发
      if (type === 'snippet') {
        const it = list.find((x) => x.type === 'snippet' && x.name === name);
        if (it && it.payload && api.triggerSnippet) {
          try { await api.triggerSnippet(it.payload, false); } catch (_) { /* ignore */ }
        }
      } else {
        if (api.triggerSnippet) {
          try { await api.triggerSnippet(snippetText(type, name), false); } catch (_) { /* ignore */ }
        }
      }
    });
  });
}

/** 从主进程拉取最近列表并渲染（初始化 / 变化时调用） */
export function refreshRecent(): void {
  try {
    const p = (api as any).recentList ? (api as any).recentList() : null;
    if (p && typeof p.then === 'function') {
      p.then((r: any) => { if (r && r.success) { _cache = r.list || []; renderRecent(); } }).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}
