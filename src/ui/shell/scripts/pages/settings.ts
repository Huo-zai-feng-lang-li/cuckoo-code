/**
 * 设置页：失败重试 / 发送延迟 / 附件间隔。
 */
import { api, ckAlert, ckConfirm } from '../shared.js';
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
  if (!api.getSettings) return;
  try {
    const r = await api.getSettings();
    if (r && r.success && r.data) renderSettings(r.data);
  } catch (_) { /* ignore */ }
}

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

const stSaveBtn = document.getElementById('st-save') as any;
if (stSaveBtn) stSaveBtn.addEventListener('click', async () => {
  if (!api.saveSettings) return;
  stSaveBtn.disabled = true;
  try {
    const r = await api.saveSettings(collectSettings());
    if (r && r.success) {
      if (r.data) renderSettings(r.data);
      stSaveBtn.textContent = '已保存';
      setTimeout(() => { stSaveBtn.textContent = '保存设置'; }, 1200);
    } else {
      await ckAlert((r && r.error) || '保存失败');
    }
  } catch (e: any) { await ckAlert('保存失败: ' + (e.message || e)); }
  stSaveBtn.disabled = false;
});
// 刷新：重新读取全部设置（失败重试 + 纯净模式字号 + 主题）
// 注意：只调用"取值"函数，不调用 initThemeListener，避免重复注册监听器。
document.getElementById('st-refresh')?.addEventListener('click', () => {
  loadSettings();
  loadUiPrefs();
  refreshThemeValue();
  renderActivitybarToggles();
});
document.getElementById('st-reset')?.addEventListener('click', async () => {
  if (!api.resetSettings) return;
  if (!(await ckConfirm('确定恢复默认设置？'))) return;
  try {
    const r = await api.resetSettings();
    if (r && r.success && r.data) renderSettings(r.data);
  } catch (_) { /* ignore */ }
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
    '<option value="' + v + '">' + label + '</option>').join('');
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
/** 活动栏图标清单（tab → 显示名）；与 activitybar.html 的 data-tab 对应 */
const AB_ITEMS: [string, string][] = [
  ['workspaces', '工作区（会话）'],
  ['files', '项目文件'],
  ['git', '源代码管理'],
  ['tasks', '任务'],
  ['snippets', '提示词'],
  ['memories', '记忆'],
  ['skills', '技能'],
  ['plugins', '插件市场'],
  ['agents', '子代理'],
  ['rules', '全局规则'],
  ['mcp', 'MCP（连接器）'],
  ['windows', '窗口'],
  ['token', 'Token（词元）'],
  ['remote', '远程控制（手机）'],
  ['about', '关于'],
  ['settings', '设置（不可隐藏）'],
];
/** 渲染活动栏显隐开关列表（幂等） */
export function renderActivitybarToggles(): void {
  const box = document.getElementById('st-ab-list');
  if (!box) return;
  const hidden = new Set(getHiddenTabs());
  box.innerHTML = AB_ITEMS.map(([tab, label]) => {
    const disabled = tab === 'settings' ? ' disabled' : '';
    const checked = (tab === 'settings' || !hidden.has(tab)) ? ' checked' : '';
    return '<div class="ck-set-field ck-set-toggle">' +
      '<span class="ck-set-key">' + label + '</span>' +
      '<label class="ck-switch">' +
        '<input type="checkbox" data-ab-tab="' + tab + '"' + checked + disabled + ' />' +
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
