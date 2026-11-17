/**
 * MCP（连接器）页：列出 server，点击追加"请使用 xxx 这个 MCP"；
 * 悬停卡片显示「连接/断开、打开配置、删除」（与其它列表页同一套交互）。
 */
import { api, ckAlert, ckConfirm, escapeHtml, escapeAttr } from '../shared.js';
import { addRecent } from '../recent.js';

const ICON_POWER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.5 7a8 8 0 1 0 11 0"/></svg>';
const ICON_FILE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

export async function loadMcpServers(): Promise<void> {
  const listEl = document.getElementById('mcp-list');
  if (!listEl || !api.listMcpServers) return;
  try {
    const r = await api.listMcpServers();
    const servers = (r && r.success) ? r.servers : [];
    if (!servers || servers.length === 0) {
      listEl.innerHTML = '<div class="ck-list-empty">未配置 MCP server</div>';
      return;
    }
    const cardHtml = (s: any) => {
      const dotCls = s.connected ? 'ck-mcp-dot on' : 'ck-mcp-dot';
      const scope = s.source === 'project' ? 'project' : 'user';
      const powerTitle = s.connected ? '断开' : '连接';
      return '<div class="ck-mcp-item" data-name="' + escapeAttr(s.name) + '" data-scope="' + scope + '">' +
        '<div class="ck-mcp-top">' +
          '<span class="' + dotCls + '"></span>' +
          '<span class="ck-mcp-name">' + escapeHtml(s.name) + '</span>' +
          '<div class="ck-agent-actions">' +
            '<button class="ck-snip-icon-btn" data-power-mcp="' + escapeAttr(s.name) + '" data-on="' + (s.connected ? '1' : '0') + '" title="' + powerTitle + '">' + ICON_POWER + '</button>' +
            '<button class="ck-snip-icon-btn" data-open-mcp="' + scope + '" title="打开配置文件">' + ICON_FILE + '</button>' +
            '<button class="ck-snip-icon-btn danger" data-del-mcp="' + escapeAttr(s.name) + '" title="删除">' + ICON_TRASH + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="ck-mcp-bottom">' +
          '<span class="ck-mcp-tag">' + escapeHtml(s.type || 'stdio') + '</span>' +
          '<span class="ck-mcp-tag">' + (s.toolCount || 0) + ' 工具</span>' +
        '</div>' +
      '</div>';
    };
    const userServers = servers.filter((s: any) => s.source !== 'project');
    const projServers = servers.filter((s: any) => s.source === 'project');
    let html = '';
    if (userServers.length) html += '<div class="ck-mcp-group-title">用户级</div>' + userServers.map(cardHtml).join('');
    if (projServers.length) html += '<div class="ck-mcp-group-title">项目级</div>' + projServers.map(cardHtml).join('');
    listEl.innerHTML = html;

    listEl.querySelectorAll('.ck-mcp-item').forEach((el: any) => {
      el.addEventListener('click', async (e: any) => {
        // 操作按钮自己处理点击，不能顺带插入提示词
        if (e.target.closest('[data-power-mcp]') || e.target.closest('[data-open-mcp]') || e.target.closest('[data-del-mcp]')) return;
        if (api.appendSnippet) {
          try { await api.appendSnippet('请使用 ' + el.dataset.name + ' 这个 MCP'); } catch (_) { /* ignore */ }
        }
        addRecent('mcp', el.dataset.name);
      });
    });

    listEl.querySelectorAll('[data-power-mcp]').forEach((btn: any) => {
      btn.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        const name = btn.dataset.powerMcp;
        const connected = btn.dataset.on === '1';
        try {
          const rr = connected ? await api.disableMcpServer?.(name) : await api.enableMcpServer?.(name);
          if (rr && !rr.success) await ckAlert((rr && rr.error) || '操作失败');
        } catch (err: any) { await ckAlert('操作失败: ' + (err.message || err)); }
        loadMcpServers();
      });
    });

    listEl.querySelectorAll('[data-open-mcp]').forEach((btn: any) => {
      btn.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        if (!api.openMcpConfig) return;
        try {
          const rr = await api.openMcpConfig(btn.dataset.openMcp);
          if (rr && !rr.success) await ckAlert((rr && rr.error) || '打开配置失败');
        } catch (err: any) { await ckAlert('打开配置失败: ' + (err.message || err)); }
      });
    });

    listEl.querySelectorAll('[data-del-mcp]').forEach((btn: any) => {
      btn.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        const cardEl = btn.closest('.ck-mcp-item');
        const name = btn.dataset.delMcp;
        const isProject = cardEl ? cardEl.dataset.scope === 'project' : false;
        const scopeTip = isProject
          ? '只删除当前项目级配置（.agents/mcp.json），不影响其它项目。'
          : '用户级配置全局生效，删除后所有项目都不再使用该 server。';
        const ok = await ckConfirm('确定删除 MCP server「' + name + '」？\n' + scopeTip, '删除 MCP');
        if (!ok) return;
        if (!api.removeMcpServer) return;
        try {
          const rr = await api.removeMcpServer(name, isProject ? 'project' : 'user');
          if (rr && rr.success) loadMcpServers();
          else await ckAlert((rr && rr.error) || '删除失败');
        } catch (err: any) { await ckAlert('删除失败: ' + (err.message || err)); }
      });
    });
  } catch (_) {
    listEl.innerHTML = '<div class="ck-list-empty">加载失败</div>';
  }
}

document.getElementById('mcp-refresh')?.addEventListener('click', loadMcpServers);
