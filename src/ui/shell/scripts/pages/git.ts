/**
 * 源代码管理页：Git 暂存 / 取消暂存 / 撤销 / 提交。
 * 只调 window.shellAPI.git*，不碰主进程。
 */
import { api, escapeHtml, escapeAttr, ckConfirm, ckAlert } from '../shared.js';
import { openPreview } from '../preview.js';

interface GitItem { path: string; x: string; y: string; staged: boolean; unstaged: boolean }

/** 状态字母（单个） → 显示 + 颜色类 */
function statusOf(it: GitItem, staged: boolean): { ch: string; cls: string } {
  if (it.x === '?') return { ch: 'U', cls: 'ck-git-u' }; // 未跟踪
  const c = staged ? it.x : it.y;
  const ch = c === ' ' || c === '?' ? 'M' : c;
  const map: Record<string, string> = { M: 'ck-git-m', A: 'ck-git-a', D: 'ck-git-d', R: 'ck-git-r', C: 'ck-git-a' };
  return { ch, cls: map[ch] || 'ck-git-m' };
}

/** 分组的折叠状态（key: 'staged' | 'changed'） */
const collapsedGroups = new Set<string>();

/** badge（活动栏图标上的改动数） */
function refreshBadge(count: number): void {
  const badge = document.getElementById('git-badge') as any;
  if (!badge) return;
  if (count > 0) { badge.textContent = String(count); badge.style.display = ''; }
  else { badge.style.display = 'none'; }
}

/** 单行 HTML */
function rowHtml(it: GitItem, staged: boolean): string {
  const s = statusOf(it, staged);
  const p = escapeAttr(it.path);
  const untracked = it.x === '?';
  const acts = staged
    ? '<span class="ck-git-act" data-act="unstage" data-path="' + p + '">−</span>'
    : '<span class="ck-git-act" data-act="stage" data-path="' + p + '">＋</span>' +
      (untracked
        ? '<span class="ck-git-act" data-act="discard" data-path="' + p + '">🗑</span>'
        : '<span class="ck-git-act" data-act="restore" data-path="' + p + '">↩</span>');
  return '<div class="ck-git-row" data-path="' + p + '" title="' + p + '">' +
    '<span class="ck-git-st ' + s.cls + '">' + s.ch + '</span>' +
    '<span class="ck-git-path">' + escapeHtml(it.path) + '</span>' +
    '<span class="ck-git-acts">' + acts + '</span>' +
  '</div>';
}

/** 分组头 HTML（含折叠箭头） */
function groupHtml(key: string, title: string, count: number, act: string, actLabel: string): string {
  const collapsed = collapsedGroups.has(key);
  const caret = '<span class="ck-git-caret' + (collapsed ? ' ck-git-caret-c' : '') + '"></span>';
  return '<div class="ck-git-group" data-group="' + key + '">' +
    caret +
    '<span class="ck-git-group-title">' + title + ' (' + count + ')</span>' +
    '<span class="ck-git-group-act" data-act="' + act + '">' + actLabel + '</span>' +
  '</div>';
}

/** 最近一次渲染的数据（切换折叠时复用） */
let lastItems: GitItem[] = [];

/** 渲染列表（已暂存 / 更改 两组） */
function renderList(items: GitItem[]): void {
  const listEl = document.getElementById('git-list');
  if (!listEl) return;
  lastItems = items;
  const staged = items.filter((i) => i.staged);
  const changed = items.filter((i) => i.unstaged && !i.staged)
    .concat(items.filter((i) => i.staged && i.unstaged)); // 同时有暂存+工作区改动的，也列出未暂存侧
  let html = '';
  if (staged.length) {
    html += groupHtml('staged', '已暂存', staged.length, 'unstage-all', '全部取消');
    if (!collapsedGroups.has('staged')) html += staged.map((i) => rowHtml(i, true)).join('');
  }
  if (changed.length) {
    html += groupHtml('changed', '更改', changed.length, 'stage-all', '全部暂存');
    if (!collapsedGroups.has('changed')) html += changed.map((i) => rowHtml(i, false)).join('');
  }
  if (!staged.length && !changed.length) {
    html = '<div class="ck-list-empty">没有改动</div>';
  }
  listEl.innerHTML = html;
  hasStagedFiles = staged.length > 0;
  updateCommitBtn();
}

/** 当前是否有已暂存改动（由最近一次渲染结果决定） */
let hasStagedFiles = false;

function updateCommitBtn(): void {
  const msgEl = document.getElementById('git-commit-msg') as any;
  const btn = document.getElementById('git-commit-btn') as any;
  if (!btn) return;
  const hasMsg = !!(msgEl && String(msgEl.value || '').trim());
  // 有已暂存 + 有提交信息 → 可提交
  btn.disabled = !(hasMsg && hasStagedFiles);
}

/** 读取并渲染状态 */
export async function loadGit(): Promise<void> {
  const listEl = document.getElementById('git-list');
  if (!listEl) return;
  if (!api.gitStatus) { listEl.innerHTML = '<div class="ck-list-empty">Git 功能不可用</div>'; return; }
  try {
    const r = await api.gitStatus();
    if (!r || !r.success) {
      listEl.innerHTML = '<div class="ck-list-empty">' + escapeHtml((r && r.error) || '读取失败') + '</div>';
      refreshBadge(0);
      return;
    }
    const items: GitItem[] = (r.items || []) as GitItem[];
    refreshBadge(items.length);
    renderList(items);
  } catch (err: any) {
    listEl.innerHTML = '<div class="ck-list-empty">' + escapeHtml(err.message || '读取失败') + '</div>';
    refreshBadge(0);
  }
}

/** 暂存 / 取消暂存 / 撤销 单个文件 */
async function doAct(act: string, relPath: string): Promise<void> {
  if (act === 'restore') {
    const ok = await ckConfirm('确定撤销「' + relPath + '」的修改？此操作会丢弃未提交的改动，不可恢复。', '撤销修改');
    if (!ok) return;
  } else if (act === 'discard') {
    const ok = await ckConfirm('确定删除未跟踪文件「' + relPath + '」？此操作不可恢复。', '删除文件');
    if (!ok) return;
  }
  try {
    let r: any;
    if (act === 'stage') r = await api.gitStage!(relPath);
    else if (act === 'unstage') r = await api.gitUnstage!(relPath);
    else if (act === 'restore') r = await api.gitRestore!(relPath);
    else if (act === 'discard') r = await api.gitDiscardUntracked!(relPath);
    if (r && !r.success) await ckAlert('操作失败：' + (r.error || '未知错误'), 'Git');
  } catch (err: any) {
    await ckAlert('操作失败：' + (err && err.message), 'Git');
  }
  await loadGit();
}

/** 全部暂存 / 全部取消暂存 */
async function doBulk(act: string, items: GitItem[]): Promise<void> {
  const targets = act === 'stage-all' ? items.filter((i) => i.unstaged) : items.filter((i) => i.staged);
  for (const it of targets) {
    try {
      if (act === 'stage-all') await api.gitStage!(it.path);
      else await api.gitUnstage!(it.path);
    } catch (_) { /* 跳过单个失败，继续 */ }
  }
  await loadGit();
}

/** 提交 */
async function doCommit(): Promise<void> {
  const msgEl = document.getElementById('git-commit-msg') as any;
  const msg = msgEl ? String(msgEl.value || '').trim() : '';
  if (!msg) { await ckAlert('请填写提交信息', '提交'); return; }
  const r = await api.gitCommit!(msg);
  if (!r || !r.success) { await ckAlert('提交失败：' + ((r && r.error) || '未知错误'), '提交'); return; }
  if (msgEl) msgEl.value = '';
  await ckAlert('提交成功', 'Git');
  await loadGit();
}

// ===== 事件绑定 =====
{
  const listEl = document.getElementById('git-list');
  if (listEl) {
    listEl.addEventListener('click', async (e: any) => {
      const actEl = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (actEl) {
        const act = actEl.dataset.act;
        const p = actEl.dataset.path;
        if (act === 'stage' || act === 'unstage' || act === 'restore' || act === 'discard') { await doAct(act, p); return; }
        if (act === 'stage-all' || act === 'unstage-all') {
          // 重新读状态后批量操作
          const r = await api.gitStatus!();
          if (r && r.success) await doBulk(act, r.items || []);
          return;
        }
      }
      // 点分组头（非按钮）→ 折叠 / 展开
      const grp = e.target && e.target.closest ? e.target.closest('.ck-git-group') : null;
      if (grp && grp.dataset.group) {
        const key = grp.dataset.group;
        if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
        renderList(lastItems);
        return;
      }
      // 点行 → 打开文件预览
      const row = e.target && e.target.closest ? e.target.closest('.ck-git-row') : null;
      if (row && row.dataset.path) {
        const filesBtn = document.querySelector('.ck-ab-item[data-tab="files"]') as any;
        if (filesBtn) { filesBtn.click(); setTimeout(() => { openPreview(row.dataset.path); }, 60); }
      }
    });
  }
  const refreshBtn = document.getElementById('git-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => { loadGit(); });
  const commitBtn = document.getElementById('git-commit-btn');
  if (commitBtn) commitBtn.addEventListener('click', () => { doCommit(); });
  const msgEl = document.getElementById('git-commit-msg') as any;
  if (msgEl) {
    msgEl.addEventListener('input', updateCommitBtn);
    msgEl.addEventListener('keydown', (e: any) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(); }
    });
  }
}

// 项目目录变化 → 刷新
if (api.onProjectDir) {
  api.onProjectDir(() => { loadGit(); });
}
