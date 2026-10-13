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
  // 首次加载时启动项目目录 watcher（自动刷新用）。
  // 注意：只在成功后才置 flag——未选目录等失败情况保持 false，下次 loadGit 可重试。
  if (!gitWatcherStarted && api.gitWatchStart) {
    api.gitWatchStart().then((r: any) => {
      gitWatcherStarted = !!(r && r.success);
    }).catch(() => { gitWatcherStarted = false; });
  }
  loadBranch(); // 分支显示独立于文件状态，失败也不阻断
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

/** 加载并显示当前分支 */
async function loadBranch(): Promise<void> {
  const nameEl = document.getElementById('git-branch-name');
  if (!nameEl || !api.gitCurrentBranch) return;
  try {
    const r = await api.gitCurrentBranch();
    nameEl.textContent = (r && r.success) ? (r.branch || '—') : '—';
  } catch (_) {
    nameEl.textContent = '—';
  }
}

/** 展开/收起分支列表 */
async function toggleBranchList(): Promise<void> {
  const listEl = document.getElementById('git-branch-list');
  if (!listEl) return;
  if (!listEl.classList.contains('ck-hidden')) { listEl.classList.add('ck-hidden'); return; }
  if (!api.gitListBranches) return;
  try {
    const r = await api.gitListBranches();
    if (!r || !r.success) { await ckAlert('读取分支失败：' + ((r && r.error) || '未知错误'), 'Git'); return; }
    const branches: string[] = r.branches || [];
    const current: string = r.current || '';
    if (!branches.length) {
      listEl.innerHTML = '<div class="ck-git-branch-empty">无本地分支</div>';
    } else {
      listEl.innerHTML = branches.map((b) =>
        '<div class="ck-git-branch-item' + (b === current ? ' current' : '') + '" data-branch="' + escapeAttr(b) + '">' +
          '<span class="ck-git-branch-check">' + (b === current ? '✓' : '') + '</span>' +
          '<span class="ck-git-branch-label">' + escapeHtml(b) + '</span>' +
        '</div>').join('');
    }
    listEl.classList.remove('ck-hidden');
  } catch (err: any) {
    await ckAlert('读取分支失败：' + (err && err.message), 'Git');
  }
}

/** 切换分支（脏工作区二次确认） */
async function doCheckout(branch: string): Promise<void> {
  if (!api.gitCheckout) return;
  const listEl = document.getElementById('git-branch-list');
  try {
    let r: any = await api.gitCheckout(branch, false);
    if (r && r.dirty) {
      const ok = await ckConfirm('当前有未提交的改动，切换分支可能失败或丢失改动。\n\n确定要强制切换吗？', '切换分支');
      if (!ok) return;
      r = await api.gitCheckout(branch, true);
    }
    if (r && !r.success) { await ckAlert('切换失败：' + (r.error || '未知错误'), 'Git'); return; }
    if (listEl) listEl.classList.add('ck-hidden');
    historyLoaded = false; lastHistorySig = ''; // 切分支后提交历史不同，需重拉
    await loadGit();
    if (historyOpen) await loadHistory();
  } catch (err: any) {
    await ckAlert('切换失败：' + (err && err.message), 'Git');
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
  historyLoaded = false; lastHistorySig = ''; // 新提交出现，历史需重拉
  await loadGit();
  if (historyOpen) await loadHistory();
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
  const branchBar = document.getElementById('git-branch-bar');
  if (branchBar) branchBar.addEventListener('click', () => { toggleBranchList(); });
  const branchList = document.getElementById('git-branch-list');
  if (branchList) {
    branchList.addEventListener('click', async (e: any) => {
      const item = e.target && e.target.closest ? e.target.closest('.ck-git-branch-item') : null;
      if (item && item.dataset.branch) await doCheckout(item.dataset.branch);
    });
  }
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

// ===== 提交历史 =====
let historyLoaded = false;
let historyOpen = false;
/** 最近一次渲染的历史签名（hash 列表），用于跳过无变化的重绘（防闪） */
let lastHistorySig = '';

/** 渲染提交历史列表 */
function renderHistory(commits: any[]): void {
  const listEl = document.getElementById('git-history-list');
  const countEl = document.getElementById('git-history-count');
  if (!listEl) return;
  if (countEl) countEl.textContent = commits.length ? String(commits.length) : '';
  if (!commits.length) {
    listEl.innerHTML = '<div class="ck-git-history-empty">暂无提交</div>';
    return;
  }
  listEl.innerHTML = commits.map((c: any) => {
    const h = escapeAttr(c.hash || '');
    return '<div class="ck-git-commit-row" data-hash="' + h + '" title="' + escapeAttr(c.subject || '') + '">' +
      '<span class="ck-git-commit-subject">' + escapeHtml(c.subject || '(无提交信息)') + '</span>' +
      '<span class="ck-git-commit-meta">' + escapeHtml(c.short || '') + ' · ' + escapeHtml(c.author || '') + ' · ' + escapeHtml(c.date || '') + '</span>' +
    '</div>';
  }).join('');
}

/** 拉取提交历史 */
async function loadHistory(): Promise<void> {
  const listEl = document.getElementById('git-history-list');
  if (!listEl || !api.gitLog) return;
  // 仅在首次加载时显示"加载中"；自动刷新时不闪（避免反复清空重绘）
  if (!historyLoaded) listEl.innerHTML = '<div class="ck-git-history-empty">加载中…</div>';
  try {
    const r = await api.gitLog(60);
    if (!r || !r.success) {
      if (!historyLoaded) listEl.innerHTML = '<div class="ck-git-history-empty">' + escapeHtml((r && r.error) || '读取失败') + '</div>';
      return;
    }
    const commits = r.commits || [];
    // 内容签名未变 → 跳过重绘（防自动刷新时闪烁）
    const sig = commits.map((c: any) => c.hash).join(',');
    if (sig === lastHistorySig) { historyLoaded = true; return; }
    lastHistorySig = sig;
    renderHistory(commits);
    historyLoaded = true;
  } catch (err: any) {
    listEl.innerHTML = '<div class="ck-git-history-empty">' + escapeHtml(err.message || '读取失败') + '</div>';
  }
}

/** 展开/收起历史 */
async function toggleHistory(): Promise<void> {
  const listEl = document.getElementById('git-history-list');
  const caret = document.getElementById('git-history-caret');
  if (!listEl) return;
  historyOpen = !historyOpen;
  if (historyOpen) {
    listEl.classList.remove('ck-hidden');
    if (caret) caret.classList.remove('ck-git-caret-c');
    if (!historyLoaded) await loadHistory();
  } else {
    listEl.classList.add('ck-hidden');
    if (caret) caret.classList.add('ck-git-caret-c');
  }
}

/** 查看某次提交的改动（弹框展示 --stat 文本） */
async function showCommit(hash: string): Promise<void> {
  if (!api.gitShowCommit) return;
  try {
    const r = await api.gitShowCommit(hash);
    if (!r || !r.success) { await ckAlert('读取提交失败：' + ((r && r.error) || '未知错误'), 'Git'); return; }
    await ckAlert(r.text || '(无内容)', '提交详情');
  } catch (err: any) {
    await ckAlert('读取提交失败：' + (err && err.message), 'Git');
  }
}

// 历史区事件绑定
{
  const toggle = document.getElementById('git-history-toggle');
  if (toggle) toggle.addEventListener('click', () => { toggleHistory(); });
  const histList = document.getElementById('git-history-list');
  if (histList) {
    histList.addEventListener('click', (e: any) => {
      const row = e.target && e.target.closest ? e.target.closest('.ck-git-commit-row') : null;
      if (row && row.dataset.hash) showCommit(row.dataset.hash);
    });
  }
}

// ===== 自动刷新（fs.watch 推送 → 仅 Git 面板激活时刷新）=====
let gitWatcherStarted = false;
/** Git 面板当前是否激活 */
function isGitPanelActive(): boolean {
  const p = document.querySelector('.ck-tab[data-panel="git"]');
  return !!(p && p.classList.contains('ck-tab-active'));
}
if (api.onGitChanged) {
  api.onGitChanged(() => {
    // 非激活不刷新（省 git status 开销）
    if (!isGitPanelActive()) return;
    loadGit();
    if (historyOpen) loadHistory(); // 历史展开时一并刷新
  });
}

// 项目目录变化 → 刷新
if (api.onProjectDir) {
  api.onProjectDir(() => {
    historyLoaded = false; lastHistorySig = ''; // 目录变了，历史需重拉
    gitWatcherStarted = false; // 目录变了，watcher 需重新启动监听新目录（start 会清理旧 watcher）
    loadGit();
    if (historyOpen) loadHistory();
  });
}
