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
    // 提交历史默认展开：首次进入且未加载时拉取
    if (historyOpen && !historyLoaded) { try { await loadHistory(); } catch (_) { /* ignore */ } }
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

/** 全部暂存 / 全部取消暂存（走批量 IPC：一条 git 命令，避免几百文件时逐个进程） */
async function doBulk(act: string): Promise<void> {
  try {
    if (act === 'stage-all') await api.gitStageAll?.();
    else await api.gitUnstageAll?.();
  } catch (_) { /* ignore */ }
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
          await doBulk(act);
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
let historyOpen = true;
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

/** 从 `diff --git a/<p1> b/<p2>` 尾部取新路径（支持带引号） */
function extractGitPath(rest: string): string {
  const idx = rest.lastIndexOf(' b/');
  let p = idx > 0 ? rest.slice(idx + 3) : rest;
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
}

interface DiffLine { t: 'ctx' | 'add' | 'del'; o: number | null; n: number | null; text: string }
interface DiffHunk { lines: DiffLine[] }
interface DiffFile { path: string; hunks: DiffHunk[]; adds: number; dels: number; binary: boolean }
interface ParsedDiff { subject: string; author: string; date: string; short: string; files: DiffFile[]; adds: number; dels: number }

/** 把 `git show` 原始输出解析成结构化 diff（降噪：去掉 commit/index/---/+++ 等内部标记） */
function parseDiff(raw: string): ParsedDiff {
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: ParsedDiff = { subject: '', author: '', date: '', short: '', files: [], adds: 0, dels: 0 };
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('commit ')) out.short = l.slice(7).trim().slice(0, 8);
    else if (l.startsWith('Author:')) out.author = l.slice(7).trim();
    else if (l.startsWith('Date:')) out.date = l.slice(5).trim();
    else if (/^ {4}\S/.test(l) && !out.subject) out.subject = l.trim();
  }
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oNo = 0, nNo = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      cur = { path: extractGitPath(l.slice('diff --git '.length)), hunks: [], adds: 0, dels: 0, binary: false };
      out.files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) { cur.binary = true; continue; }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m) {
        oNo = parseInt(m[1], 10);
        nNo = parseInt(m[3], 10);
        hunk = { lines: [] };
        cur.hunks.push(hunk);
      }
      continue;
    }
    // 文件头区（尚未进入任何 hunk）：处理 +++/---/index/new file 等内部标记。
    // 注意：这些判定必须限定在 hunk 之前——否则内容里 '-- foo'（实为 '--- foo'）
    // 或 '++ foo'（实为 '+++ foo'）会被误判成文件头（丢行 / 污染路径）。
    if (!hunk) {
      if (l.startsWith('+++ ')) {
        const p = l.slice(4).trim();
        if (p !== '/dev/null') {
          let q = p.startsWith('b/') ? p.slice(2) : p;
          if (q.startsWith('"') && q.endsWith('"')) q = q.slice(1, -1);
          cur.path = q;
        }
      }
      // 其余（index/new file/deleted file/rename/---/\\ No newline 等）一律忽略
      continue;
    }
    // hunk 内：只按首字符解析（+/-/空格），避免与文件头标记混淆
    const c0 = l.charAt(0);
    if (c0 === '+') { hunk.lines.push({ t: 'add', o: null, n: nNo++, text: l.slice(1) }); cur.adds++; }
    else if (c0 === '-') { hunk.lines.push({ t: 'del', o: oNo++, n: null, text: l.slice(1) }); cur.dels++; }
    else if (c0 === ' ') { hunk.lines.push({ t: 'ctx', o: oNo++, n: nNo++, text: l.slice(1) }); }
    else { hunk.lines.push({ t: 'ctx', o: oNo++, n: nNo++, text: l }); }
  }
  out.adds = out.files.reduce((s, f) => s + f.adds, 0);
  out.dels = out.files.reduce((s, f) => s + f.dels, 0);
  return out;
}

/** 渲染单行（含行号列） */
function diffLineRow(ln: DiffLine): string {
  const cls = ln.t === 'add' ? 'ck-diff-add' : ln.t === 'del' ? 'ck-diff-del' : 'ck-diff-ctx';
  const sign = ln.t === 'add' ? '+' : ln.t === 'del' ? '-' : ' ';
  const o = ln.o === null ? '' : String(ln.o);
  const n = ln.n === null ? '' : String(ln.n);
  return '<div class="ck-diff-row ' + cls + '">' +
    '<span class="ck-diff-ln">' + o + '</span>' +
    '<span class="ck-diff-ln">' + n + '</span>' +
    '<span class="ck-diff-sign">' + sign + '</span>' +
    '<span class="ck-diff-code">' + escapeHtml(ln.text) + '</span>' +
  '</div>';
}

/** 渲染整个结构化 diff（摘要卡 + 文件列表 + 降噪正文） */
function renderDiffHtml(d: ParsedDiff): string {
  let html = '';
  // 摘要卡
  html += '<div class="ck-diff-summary">' +
    '<div class="ck-diff-subject">' + escapeHtml(d.subject || '(无提交信息)') + '</div>' +
    '<div class="ck-diff-summary-meta">' +
      (d.short ? '<span class="ck-diff-hash">' + escapeHtml(d.short) + '</span>' : '') +
      '<span>' + escapeHtml(d.author || '') + '</span>' +
      '<span class="ck-diff-stat"><b class="ck-diff-add-t">+' + d.adds + '</b> <b class="ck-diff-del-t">−' + d.dels + '</b> · ' + d.files.length + ' 个文件</span>' +
    '</div>' +
  '</div>';
  // 文件列表
  if (d.files.length) {
    html += '<div class="ck-diff-files">';
    d.files.forEach((f, idx) => {
      html += '<div class="ck-diff-file-row" data-jump="' + idx + '">' +
        '<span class="ck-diff-file-name">' + escapeHtml(f.path) + '</span>' +
        '<span class="ck-diff-file-stat">' + (f.binary ? '二进制' : '<b class="ck-diff-add-t">+' + f.adds + '</b> <b class="ck-diff-del-t">−' + f.dels + '</b>') + '</span>' +
      '</div>';
    });
    html += '</div>';
  }
  // 正文：逐文件
  d.files.forEach((f, idx) => {
    html += '<div class="ck-diff-file-block" id="ck-diff-file-' + idx + '">';
    html += '<div class="ck-diff-file-head">' + escapeHtml(f.path) +
      (f.binary ? ' <span class="ck-diff-meta">（二进制文件）</span>' : '') + '</div>';
    for (const h of f.hunks) { for (const ln of h.lines) html += diffLineRow(ln); }
    html += '</div>';
  });
  if (!d.files.length) html += '<div class="ck-diff-meta">（无文件改动）</div>';
  return html;
}

/** 当前提交详情弹框对应的原始文本（供复制） */
let gitDiffRaw = '';

function openCommitDiff(title: string, text: string, truncated: boolean): void {
  gitDiffRaw = text || '';
  const mask = document.getElementById('git-diff-modal');
  const titleEl = document.getElementById('git-diff-title');
  const bodyEl = document.getElementById('git-diff-body');
  if (!mask || !bodyEl) return;
  if (titleEl) titleEl.textContent = title || '提交详情';
  let html = renderDiffHtml(parseDiff(gitDiffRaw));
  if (truncated) html += '<div class="ck-diff-truncated">…（输出过大已截断）</div>';
  bodyEl.innerHTML = html;
  bodyEl.scrollTop = 0;
  // 文件列表点一下 → 跳到该文件正文
  bodyEl.querySelectorAll('[data-jump]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = document.getElementById('ck-diff-file-' + (el as any).dataset.jump);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // 回到顶部按钮：滚动超过一屏才显示。用 onscroll 赋值（幂等，避免多次 open 累积监听）
  const toTop = document.getElementById('git-diff-totop');
  if (toTop) {
    toTop.classList.add('cuckoo-hidden');
    bodyEl.onscroll = () => {
      if (bodyEl.scrollTop > 120) toTop.classList.remove('cuckoo-hidden');
      else toTop.classList.add('cuckoo-hidden');
    };
  }
  mask.classList.remove('cuckoo-hidden');
  // 移出原生视图（AI/harness），否则全窗口浮层右侧被它们盖住
  try { api.setWebviewHidden?.(true); } catch (_) { /* ignore */ }
}

function closeCommitDiff(): void {
  document.getElementById('git-diff-modal')?.classList.add('cuckoo-hidden');
  try { api.setWebviewHidden?.(false); } catch (_) { /* ignore */ }
}

/** 查看某次提交的完整 diff（弹框着色展示） */
async function showCommit(hash: string): Promise<void> {
  if (!api.gitShowCommitDiff) { await ckAlert('当前版本不支持查看 diff', 'Git'); return; }
  try {
    const r = await api.gitShowCommitDiff(hash);
    if (!r || !r.success) { await ckAlert('读取提交失败：' + ((r && r.error) || '未知错误'), 'Git'); return; }
    // 标题取 patch 首行 subject（git show 输出首行前是 commit/Author/Date/空行，再是缩进的 subject）
    const firstLine = (r.text || '').split('\n').find((l: string) => l.startsWith('    ')) || '';
    openCommitDiff(firstLine.trim() || ('提交 ' + hash.slice(0, 8)), r.text || '(无内容)', !!r.truncated);
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

// 提交详情（diff）弹框事件
{
  document.getElementById('git-diff-close')?.addEventListener('click', closeCommitDiff);
  // 回到顶部
  document.getElementById('git-diff-totop')?.addEventListener('click', () => {
    const bodyEl = document.getElementById('git-diff-body');
    if (bodyEl) bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.getElementById('git-diff-modal')?.addEventListener('click', (e: any) => {
    // 点遮罩空白处关闭
    if (e.target && e.target.id === 'git-diff-modal') closeCommitDiff();
  });
  document.getElementById('git-diff-copy')?.addEventListener('click', async () => {
    const btn = document.getElementById('git-diff-copy') as any;
    const flash = (text: string) => {
      if (!btn) return;
      btn.textContent = text;
      setTimeout(() => { if (btn) btn.textContent = '复制 diff'; }, 1500);
    };
    try { await navigator.clipboard.writeText(gitDiffRaw); flash('已复制'); }
    catch (_) { flash('复制失败'); }
  });
}

// ===== 自动刷新（fs.watch 推送 → 仅 Git 面板激活时刷新）=====
let gitWatcherStarted = false;
/** Git 面板当前是否激活 */
function isGitPanelActive(): boolean {
  const p = document.querySelector('.ck-tab[data-panel="git"]');
  return !!(p && p.classList.contains('ck-tab-active'));
}
// 刷新合并：watcher 高频事件（批量保存/构建）若直接 loadGit，会叠加多个并发 git 进程。
// in-flight 守卫 + 队列：同时只跑一次，期间来的事件合并成一次补跑。
let gitLoadInFlight = false;
let gitLoadQueued = false;
async function loadGitCoalesced(): Promise<void> {
  if (gitLoadInFlight) { gitLoadQueued = true; return; }
  gitLoadInFlight = true;
  try {
    await loadGit();
    if (historyOpen) await loadHistory();
  } catch (_) { /* ignore */ }
  finally {
    gitLoadInFlight = false;
    if (gitLoadQueued) { gitLoadQueued = false; loadGitCoalesced(); }
  }
}
if (api.onGitChanged) {
  api.onGitChanged(() => {
    if (isGitPanelActive()) {
      // 面板激活：合并刷新（loadGit 内含 refreshBadge + 列表）
      loadGitCoalesced();
    } else {
      // 面板未激活：也要更新活动栏徽标数字（此前被门控挡住 → 在其他页面时数字不刷新）
      Promise.resolve(api.gitStatus?.()).then((r: any) => {
        if (r && r.success) refreshBadge((r.items || []).length);
      }).catch(() => { /* ignore */ });
    }
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
