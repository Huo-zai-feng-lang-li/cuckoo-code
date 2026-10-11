/**
 * 插件界面挂载：接收主进程 'shell-plugin-mount'，往壳页面挂插件 UI。
 * 支持的挂载点：statusbar（状态栏项）、toolbar（工具栏按钮）、sidebar（侧边栏页）。
 */
import { api } from './shared.js';

interface MountSpec {
  pluginId: string;
  target: 'statusbar' | 'toolbar' | 'sidebar';
  id: string;
  spec: any;
}

const mountedStatus = new Set<string>();
const mountedToolbar = new Set<string>();

function mountStatusbar(m: MountSpec): void {
  const key = m.pluginId + ':' + m.id;
  const bar = document.querySelector('.statusbar');
  if (!bar) return;
  // 已存在 → 更新文字（支持动态）
  const exist = bar.querySelector('[data-plugin="' + m.pluginId + '"][data-plugin-id="' + m.id + '"]');
  if (exist) { const lbl = exist.querySelector('.sb-label'); if (lbl) lbl.textContent = (m.spec && m.spec.text) || ''; return; }
  mountedStatus.add(key);
  const el = document.createElement('div');
  el.className = 'sb-item';
  el.setAttribute('data-plugin', m.pluginId);
  el.setAttribute('data-plugin-id', m.id);
  if (m.spec && m.spec.title) el.title = String(m.spec.title);
  el.innerHTML = '<span class="sb-label">' + escapeHtml((m.spec && m.spec.text) || '') + '</span>';
  // 插到末尾（sb-spacer 之前）
  const spacer = bar.querySelector('.sb-spacer');
  if (spacer && spacer.parentNode === bar) bar.insertBefore(el, spacer);
  else bar.appendChild(el);
}

function mountToolbar(m: MountSpec): void {
  const key = m.pluginId + ':' + m.id;
  if (mountedToolbar.has(key)) return;
  mountedToolbar.add(key);
  const bar = document.querySelector('.toolbar');
  if (!bar) return;
  const btn = document.createElement('button');
  btn.className = 'nav-btn';
  btn.setAttribute('data-plugin', m.pluginId);
  btn.setAttribute('data-plugin-id', m.id);
  if (m.spec && m.spec.title) btn.title = String(m.spec.title);
  btn.textContent = (m.spec && m.spec.label) || m.id;
  btn.addEventListener('click', () => {
    try {
      // 1) spec.command：触发该命令（复用命令系统）
      if (m.spec && m.spec.command) {
        const apiAny: any = api as any;
        if (apiAny && typeof apiAny.commandInvoke === 'function') { apiAny.commandInvoke(m.spec.command).catch(() => {}); return; }
      }
      // 2) 回调表（兼容）
      const cb = (window as any).__cuckooPluginToolbarCbs && (window as any).__cuckooPluginToolbarCbs[key];
      if (typeof cb === 'function') cb();
    } catch (_) {}
  });
  bar.appendChild(btn);
}

/** 在壳页面上下文执行插件脚本（new Function，拿到 window.shellAPI 等全局） */
function runPanelScript(pluginId: string, id: string, script: string): void {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'document', 'shellAPI', String(script));
    fn(window, document, (window as any).shellAPI);
    console.log('[plugin-shell] 面板脚本已执行 ' + pluginId + ':' + id);
  } catch (err: any) {
    console.error('[plugin-shell] 面板脚本执行失败 ' + pluginId + ':' + id + ' — ' + (err && err.message ? err.message : err));
  }
}

/**
 * 合并模式：把插件面板作为「子标签」塞进市场面板（#ck-mkt-tabs / #ck-mkt-subpanels）。
 * 用于「活动栏只留一个插件市场图标，所有插件面板融合进去」。
 * @returns 成功合并返回 true；容器不存在返回 false（调用方回退到独立图标）
 */
function mountSidebarMerge(m: MountSpec, key: string, title: string): boolean {
  const tabsBar = document.getElementById('ck-mkt-tabs');
  const panelsHost = document.getElementById('ck-mkt-subpanels');
  if (!tabsBar || !panelsHost) return false;

  const subKey = 'p:' + key;
  const exist = panelsHost.querySelector('[data-subpanel="' + subKey + '"]') as any;
  if (exist) {
    if (m.spec && m.spec.html) exist.innerHTML = m.spec.html;
    if (m.spec && m.spec.script) runPanelScript(m.pluginId, m.id, m.spec.script);
    return true;
  }

  // 子标签按钮
  const tab = document.createElement('button');
  tab.className = 'ck-mkt-subtab';
  tab.setAttribute('data-subtab', subKey);
  tab.textContent = title;
  tabsBar.appendChild(tab);

  // 子面板
  const panel = document.createElement('div');
  panel.className = 'ck-mkt-subpanel';
  panel.setAttribute('data-subpanel', subKey);
  panel.innerHTML = (m.spec && m.spec.html) || '<div style="padding:12px;color:var(--ck-text-dim);font-size:12px">' + escapeHtml(String(title)) + '</div>';
  panelsHost.appendChild(panel);

  if (m.spec && m.spec.script) runPanelScript(m.pluginId, m.id, m.spec.script);
  console.log('[plugin-shell] 已合并插件面板: ' + key + ' (' + title + ')');
  return true;
}

function mountSidebar(m: MountSpec): void {
  // 插件侧边栏页：默认创建「活动栏图标」+「面板」；
  // spec.merge=true 时不建图标，把面板合并进市场面板的子标签（活动栏只留一个市场图标）。
  const key = m.pluginId + ':' + m.id;
  const tabName = 'plugin-' + m.pluginId + '-' + m.id;
  const title = (m.spec && m.spec.title) || m.id;

  if (m.spec && m.spec.merge) {
    if (mountSidebarMerge(m, key, title)) return;
    console.warn('[plugin-shell] 合并容器不存在，回退到独立图标: ' + key);
  }

  const ab = document.querySelector('.ck-activitybar');
  const panelBody = document.querySelector('.ck-panel-body');
  if (!ab || !panelBody) {
    console.warn('[plugin-shell] 挂载失败（缺容器）: ' + key + ' ab=' + !!ab + ' panelBody=' + !!panelBody);
    return;
  }

  // 已存在 → 更新内容 + 重跑脚本
  const existPanel = panelBody.querySelector('[data-plugin-panel="' + key + '"]') as any;
  if (existPanel) {
    if (m.spec && m.spec.html) existPanel.innerHTML = m.spec.html;
    if (m.spec && m.spec.script) runPanelScript(m.pluginId, m.id, m.spec.script);
    return;
  }

  // 活动栏图标
  const icon = document.createElement('button');
  icon.className = 'ck-ab-item';
  icon.setAttribute('data-tab', tabName);
  icon.setAttribute('data-plugin-tab', key);
  icon.title = String(title);
  // 无 icon 时用标题首字（比统一的小地球图标更易区分）
  icon.innerHTML = (m.spec && m.spec.icon)
    ? String(m.spec.icon)
    : '<span class="ck-ab-text">' + escapeHtml(String(title).charAt(0) || 'P') + '</span>';
  const spacer = ab.querySelector('.ck-ab-spacer');
  if (spacer) ab.insertBefore(icon, spacer); else ab.appendChild(icon);

  // 面板（.ck-tab + data-panel，由 activateTab 切换 ck-tab-active）
  const panel = document.createElement('div');
  panel.className = 'ck-tab';
  panel.setAttribute('data-panel', tabName);
  panel.setAttribute('data-plugin-panel', key);
  panel.innerHTML = (m.spec && m.spec.html) || '<div style="padding:12px;color:var(--ck-text-dim);font-size:12px">' + escapeHtml(String(title)) + '</div>';
  panelBody.appendChild(panel);

  // ⚠️ innerHTML 里的 <script> 不会执行，隐藏容器里的 <img onerror> 也不触发。
  // 插件面板的初始化逻辑必须走 spec.script，由这里主动执行。
  if (m.spec && m.spec.script) runPanelScript(m.pluginId, m.id, m.spec.script);

  // 兜底样式：插件面板默认隐藏，激活时显示
  if (!document.getElementById('ck-plugin-panel-style')) {
    const st = document.createElement('style');
    st.id = 'ck-plugin-panel-style';
    st.textContent = '[data-plugin-panel]{display:none}[data-plugin-panel].ck-tab-active{display:block}';
    document.head.appendChild(st);
  }
}

/** 通用槽位渲染（对标 DSH slots）：按 slot 找容器，按 order 排序插入 */
function mountSlot(m: any): void {
  if (!m || !m.slot || !m.id) return;
  const key = m.pluginId + ':' + m.slot + ':' + m.id;
  const existing = document.querySelector('[data-slot-key="' + key + '"]');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  const order = typeof m.order === 'number' ? m.order : 100;
  const spec = m.spec || {};
  const el = document.createElement('button');
  el.className = 'ck-ab-item';
  el.setAttribute('data-slot-key', key);
  el.setAttribute('data-plugin', m.pluginId);
  if (spec.title) el.title = String(spec.title);
  el.innerHTML = spec.icon ? String(spec.icon) : (spec.label ? escapeHtml(String(spec.label)) : escapeHtml(m.id));
  el.addEventListener('click', () => {
    try {
      const apiAny: any = api as any;
      if (spec.command && apiAny && typeof apiAny.commandInvoke === 'function') { apiAny.commandInvoke(spec.command).catch(() => {}); }
    } catch (_) {}
  });
  // 找容器（按 slot 名）
  let container: any = null;
  if (m.slot === 'activitybar') container = document.querySelector('.ck-activitybar');
  else if (m.slot === 'toolbar') container = document.querySelector('.toolbar');
  else if (m.slot === 'statusbar') container = document.querySelector('.statusbar');
  if (!container) return;
  // activitybar：插到 spacer 前；其余：按 order 插到末尾
  const spacer = container.querySelector('.ck-ab-spacer');
  if (m.slot === 'activitybar' && spacer) container.insertBefore(el, spacer);
  else container.appendChild(el);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** 注入/更新某插件的 <style>（data-plugin 标记，便于卸载清理） */
function applyShellStyle(pluginId: string, css: string): void {
  if (!pluginId || typeof css !== 'string') return;
  let tag = document.querySelector('style[data-plugin-style="' + pluginId + '"]') as any;
  if (!tag) {
    tag = document.createElement('style');
    tag.setAttribute('data-plugin-style', pluginId);
    document.head.appendChild(tag);
  }
  tag.textContent = css;
}

/** 移除某插件的 <style> */
function removeShellStyle(pluginId: string): void {
  if (!pluginId) return;
  const tag = document.querySelector('style[data-plugin-style="' + pluginId + '"]');
  if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
}

export function initPluginShell(): void {
  const wlog: any = (window as any);
  wlog.__shellMountLog = wlog.__shellMountLog || { received: [], pulled: null };
  try {
    const apiAny: any = api as any;
    // 插件注入壳页面 CSS（对标 DSH styles.insert）
    if (apiAny && typeof apiAny.onPluginShellStyle === 'function') {
      apiAny.onPluginShellStyle((m: any) => {
        try { if (m && m.pluginId) applyShellStyle(m.pluginId, m.css); } catch (_) {}
      });
    }
    if (apiAny && typeof apiAny.onPluginShellStyleRemove === 'function') {
      apiAny.onPluginShellStyleRemove((m: any) => {
        try { if (m && m.pluginId) removeShellStyle(m.pluginId); } catch (_) {}
      });
    }
    // 插件背景图（基座负责对齐）
    const applyBg = (data: any) => {
      let tag = document.getElementById('ck-plugin-bg') as any;
      if (!data || !data.url) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('style'); tag.id = 'ck-plugin-bg'; document.head.appendChild(tag); }
      const overlay = data.overlay || 'rgba(10,12,20,0.5)';
      const w = data.winW || window.innerWidth, h = data.winH || window.innerHeight;
      tag.textContent = 'body { background: linear-gradient(' + overlay + ',' + overlay + '), url(' + data.url + ') no-repeat fixed !important;' +
        'background-size: auto, ' + w + 'px ' + h + 'px !important;' +
        'background-position: 0 0, 0 0 !important; }' +
        '.shell { background: transparent !important; }';
    };
    if (apiAny && typeof apiAny.onShellBackground === 'function') apiAny.onShellBackground(applyBg);
    if (apiAny && typeof apiAny.getShellBackground === 'function') {
      apiAny.getShellBackground().then((r: any) => { if (r && r.success) applyBg(r.background); }).catch(() => {});
    }
    if (apiAny && typeof apiAny.listPluginShellStyles === 'function') {
      apiAny.listPluginShellStyles().then((r: any) => {
        if (!r || !r.success || !Array.isArray(r.styles)) return;
        for (const s of r.styles) { try { applyShellStyle(s.pluginId, s.css); } catch (_) {} }
      }).catch(() => {});
    }
    if (apiAny && typeof apiAny.onPluginShellMount === 'function') {
      apiAny.onPluginShellMount((m: MountSpec) => {
        try {
          wlog.__shellMountLog.received.push(m && m.target + ':' + (m && m.id));
          if (!m || !m.target) return;
          if (m.target === 'statusbar') mountStatusbar(m);
          else if (m.target === 'toolbar') mountToolbar(m);
          else if (m.target === 'sidebar') mountSidebar(m);
        } catch (_) {}
      });
    }
    if (apiAny && typeof apiAny.listPluginShellMounts === 'function') {
      apiAny.listPluginShellMounts().then((r: any) => {
        wlog.__shellMountLog.pulled = r;
        if (!r || !r.success || !Array.isArray(r.mounts)) return;
        for (const m of r.mounts) {
          try {
            if (m.target === 'statusbar') mountStatusbar(m);
            else if (m.target === 'toolbar') mountToolbar(m);
            else if (m.target === 'sidebar') mountSidebar(m);
          } catch (_) {}
        }
      }).catch(() => {});
    }
    // 通用槽位（对标 DSH slots）
    if (apiAny && typeof apiAny.onPluginSlotRegister === 'function') {
      apiAny.onPluginSlotRegister((m: any) => { try { mountSlot(m); } catch (_) {} });
    }
    if (apiAny && typeof apiAny.onPluginSlotUnregister === 'function') {
      apiAny.onPluginSlotUnregister((m: any) => {
        try { const k = m.pluginId + ':' + m.slot + ':' + m.id; const el = document.querySelector('[data-slot-key="' + k + '"]'); if (el && el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
      });
    }
    if (apiAny && typeof apiAny.listPluginSlots === 'function') {
      apiAny.listPluginSlots().then((r: any) => { if (r && r.success && Array.isArray(r.slots)) { for (const m of r.slots) { try { mountSlot(m); } catch (_) {} } } }).catch(() => {});
    }
  } catch (_) {}
}
