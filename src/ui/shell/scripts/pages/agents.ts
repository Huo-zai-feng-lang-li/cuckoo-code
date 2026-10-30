/**
 * 子代理页：列表、搜索/筛选、详情、新建、编辑改名、删除。
 */
import { api, ckAlert, ckConfirm, escapeHtml, escapeAttr } from '../shared.js';
import { addRecent } from '../recent.js';

/** 全部子代理缓存（供搜索/筛选/详情） */
let allAgents: any[] = [];
/** 当前筛选：all | project | user */
let scopeFilter = 'all';
/** 当前搜索词 */
let searchTerm = '';
/** 详情弹窗当前展示的代理 */
let detailAgent: any = null;

/** 秒数格式化为 mm:ss */
function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** 加载"运行中子代理"区块（实时进度） */
export async function loadRunningSubagents(): Promise<void> {
  const el = document.getElementById('agent-running-list');
  if (!el) return;
  const apiAny: any = api as any;
  if (typeof apiAny.listRunningSubagents !== 'function') return;
  try {
    const r = await apiAny.listRunningSubagents();
    const list = (r && r.success && r.subagents) ? r.subagents : [];
    // 先移除不存在的节点（已结束的）
    const currentIds = new Set(list.map((s: any) => String(s.windowId)));
    el.querySelectorAll('.ck-agent-running').forEach((node: any) => {
      if (!currentIds.has(node.getAttribute('data-agent-window'))) {
        node.remove();
      }
    });

    // 更新或插入现有节点
    const groupTitle = el.querySelector('.ck-mcp-group-title');
    if (!groupTitle && list.length > 0) {
      el.insertAdjacentHTML('afterbegin', '<div class="ck-mcp-group-title">运行中</div>');
    } else if (groupTitle && list.length === 0) {
      groupTitle.remove();
    }

    list.forEach((s: any) => {
      let node = el.querySelector('.ck-agent-running[data-agent-window="' + s.windowId + '"]') as HTMLElement | null;
      const now = Date.now();
      const elapsed = Math.max(0, Math.round((now - (s.startedAt || now)) / 1000));
      const tmo = s.timeoutMs || 600000; // = SUBAGENT_TIMEOUT_MS，见 src/infra/timeouts.ts
      const remain = Math.max(0, Math.round((tmo - (now - (s.startedAt || now))) / 1000));
      const isRunning = s.status !== 'done' && s.status !== 'error';
      const remainText = isRunning ? ('剩余 ' + fmtSec(remain)) : '';
      const statusText = s.status === 'done' ? '完成' : (s.status === 'error' ? '出错' : '运行中');
      const preview = escapeHtml((s.preview || '').slice(-160));

      if (!node) {
        // 新建
        const stopBtn = (s.status === 'starting' || s.status === 'running')
          ? '<button class="ck-snip-icon-btn danger ck-agent-stop" data-stop-agent="' + s.windowId + '" title="停止该子代理"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>'
          : '';
        const html = '<div class="ck-agent-running" data-agent-window="' + s.windowId + '">' +
          '<div class="ck-skill-top">' +
            '<span class="ck-skill-name" title="' + escapeAttr(s.agentName) + '">' + escapeHtml(s.agentName) + '</span>' +
            '<span class="ck-agent-running-status">' + statusText + ' · ' + elapsed + 's' +
              (s.turn ? ' · 第 ' + s.turn + ' 轮' : '') +
              (remainText ? ' · ' + remainText : '') +
            '</span>' +
            stopBtn +
            '<svg class="ck-agent-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;margin-left:6px;flex-shrink:0;transition:transform .2s;opacity:.5;"><path d="M6 9l6 6 6-6"/></svg>' +
          '</div>' +
          '<div class="ck-skill-desc">' + escapeHtml(s.task || '') + '</div>' +
          '<div class="ck-agent-running-preview" style="display:none"></div>' +
        '</div>';
        el.insertAdjacentHTML('beforeend', html);
        node = el.querySelector('.ck-agent-running[data-agent-window="' + s.windowId + '"]');
      } else {
        // 更新现有
        const statusEl = node.querySelector('.ck-agent-running-status');
        if (statusEl) {
          statusEl.textContent = statusText + ' · ' + elapsed + 's' +
            (s.turn ? ' · 第 ' + s.turn + ' 轮' : '') +
            (remainText ? ' · ' + remainText : '');
        }
        const stopBtn = node.querySelector('.ck-agent-stop') as HTMLElement | null;
        if (stopBtn) {
          if (s.status === 'done' || s.status === 'error') stopBtn.style.display = 'none';
          else stopBtn.style.display = '';
        }
      }

      // 更新 preview
      if (node) {
        const previewEl = node.querySelector('.ck-agent-running-preview') as HTMLElement | null;
        if (previewEl) {
          if (preview) {
            // 只有未手动折叠时才自动展示
            if (previewEl.dataset.collapsed !== '1') {
              previewEl.style.display = '';
            }
            previewEl.textContent = preview;
          } else {
            // 如果没有实时输出，尊重用户手动态，不要在轮询时强制关掉
            if (previewEl.dataset.collapsed !== '0') {
              previewEl.style.display = 'none';
            }
            if (previewEl.dataset.collapsed === '0' && (!previewEl.textContent || previewEl.textContent === '（暂无预览输出）')) {
              previewEl.textContent = '（暂无预览输出）';
            }
          }
        }
      }
    });
    // 点击卡片切换预览显示
    el.querySelectorAll('.ck-agent-running').forEach((card: any) => {
      if (card.dataset.boundClick === '1') return;
      card.dataset.boundClick = '1';
      card.addEventListener('click', (e: any) => {
        if (e.target.closest('.ck-agent-stop')) return;
        // 用户正在选中文字时不触发折叠
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        const pre = card.querySelector('.ck-agent-running-preview');
        if (pre) {
          const isHidden = pre.style.display === 'none';
          pre.style.display = isHidden ? '' : 'none';
          pre.dataset.collapsed = isHidden ? '0' : '1';
          // 控制箭头旋转
          const arrow = card.querySelector('.ck-agent-arrow');
          if (arrow) arrow.style.transform = isHidden ? 'rotate(180deg)' : '';
          
          if (isHidden && (!pre.textContent || pre.textContent === '（暂无预览输出）')) {
            pre.textContent = '（暂无预览输出）';
          }
        }
      });
    });
    // 停止按钮事件：每次重建后重新绑定（节点随 innerHTML 回收，不会叠加）
    el.querySelectorAll('.ck-agent-stop').forEach((btn: any) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        const apiAny: any = api as any;
        if (typeof apiAny.cancelSubagents !== 'function') return;
        const wid = parseInt(btn.getAttribute('data-stop-agent'), 10);
        try {
          // 传 windowId = 只杀该子代理；防止多个并发时点一个杀全部
          const r = await apiAny.cancelSubagents(Number.isFinite(wid) ? wid : undefined);
          if (r && r.cancelled > 0) loadRunningSubagents();
        } catch (_) { /* ignore */ }
      });
    });
  } catch (_) { /* ignore */ }
}

/** 按搜索词 + 筛选过滤 */
function filtered(): any[] {
  const kw = searchTerm.trim().toLowerCase();
  return allAgents.filter((a: any) => {
    if (scopeFilter !== 'all' && a.source !== scopeFilter) return false;
    if (!kw) return true;
    return (String(a.name || '') + ' ' + String(a.description || '')).toLowerCase().includes(kw);
  });
}

function agentCard(a: any): string {
  const srcLabel = a.source === 'project' ? '项目' : '用户';
  return '<div class="ck-skill-item ck-agent-item" data-name="' + escapeAttr(a.name) + '" data-path="' + escapeAttr(a.agentPath) + '">' +
    '<div class="ck-skill-top">' +
      '<span class="ck-skill-name">' + escapeHtml(a.name) + '</span>' +
      '<span class="ck-agent-src-badge">' + srcLabel + '</span>' +
      '<div class="ck-agent-actions">' +
        '<button class="ck-snip-icon-btn" data-detail-agent="' + escapeAttr(a.name) + '" title="详情">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>' +
        '</button>' +
        '<button class="ck-snip-icon-btn" data-edit-agent="' + escapeAttr(a.agentPath) + '" title="编辑">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' +
        '</button>' +
        '<button class="ck-snip-icon-btn danger" data-del-agent="' + escapeAttr(a.agentPath) + '" title="删除">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>' +
    '<div class="ck-skill-desc">' + escapeHtml(a.description || '（无描述）') + '</div>' +
  '</div>';
}

/** 渲染列表（应用搜索/筛选） */
function renderList(): void {
  const listEl = document.getElementById('agent-list');
  if (!listEl) return;
  const agents = filtered();
  if (!agents.length) {
    listEl.innerHTML = '<div class="ck-list-empty">' +
      (allAgents.length ? '没有匹配的子代理' : '未发现子代理<br>（.cuckoo/agents/ 或 ~/.cuckoo/agents/）') +
    '</div>';
    return;
  }
  const userAgents = agents.filter((a: any) => a.source !== 'project');
  const projAgents = agents.filter((a: any) => a.source === 'project');
  let html = '';
  if (userAgents.length) html += '<div class="ck-mcp-group-title">用户级</div>' + userAgents.map(agentCard).join('');
  if (projAgents.length) html += '<div class="ck-mcp-group-title">项目级</div>' + projAgents.map(agentCard).join('');
  listEl.innerHTML = html;
  bindListEvents();
}

function bindListEvents(): void {
  const listEl = document.getElementById('agent-list');
  if (!listEl) return;
  listEl.querySelectorAll('.ck-skill-item').forEach((el: any) => {
    el.addEventListener('click', async (e: any) => {
      if (e.target.closest('[data-edit-agent]') || e.target.closest('[data-del-agent]') || e.target.closest('[data-detail-agent]')) return;
      if (api.appendSnippet) {
        try { await api.appendSnippet('请使用 ' + el.dataset.name + ' 子代理'); } catch (_) { /* ignore */ }
      }
      addRecent('agent', el.dataset.name);
    });
  });
  listEl.querySelectorAll('[data-detail-agent]').forEach((btn: any) => {
    btn.addEventListener('click', (e: any) => {
      e.stopPropagation();
      const a = allAgents.find((x: any) => x.name === btn.dataset.detailAgent);
      if (a) openAgentDetail(a);
    });
  });
  listEl.querySelectorAll('[data-edit-agent]').forEach((btn: any) => {
    btn.addEventListener('click', (e: any) => {
      e.stopPropagation();
      const cardEl = btn.closest('.ck-agent-item');
      openAgentEditModal(btn.dataset.editAgent, cardEl ? cardEl.dataset.name : '');
    });
  });
  listEl.querySelectorAll('[data-del-agent]').forEach((btn: any) => {
    btn.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      if (!(await ckConfirm('确定删除该子代理文件？此操作不可恢复。'))) return;
      if (!api.deleteAgentFile) return;
      try {
        const r = await api.deleteAgentFile(btn.dataset.delAgent);
        if (r && r.success) loadAgents();
        else await ckAlert((r && r.error) || '删除失败');
      } catch (err: any) { await ckAlert('删除失败: ' + (err.message || err)); }
    });
  });
}

export async function loadAgents(): Promise<void> {
  loadRunningSubagents();
  const listEl = document.getElementById('agent-list');
  if (!listEl || !api.listAgents) return;
  try {
    const r = await api.listAgents();
    allAgents = (r && r.success) ? (r.agents || []) : [];
    renderList();
  } catch (_) {
    listEl.innerHTML = '<div class="ck-list-empty">加载失败</div>';
  }
}

// ===== 详情弹窗 =====
function openAgentDetail(a: any): void {
  detailAgent = a;
  const mask = document.getElementById('agent-detail-mask');
  const title = document.getElementById('agent-detail-title');
  const body = document.getElementById('agent-detail-body');
  if (!mask || !title || !body) return;
  title.textContent = a.name || '子代理详情';
  body.innerHTML =
    '<div class="ck-agent-detail-row"><span class="ck-agent-detail-k">名称</span><span class="ck-agent-detail-v">' + escapeHtml(a.name) + '</span></div>' +
    '<div class="ck-agent-detail-row"><span class="ck-agent-detail-k">来源</span><span class="ck-agent-detail-v">' + (a.source === 'project' ? '项目级' : '用户级') + '</span></div>' +
    '<div class="ck-agent-detail-row"><span class="ck-agent-detail-k">描述</span><span class="ck-agent-detail-v">' + escapeHtml(a.description || '（无描述）') + '</span></div>' +
    '<div class="ck-agent-detail-row"><span class="ck-agent-detail-k">路径</span><span class="ck-agent-detail-v ck-agent-detail-path">' + escapeHtml(a.agentPath || '') + '</span></div>' +
    '<div class="ck-agent-detail-actions"><button class="ck-btn ck-btn-secondary" data-agent-use="' + escapeAttr(a.name) + '">在对话中使用</button></div>';
  mask.classList.remove('cuckoo-hidden');
  body.querySelectorAll('[data-agent-use]').forEach((btn: any) => {
    btn.addEventListener('click', async () => {
      if (api.appendSnippet) { try { await api.appendSnippet('请使用 ' + btn.dataset.agentUse + ' 子代理'); } catch (_) { /* ignore */ } }
      addRecent('agent', btn.dataset.agentUse);
      closeAgentDetail();
    });
  });
}
function closeAgentDetail(): void {
  document.getElementById('agent-detail-mask')?.classList.add('cuckoo-hidden');
  detailAgent = null;
}

// ===== 新建 / 编辑 弹窗 =====
let agentEditPath = '';

function openAgentModal(): void {
  const modal = document.getElementById('agent-modal');
  if (!modal) return;
  agentEditPath = '';
  const title = document.getElementById('agent-modal-title');
  if (title) title.textContent = '新建子代理';
  const nameEl = document.getElementById('agent-name') as any;
  if (nameEl) nameEl.value = '';
  const scopeField = document.getElementById('agent-scope-field');
  if (scopeField) scopeField.style.display = '';
  const tip = document.getElementById('agent-modal-tip');
  if (tip) tip.textContent = '生成模板后，会用系统默认程序打开，你直接编辑保存即可。';
  const createBtn = document.getElementById('agent-create');
  if (createBtn) createBtn.textContent = '创建并打开';
  document.getElementById('agent-open-file')?.classList.add('cuckoo-hidden');
  modal.classList.remove('cuckoo-hidden');
  nameEl?.focus();
}

function openAgentEditModal(agentPath: string, curName: string): void {
  const modal = document.getElementById('agent-modal');
  if (!modal) return;
  agentEditPath = agentPath || '';
  const title = document.getElementById('agent-modal-title');
  if (title) title.textContent = '编辑子代理';
  const nameEl = document.getElementById('agent-name') as any;
  if (nameEl) nameEl.value = curName || '';
  const scopeField = document.getElementById('agent-scope-field');
  if (scopeField) scopeField.style.display = 'none';
  const tip = document.getElementById('agent-modal-tip');
  if (tip) tip.textContent = '改名会重命名文件；「打开正文」用系统程序编辑提示词。';
  const createBtn = document.getElementById('agent-create');
  if (createBtn) createBtn.textContent = '保存名称';
  document.getElementById('agent-open-file')?.classList.remove('cuckoo-hidden');
  modal.classList.remove('cuckoo-hidden');
  nameEl?.focus();
}

function closeAgentModal(): void {
  document.getElementById('agent-modal')?.classList.add('cuckoo-hidden');
}

// ===== 事件绑定 =====
document.getElementById('agent-new')?.addEventListener('click', openAgentModal);
document.getElementById('agent-cancel')?.addEventListener('click', closeAgentModal);
document.getElementById('agent-refresh')?.addEventListener('click', loadAgents);

document.getElementById('agent-detail-close')?.addEventListener('click', closeAgentDetail);
document.getElementById('agent-detail-open')?.addEventListener('click', async () => {
  if (!detailAgent || !api.openAgentFile) return;
  try { await api.openAgentFile(detailAgent.agentPath); } catch (err: any) { await ckAlert('打开失败: ' + (err.message || err)); }
});
document.getElementById('agent-detail-copy')?.addEventListener('click', async () => {
  if (!detailAgent) return;
  const p = detailAgent.agentPath || '';
  try { await navigator.clipboard.writeText(p); await ckAlert('已复制路径'); } catch (_) { await ckAlert('复制失败：' + p); }
});

const searchEl = document.getElementById('agent-search') as any;
if (searchEl) {
  searchEl.addEventListener('input', () => { searchTerm = searchEl.value || ''; renderList(); });
}
document.querySelectorAll('#agent-filter .ck-chip').forEach((chip: any) => {
  chip.addEventListener('click', () => {
    scopeFilter = chip.dataset.scope || 'all';
    document.querySelectorAll('#agent-filter .ck-chip').forEach((c: any) => c.classList.toggle('ck-chip-active', c === chip));
    renderList();
  });
});

document.getElementById('agent-open-file')?.addEventListener('click', async () => {
  if (!agentEditPath || !api.openAgentFile) return;
  try {
    const r = await api.openAgentFile(agentEditPath);
    if (r && !r.success) await ckAlert((r && r.error) || '打开失败');
  } catch (err: any) { await ckAlert('打开失败: ' + (err.message || err)); }
});

document.getElementById('agent-create')?.addEventListener('click', async (e: any) => {
  const btn = e.currentTarget;
  const name = ((document.getElementById('agent-name') as any) || {}).value || '';
  if (!name.trim()) { await ckAlert('请填写名称'); return; }
  btn.disabled = true;
  try {
    if (agentEditPath) {
      if (!api.renameAgent) return;
      const rr = await api.renameAgent(agentEditPath, name.trim());
      if (rr && rr.success) { closeAgentModal(); loadAgents(); }
      else await ckAlert((rr && rr.error) || '保存失败');
    } else {
      if (!api.createAgentFile) return;
      const scope = ((document.getElementById('agent-scope') as any) || {}).value || 'project';
      const r = await api.createAgentFile(name.trim(), scope);
      if (r && r.success) {
        closeAgentModal();
        await ckAlert('已创建：' + r.name + '.md\n（已用系统默认程序打开，编辑保存后点「刷新」即可看到）');
        loadAgents();
      } else {
        await ckAlert((r && r.error) || '创建失败');
      }
    }
  } catch (e2: any) {
    await ckAlert('操作失败: ' + (e2.message || e2));
  }
  btn.disabled = false;
});

// ===== 运行中子代理：变化即刷新 + 定时刷新（更新耗时）=====
try {
  const apiAny: any = api as any;
  if (typeof apiAny.onSubagentsChanged === 'function') apiAny.onSubagentsChanged(() => loadRunningSubagents());
} catch (_) { /* ignore */ }
setInterval(() => {
  const el = document.getElementById('agent-running-list');
  if (el) loadRunningSubagents();
}, 1500);
