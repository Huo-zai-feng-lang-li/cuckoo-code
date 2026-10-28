/**
 * 设置页：失败重试 / 发送延迟 / 附件间隔。
 */
import { api, ckAlert, ckConfirm, escapeHtml, escapeAttr } from '../shared.js';
import { getHiddenTabs, toggleTab } from '../activitybar-visibility.js';

const SET_FIELDS: [string, string][] = [
  ['retry-delay-min', 'retryDelayMin'],
  ['retry-delay-max', 'retryDelayMax'],
  ['retry-count', 'retryCount'],
  ['retry-429-delay', 'retry429Delay'],
  ['retry-429-count', 'retry429Count'],
  ['retry-prompt', 'retryPrompt'],
  ['xhr-idle-timeout', 'xhrIdleTimeout'],
  ['watchdog-prompt', 'watchdogPrompt'],
  ['watchdog-count', 'watchdogCount'],
  ['send-delay-min', 'sendDelayMin'],
  ['send-delay-max', 'sendDelayMax'],
  ['attach-delay-min', 'attachDelayMin'],
  ['attach-delay-max', 'attachDelayMax'],
];

function setVal(id: string, v: any): void {
  const el = document.getElementById('st-' + id) as any;
  if (el) el.value = (v === null || v === undefined) ? '' : v;
}
function getVal(id: string): string {
  const el = document.getElementById('st-' + id) as any;
  return el ? el.value : '';
}
function renderSettings(data: any): void {
  if (!data) return;
  const enEl = document.getElementById('st-retry-enabled') as any;
  if (enEl) enEl.checked = data.retryEnabled !== false;
  const ssrfEl = document.getElementById('st-ssrf-guard') as any;
  if (ssrfEl) ssrfEl.checked = data.ssrfGuard === true;
  for (const [id, key] of SET_FIELDS) setVal(id, data[key]);
}

export async function loadSettings(): Promise<void> {
  // 每次打开设置页都重渲染图标开关：插件图标是异步挂载的，需读到最新 DOM
  try { renderActivitybarToggles(); } catch (_) { /* ignore */ }
  loadExecutionPolicy();
  loadTrustedWorkspaces();
  if (!api.getSettings) return;
  try {
    const r = await api.getSettings();
    if (r && r.success && r.data) renderSettings(r.data);
  } catch (_) { /* ignore */ }
}

/**
 * 已变更但尚未成功保存的字段（key 与 collectSettings 返回的对象键一致）。
 * 保存时只提交这些字段 —— 设置已全局化（主进程 agent-settings.json 为唯一真相源），
 * 若每次提交全量，两个窗口同时改不同字段会互相覆盖（后保存的把对方刚写的冲掉）。
 */
const dirty = new Set<string>();

function collectSettings(): any {
  const num = (id: string) => { const n = parseFloat(getVal(id)); return Number.isFinite(n) ? n : 0; };
  const enEl = document.getElementById('st-retry-enabled') as any;
  const ssrfEl = document.getElementById('st-ssrf-guard') as any;
  return {
    retryEnabled: !!(enEl && enEl.checked),
    ssrfGuard: !!(ssrfEl && ssrfEl.checked),
    retryDelayMin: num('retry-delay-min'),
    retryDelayMax: num('retry-delay-max'),
    retryCount: parseInt(getVal('retry-count'), 10) || 0,
    retry429Delay: num('retry-429-delay'),
    retry429Count: parseInt(getVal('retry-429-count'), 10) || 0,
    retryPrompt: getVal('retry-prompt'),
    xhrIdleTimeout: num('xhr-idle-timeout'),
    watchdogPrompt: getVal('watchdog-prompt'),
    watchdogCount: parseInt(getVal('watchdog-count'), 10) || 0,
    sendDelayMin: num('send-delay-min'),
    sendDelayMax: num('send-delay-max'),
    attachDelayMin: num('attach-delay-min'),
    attachDelayMax: num('attach-delay-max'),
  };
}

// ===== 即时保存：任一表单项变更后立即写入（不再需要"保存设置"按钮）=====
// 并发保护：保存期间若再次变更，标记 pending，当前保存完成后再补存一次（不丢最后修改）
let saving = false;
let savePending = false;
/** reset 进行中：屏蔽即时保存，避免把用户改动写回、污染 reset 结果 */
let resetting = false;
async function saveNow(): Promise<void> {
  if (!api.saveSettings || resetting) return;
  if (saving) { savePending = true; return; }
  saving = true;
  // 循环到 pending 清空为止：每轮 await 让出事件循环，期间新增的 change 会置 savePending
  for (;;) {
    savePending = false;
    // 只提交本轮待保存的字段（增量）。dirty 为空 → 无变更可提交，直接退出。
    // 绝不能回退成全量提交：设置已全局化，全量提交会覆盖其他窗口刚改的字段。
    const keys = Array.from(dirty);
    if (keys.length === 0) break;
    const all = collectSettings();
    const payload: any = {};
    for (const k of keys) payload[k] = all[k];
    try {
      const r = await api.saveSettings(payload);
      // 成功才清 dirty：失败会 loadSettings 回滚，dirty 由后续 change 重新填充
      if (r && r.success) { for (const k of keys) dirty.delete(k); }
      if (!(r && r.success)) {
        // 校验失败（如区间 min>max）：提示并回滚到已保存值，丢弃期间的 pending
        await ckAlert((r && r.error) || '保存失败');
        await loadSettings();
        break;
      }
    } catch (e: any) {
      await ckAlert('保存失败: ' + (e.message || e));
      await loadSettings();
      break;
    }
    if (!savePending) break;
  }
  saving = false;
}
// 数字/文本字段：change（失焦或回车）时保存（只提交该字段）
for (const [id, key] of SET_FIELDS) {
  document.getElementById('st-' + id)?.addEventListener('change', () => { dirty.add(key); saveNow(); });
}
// 开关项：切换即保存（只提交该字段）
document.getElementById('st-retry-enabled')?.addEventListener('change', () => { dirty.add('retryEnabled'); saveNow(); });
document.getElementById('st-ssrf-guard')?.addEventListener('change', () => { dirty.add('ssrfGuard'); saveNow(); });
// 刷新：重新读取全部设置（失败重试 + 纯净模式字号 + 主题）
// 注意：只调用"取值"函数，不调用 initThemeListener，避免重复注册监听器。
document.getElementById('st-refresh')?.addEventListener('click', () => {
  loadSettings();
  loadUiPrefs();
  refreshThemeValue();
  renderActivitybarToggles();
});
// 恢复默认：覆盖本页全部设置（表单组 + 主题 + 字号 + 活动栏图标 + 执行策略）
document.getElementById('st-reset')?.addEventListener('click', async () => {
  if (!(await ckConfirm('确定恢复默认设置？'))) return;
  const anyApi = api as any;
  // 门控：reset 期间屏蔽即时保存，避免竞态把用户改动写回污染 reset 结果
  resetting = true;
  saving = false;
  savePending = false;
  // 清空待保存字段：否则 reset 后首次改单个字段时，会把 reset 前的陈旧字段值一并提交
  dirty.clear();
  try {
    // 1) 表单组（重试/延迟/超时/SSRF）
    if (api.resetSettings) {
      try {
        const r = await api.resetSettings();
        if (r && r.success && r.data) renderSettings(r.data);
      } catch (_) { /* 单项失败不中断后续 */ }
    }
    // 2) 主题回默认 dark（独立 try，非 Promise 或抛错都不影响后续步骤）
    if (typeof anyApi.themeSet === 'function') {
      try { await anyApi.themeSet('dark'); } catch (_) { /* ignore */ }
    }
    // 3) 纯净模式字号回默认（1.0）
    if (typeof anyApi.setUiPrefs === 'function') {
      try { await anyApi.setUiPrefs({ harnessZoom: 1.0 }); } catch (_) { /* ignore */ }
    }
    // 4) 活动栏图标全部显示
    try {
      const bar = document.querySelector('.ck-activitybar');
      bar?.querySelectorAll('.ck-ab-item[data-tab]').forEach((el: any) => {
        if (el.dataset.tab) toggleTab(el.dataset.tab, true);
      });
    } catch (_) { /* ignore */ }
    // 5) 执行策略回"智能"
    if (typeof api.setExecutionPolicy === 'function') {
      try {
        const r2 = await api.setExecutionPolicy('smart');
        if (r2 && r2.success) setExecPolicyUI(r2.mode || 'smart');
      } catch (_) { /* ignore */ }
    }
    // 6) 重新载入全部 UI 回显
    try { await loadSettings(); } catch (_) { /* ignore */ }
    loadUiPrefs();
    refreshThemeValue();
    renderActivitybarToggles();
  } finally {
    resetting = false;
  }
});

// ===== 外观：主题下拉（走主进程 theme API，不归 settings 存取）=====
const themeSelect = document.getElementById('st-theme-select') as any;
const THEME_BUILTINS: [string, string][] = [
  ['system', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
];
function fillThemeOptions(registered: any[]): void {
  if (!themeSelect) return;
  const opts: [string, string][] = THEME_BUILTINS.slice();
  for (const t of (registered || [])) {
    // 内置 light/dark 已在上面，跳过
    if (t && t.id && t.id !== 'light' && t.id !== 'dark') opts.push([t.id, t.id]);
  }
  const cur = themeSelect.value;
  themeSelect.innerHTML = opts.map(([v, label]) =>
    '<option value="' + escapeAttr(v) + '">' + escapeHtml(label) + '</option>').join('');
  if (cur) themeSelect.value = cur;
}
/** 刷新当前主题值（只取值，可重复调用；不注册监听） */
function refreshThemeValue(): void {
  const anyApi = api as any;
  if (!themeSelect || typeof anyApi.themeGet !== 'function') return;
  anyApi.themeGet().then((r: any) => {
    if (r && r.success && r.snapshot) {
      fillThemeOptions(r.snapshot.themes);
      themeSelect.value = r.snapshot.preference || 'system';
    }
  }).catch(() => {});
}
/** 注册主题变化监听（仅启动时调用一次，避免重复注册泄漏） */
function initThemeListener(): void {
  const anyApi = api as any;
  if (typeof anyApi.onThemeChanged !== 'function') return;
  anyApi.onThemeChanged((snap: any) => {
    if (!snap) return;
    fillThemeOptions(snap.themes);
    if (themeSelect) themeSelect.value = snap.preference || 'system';
  });
}
if (themeSelect) {
  themeSelect.addEventListener('change', () => {
    const anyApi = api as any;
    if (typeof anyApi.themeSet === 'function') {
      anyApi.themeSet(themeSelect.value).catch(() => {});
    }
  });
  refreshThemeValue();
  initThemeListener();
}

// ===== 活动栏图标显隐 =====
/** tab → 显示名（内置图标用固定中文名；插件图标回退用 title） */
const AB_LABELS: Record<string, string> = {
  workspaces: '工作区（会话）', files: '项目文件', git: '源代码管理', tasks: '任务',
  snippets: '提示词', memories: '记忆', skills: '技能', plugins: '插件市场',
  agents: '子代理', rules: '全局规则', mcp: 'MCP（连接器）', windows: '窗口',
  token: 'Token（词元）', remote: '远程控制（手机）', about: '关于', settings: '设置',
};
/** 从活动栏 DOM 读取当前全部图标（含插件动态挂载的），返回 [tab, label, isPlugin] */
function collectActivitybarItems(): Array<[string, string, boolean]> {
  const bar = document.querySelector('.ck-activitybar');
  const out: Array<[string, string, boolean]> = [];
  if (!bar) return out;
  bar.querySelectorAll('.ck-ab-item[data-tab]').forEach((el: any) => {
    const tab = el.dataset.tab;
    if (!tab) return;
    const isPlugin = el.dataset.pluginTab !== undefined;
    // title 可能已被全局 tooltip 引擎转存为 data-ck-title 并移除 → 一并兜底
    const label = AB_LABELS[tab]
      || el.getAttribute('title')
      || el.getAttribute('data-ck-title')
      || el.getAttribute('data-tooltip')
      || el.textContent
      || tab;
    out.push([tab, String(label).trim(), isPlugin]);
  });
  return out;
}
/** 渲染活动栏显隐开关列表（幂等；动态读取 DOM 以覆盖插件图标） */
export function renderActivitybarToggles(): void {
  const box = document.getElementById('st-ab-list');
  if (!box) return;
  const items = collectActivitybarItems();
  const hidden = new Set(getHiddenTabs());
  box.innerHTML = items.map(([tab, label, isPlugin]) => {
    const isSettings = tab === 'settings';
    const disabled = isSettings ? ' disabled' : '';
    const checked = (isSettings || !hidden.has(tab)) ? ' checked' : '';
    const title = isPlugin ? ' title="插件图标"' : '';
    return '<div class="ck-set-field ck-set-toggle"' + title + '>' +
      '<span class="ck-set-key">' + escapeHtml(label) + (isPlugin ? '（插件）' : '') + '</span>' +
      '<label class="ck-switch">' +
        '<input type="checkbox" data-ab-tab="' + escapeAttr(tab) + '"' + checked + disabled + ' />' +
        '<span class="ck-switch-track"></span>' +
      '</label>' +
    '</div>';
  }).join('');
  box.querySelectorAll('input[data-ab-tab]').forEach((el: any) => {
    el.addEventListener('change', () => {
      toggleTab(el.dataset.abTab, el.checked);
    });
  });
}
// 初始化渲染（模块加载时）
try { renderActivitybarToggles(); } catch (_) { /* ignore */ }
// 插件图标异步挂载 → 若设置页已打开，刷新图标显隐列表
window.addEventListener('cuckoo-activitybar-mounted', () => {
  try { renderActivitybarToggles(); } catch (_) { /* ignore */ }
});
// 通用折叠分组：点标题展开/收起。展开活动栏分组时刷新图标列表（插件图标异步挂载）
document.querySelectorAll<HTMLElement>('.ck-collapse-head[data-collapse]').forEach((head) => {
  const key = head.dataset.collapse;
  const body = document.querySelector<HTMLElement>('.ck-collapse-body[data-collapse-body="' + key + '"]');
  if (!body) return;
  head.addEventListener('click', () => {
    const collapsed = body.classList.toggle('cuckoo-hidden');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (!collapsed && key === 'activitybar') {
      try { renderActivitybarToggles(); } catch (_) { /* ignore */ }
    }
  });
});

// ===== 外观：纯净模式字号（缩放，走主进程 ui-prefs，独立于 settings 存取）=====
const zoomSelect = document.getElementById('st-harness-zoom') as any;
/** 重新读取字号设置（刷新按钮也会调用） */
export function loadUiPrefs(): void {
  if (!zoomSelect) return;
  const anyApi = api as any;
  if (typeof anyApi.getUiPrefs === 'function') {
    anyApi.getUiPrefs().then((r: any) => {
      if (r && r.success && r.data && typeof r.data.harnessZoom === 'number') {
        zoomSelect.value = String(r.data.harnessZoom);
      }
    }).catch(() => {});
  }
}
if (zoomSelect) {
  const anyApi = api as any;
  // 载入当前值
  loadUiPrefs();
  // 切换即保存 + 立即应用
  zoomSelect.addEventListener('change', () => {
    const z = parseFloat(zoomSelect.value);
    if (!Number.isFinite(z)) return;
    if (typeof anyApi.setUiPrefs === 'function') {
      anyApi.setUiPrefs({ harnessZoom: z }).catch(() => {});
    }
  });
}

// ===== 安全：执行策略（三档单选，切换即持久化）=====
const EXEC_MODES = ['smart', 'workspace', 'strict'] as const;
type ExecMode = (typeof EXEC_MODES)[number];
/** 当前已生效的策略档（用于失败回退 UI） */
let currentExecMode: ExecMode = 'smart';

/**
 * 把执行策略回显到单选组。
 * @param mode 主进程返回的模式，非法值按 smart 处理
 */
function setExecPolicyUI(mode: string): void {
  const m: ExecMode = (EXEC_MODES as readonly string[]).includes(mode) ? (mode as ExecMode) : 'smart';
  currentExecMode = m;
  document.querySelectorAll<HTMLInputElement>('input[name="st-exec-policy"]').forEach((el) => {
    el.checked = el.value === m;
  });
}

/** 读取当前执行策略并回显（打开设置页/点刷新时调用） */
export function loadExecutionPolicy(): void {
  if (typeof api.getExecutionPolicy !== 'function') return;
  api.getExecutionPolicy().then((r) => {
    if (r && r.success) setExecPolicyUI(r.mode || 'smart');
  }).catch(() => {});
}

// 切换即写入主进程；失败回退上一档并提示
document.querySelectorAll<HTMLInputElement>('input[name="st-exec-policy"]').forEach((el) => {
  el.addEventListener('change', async () => {
    if (!el.checked || typeof api.setExecutionPolicy !== 'function') return;
    const next = el.value as ExecMode;
    try {
      const r = await api.setExecutionPolicy(next);
      if (r && r.success) {
        // 以主进程回显为准（非法值会被主进程回退 smart）
        setExecPolicyUI(r.mode || next);
      } else {
        setExecPolicyUI(currentExecMode);
        await ckAlert((r && r.error) || '切换执行策略失败');
      }
    } catch (e: any) {
      setExecPolicyUI(currentExecMode);
      await ckAlert('切换执行策略失败: ' + (e.message || e));
    }
  });
});

// ===== 安全：受信任工作区列表 =====
/**
 * 渲染受信任工作区。路径与时间均走 textContent（禁止拼进 innerHTML，防路径注入）。
 * @param list 受信任工作区 [{ path, since? }]
 */
function renderTrustedWorkspaces(list: Array<{ path: string; since?: string }>): void {
  const box = document.getElementById('st-trusted-ws-list');
  if (!box) return;
  box.textContent = '';
  if (!list || list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ck-ws-empty';
    empty.textContent = '暂无受信任的工作区';
    box.appendChild(empty);
    return;
  }
  for (const ws of list) {
    if (!ws || !ws.path) continue;
    const row = document.createElement('div');
    row.className = 'ck-ws-row';

    const pathEl = document.createElement('span');
    pathEl.className = 'ck-ws-path';
    pathEl.textContent = ws.path;
    pathEl.title = ws.path;

    const sinceEl = document.createElement('span');
    sinceEl.className = 'ck-ws-since';
    const t = ws.since ? new Date(ws.since).getTime() : NaN;
    sinceEl.textContent = Number.isFinite(t) ? new Date(t).toLocaleString() : '';

    const btn = document.createElement('button');
    btn.className = 'ck-btn-text';
    btn.type = 'button';
    btn.textContent = '撤销信任';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (typeof api.revokeWorkspaceTrust !== 'function') { btn.disabled = false; return; }
      try {
        const r = await api.revokeWorkspaceTrust(ws.path);
        if (r && r.success) loadTrustedWorkspaces();
        else { await ckAlert((r && r.error) || '撤销信任失败'); btn.disabled = false; }
      } catch (e: any) {
        await ckAlert('撤销信任失败: ' + (e.message || e));
        btn.disabled = false;
      }
    });

    row.appendChild(pathEl);
    row.appendChild(sinceEl);
    row.appendChild(btn);
    box.appendChild(row);
  }
}

/** 拉取并渲染受信任工作区（打开设置页/撤销后调用） */
export function loadTrustedWorkspaces(): void {
  if (typeof api.getTrustedWorkspaces !== 'function') return;
  api.getTrustedWorkspaces().then((r) => {
    if (r && r.success) renderTrustedWorkspaces(r.workspaces || []);
  }).catch(() => {});
}
