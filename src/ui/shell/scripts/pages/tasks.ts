/**
 * 任务页：手动命令 + package.json scripts 一键运行 + 输出查看 + 停止。
 * 只调 window.shellAPI.task*，不碰主进程。
 */
import { api, escapeHtml, escapeAttr } from '../shared.js';

/** 展开查看输出的任务 id → 已读字节偏移 */
const expanded = new Map<string, number>();
/** 任务 id → 输出容器元素（刷新时保留展开态） */
let scriptListCache: Array<{ name: string; command: string }> = [];

/** 格式化时间戳（HH:MM:SS） */
function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 单个任务卡片 HTML */
function renderTaskItem(t: any): string {
  const running = t.status === 'running';
  const stopping = running && !!t.stopping;
  const dot = running ? 'ck-task-dot-run' : 'ck-task-dot-exit';
  const statusText = stopping ? '停止中…' : (running ? '运行中' : (t.exitCode === 0 || t.exitCode === null ? '已结束' : '退出码 ' + t.exitCode));
  const sourceLabel = t.source === 'script' ? '脚本' : (t.source === 'ai' ? 'AI' : '手动');
  const title = t.label ? escapeHtml(t.label) + ' · ' : '';
  return '<div class="ck-task-item" data-id="' + escapeAttr(t.id) + '">' +
    '<div class="ck-task-row" data-id="' + escapeAttr(t.id) + '">' +
      '<span class="ck-task-dot ' + dot + '"></span>' +
      '<div class="ck-task-main">' +
        '<div class="ck-task-name">' + title + escapeHtml(t.command) + '</div>' +
        '<div class="ck-task-meta">' + escapeHtml(sourceLabel) + ' · ' + statusText +
          (t.pid ? ' · PID ' + t.pid : '') + ' · ' + fmtTime(t.startedAt) + '</div>' +
      '</div>' +
      '<div class="ck-task-ops">' +
        (running
          ? '<button class="ck-btn ck-task-stop" data-id="' + escapeAttr(t.id) + '"' + (stopping ? ' disabled' : '') + '>' + (stopping ? '停止中…' : '停止') + '</button>'
          : '<button class="ck-icon-btn ck-task-remove" data-id="' + escapeAttr(t.id) + '" title="移除">✕</button>') +
      '</div>' +
    '</div>' +
    '<pre class="ck-task-output cuckoo-hidden" data-id="' + escapeAttr(t.id) + '"></pre>' +
  '</div>';
}

/** 渲染 scripts 列表 */
function renderScripts(scripts: Array<{ name: string; command: string }>): void {
  const el = document.getElementById('task-scripts');
  const countEl = document.getElementById('task-scripts-count');
  if (!el) return;
  if (countEl) countEl.textContent = scripts.length ? String(scripts.length) : '';
  if (!scripts.length) {
    el.innerHTML = '<div class="ck-list-empty">当前项目无 package.json 或无 scripts</div>';
    return;
  }
  el.innerHTML = scripts.map((s) =>
    '<button class="ck-task-script" data-name="' + escapeAttr(s.name) + '" data-cmd="' + escapeAttr('npm run ' + s.name) + '" title="运行 npm run ' + escapeAttr(s.name) + '（' + escapeAttr(s.command) + '）">' +
      '<span class="ck-task-script-run">▶</span>' +
      '<span class="ck-task-script-name">' + escapeHtml(s.name) + '</span>' +
      '<span class="ck-task-script-cmd">' + escapeHtml(s.command) + '</span>' +
    '</button>'
  ).join('');
  el.querySelectorAll('.ck-task-script').forEach((btn: any) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      const cmd = btn.dataset.cmd;  // 已组装为 npm run <name>
      try {
        const r = await api.taskStart?.(cmd, name, 'script');
        if (r && !r.success) { alert('启动失败：' + (r.error || '未知错误')); return; }
        // 新任务自动展开输出
        if (r && r.task && r.task.id) { expanded.set(r.task.id, 0); lastListSig = ''; }
        await loadTasks();
        scrollToTask(r && r.task && r.task.id);
      } catch (err: any) {
        alert('启动失败：' + (err.message || String(err)));
      }
    });
  });
}

/** 上次渲染的列表签名（id+status+exitCode+命令），未变则跳过 DOM 重建（防高频输出闪屏） */
let lastListSig = '';

/** 渲染任务列表（签名未变则只增量刷输出，避免闪烁） */
function renderTasks(tasks: any[]): void {
  const el = document.getElementById('task-list');
  if (!el) return;
  if (!tasks.length) {
    if (lastListSig === '') return; // 已是空态，无需重绘
    lastListSig = '';
    el.innerHTML = '<div class="ck-list-empty">暂无任务</div>';
    return;
  }
  const sig = tasks.map((t) => t.id + '|' + t.status + '|' + (t.exitCode ?? '') + '|' + (t.stopping ? 'stopping' : '') + '|' + t.command).join('\n');
  if (sig === lastListSig) {
    // 结构未变：只刷新已展开任务的输出
    el.querySelectorAll('.ck-task-item').forEach((item: any) => {
      const id = item.dataset.id;
      if (expanded.has(id)) {
        const pre = item.querySelector('.ck-task-output');
        if (pre) refreshOutput(id, pre);
      }
    });
    return;
  }
  lastListSig = sig;
  el.innerHTML = tasks.map(renderTaskItem).join('');

  // 恢复展开态 + 重新拉输出
  el.querySelectorAll('.ck-task-item').forEach((item: any) => {
    const id = item.dataset.id;
    const pre = item.querySelector('.ck-task-output');
    if (expanded.has(id) && pre) {
      pre.classList.remove('cuckoo-hidden');
      refreshOutput(id, pre);
    }
  });

  // 行点击 → 展开/收起输出
  el.querySelectorAll('.ck-task-row').forEach((row: any) => {
    row.addEventListener('click', (e: any) => {
      if (e.target.closest('.ck-task-stop') || e.target.closest('.ck-task-remove')) return;
      const id = row.dataset.id;
      const item = row.closest('.ck-task-item');
      const pre = item.querySelector('.ck-task-output');
      if (!pre) return;
      if (expanded.has(id)) {
        expanded.delete(id);
        pre.classList.add('cuckoo-hidden');
      } else {
        expanded.set(id, 0);
        pre.classList.remove('cuckoo-hidden');
        refreshOutput(id, pre);
      }
    });
  });

  // 停止
  el.querySelectorAll('.ck-task-stop').forEach((btn: any) => {
    btn.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      // 不手改按钮：主进程 stop() 会置 stopping=true 并推送变更，
      // 渲染层据 TaskInfo.stopping 显示"停止中…"，进程退出后自动恢复。
      try { await api.taskStop?.(id); } catch (_) { /* ignore */ }
      loadTasks();
    });
  });

  // 移除
  el.querySelectorAll('.ck-task-remove').forEach((btn: any) => {
    btn.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      try { await api.taskRemove?.(btn.dataset.id); } catch (_) { /* ignore */ }
      expanded.delete(btn.dataset.id);
      loadTasks();
    });
  });
}

/** 增量拉取某任务输出并渲染到 pre */
async function refreshOutput(id: string, pre: any): Promise<void> {
  try {
    const from = expanded.get(id) || 0;
    const r = await api.taskOutput?.(id, from);
    if (!r || !r.success) return;
    if (r.text) {
      // 首次/全量：直接替换；增量：追加
      if (from === 0) pre.textContent = r.text;
      else pre.textContent += r.text;
      expanded.set(id, r.totalBytes || 0);
      // 自动滚到底
      pre.scrollTop = pre.scrollHeight;
    } else {
      expanded.set(id, r.totalBytes || from);
    }
  } catch (_) { /* ignore */ }
}

/** 平滑滚动到指定任务卡片（露出刚运行的任务，看执行过程）。
 *  注意：任务列表新任务在顶部，不能滚到容器底部——否则任务多时看到的是最旧的。 */
function scrollToTask(id?: string): void {
  if (!id) return;
  const item = document.querySelector('.ck-task-item[data-id="' + id + '"]');
  if (item) item.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 更新活动栏 badge（运行中任务数） */
function updateBadge(tasks: any[]): void {
  const badge = document.getElementById('task-badge');
  if (!badge) return;
  const n = tasks.filter((t) => t.status === 'running').length;
  if (n > 0) { badge.textContent = String(n); badge.style.display = ''; }
  else badge.style.display = 'none';
}

/** 主加载：任务列表 + scripts */
export async function loadTasks(): Promise<void> {
  try {
    const [listRes, scriptsRes] = await Promise.all([
      api.taskList?.(),
      api.taskReadScripts?.(),
    ]);
    const tasks = (listRes && listRes.success) ? (listRes.tasks || []) : [];
    renderTasks(tasks);
    updateBadge(tasks);
    if (scriptsRes && scriptsRes.success) {
      scriptListCache = scriptsRes.scripts || [];
      renderScripts(scriptListCache);
    }
  } catch (_) { /* ignore */ }
}

// ===== 事件绑定（模块加载时一次） =====
document.getElementById('task-refresh')?.addEventListener('click', () => loadTasks());
document.getElementById('task-clear')?.addEventListener('click', async () => {
  try { await api.taskClearExited?.(); } catch (_) { /* ignore */ }
  loadTasks();
});
const runBtn = document.getElementById('task-run-btn');
const cmdInput = document.getElementById('task-cmd-input') as any;
const doRun = async () => {
  const cmd = String(cmdInput?.value || '').trim();
  if (!cmd) return;
  try {
    const r = await api.taskStart?.(cmd, undefined, 'manual');
    if (r && !r.success) { alert('启动失败：' + (r.error || '未知错误')); return; }
    if (cmdInput) cmdInput.value = '';
    // 新任务自动展开输出
    if (r && r.task && r.task.id) { expanded.set(r.task.id, 0); lastListSig = ''; }
    await loadTasks();
    scrollToTask(r && r.task && r.task.id);
  } catch (err: any) {
    alert('启动失败：' + (err.message || String(err)));
  }
};
runBtn?.addEventListener('click', doRun);
cmdInput?.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') { e.preventDefault(); doRun(); } });

// scripts 折叠（caret 用 CSS 三角类：展开朝下、折叠朝右）
document.getElementById('task-scripts-head')?.addEventListener('click', () => {
  const el = document.getElementById('task-scripts');
  const caret = document.getElementById('task-scripts-caret');
  if (!el) return;
  const hidden = el.classList.toggle('cuckoo-hidden');
  if (caret) caret.classList.toggle('ck-git-caret-c', hidden);
});

// 订阅任务变更（自动刷新列表；renderTasks 内部按签名决定是否重绘 + 刷输出）
if (api.onTasksChanged) {
  api.onTasksChanged(() => { loadTasks(); });
}
