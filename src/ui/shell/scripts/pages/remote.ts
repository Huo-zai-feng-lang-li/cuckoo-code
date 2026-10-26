/**
 * 远程控制页：配置、启动/停止、固定隧道托管、免密直达链接与令牌管理。
 */
import { api, ckAlert } from '../shared.js';

function renderRemoteStatus(running: boolean, clients?: number, clientList?: any[]): void {
  const dot = document.getElementById('rm-dot');
  const txt = document.getElementById('rm-status-text');
  if (dot) dot.className = 'fs-dot' + (running ? ' connected' : '');
  if (txt) {
    if (!running) {
      txt.innerHTML = '未启动';
    } else if (clients && clients > 0) {
      txt.innerHTML = '运行中（<a href="#" id="rm-view-clients" style="color:var(--ck-primary);text-decoration:underline;">' + clients + ' 台设备在线</a>）';
      const link = document.getElementById('rm-view-clients');
      if (link) {
        link.onclick = (e) => {
          e.preventDefault();
          showClientDetails(clientList || []);
        };
      }
    } else {
      txt.textContent = '运行中';
    }
  }
}

function parseDeviceInfo(ua: string) {
  let os = '未知系统', browser = '未知浏览器', icon = '💻';
  if (/iPhone/.test(ua)) { os = 'iOS'; icon = '📱'; }
  else if (/iPad/.test(ua)) { os = 'iPadOS'; icon = '📱'; }
  else if (/Android/.test(ua)) { os = 'Android'; icon = '📱'; }
  else if (/Windows/.test(ua)) { os = 'Windows'; icon = '💻'; }
  else if (/Macintosh/.test(ua)) { os = 'macOS'; icon = '💻'; }
  else if (/Linux/.test(ua)) { os = 'Linux'; icon = '💻'; }

  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/MicroMessenger/.test(ua)) browser = '微信';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  
  return { os, browser, icon };
}

function showClientDetails(list: any[]): void {
  if (!list || !list.length) return;
  
  // 移除旧弹窗
  const old = document.getElementById('rm-client-modal');
  if (old) old.remove();

  const mask = document.createElement('div');
  mask.id = 'rm-client-modal';
  mask.className = 'ck-modal-mask';
  mask.style.position = 'fixed';
  mask.style.inset = '0';
  mask.style.background = 'rgba(0,0,0,0.5)';
  mask.style.zIndex = '9999';
  mask.style.display = 'flex';
  mask.style.alignItems = 'center';
  mask.style.justifyContent = 'center';

  const box = document.createElement('div');
  box.className = 'ck-modal-box';
  box.style.background = 'var(--ck-surface)';
  box.style.border = '1px solid var(--ck-border)';
  box.style.borderRadius = '12px';
  box.style.width = '320px';
  box.style.maxWidth = '90vw';
  box.style.maxHeight = '80vh';
  box.style.overflow = 'hidden';
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.boxShadow = '0 12px 32px rgba(0,0,0,0.3)';

  const header = document.createElement('div');
  header.style.padding = '16px 20px';
  header.style.borderBottom = '1px solid var(--ck-border)';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.innerHTML = `<h3 style="margin:0; font-size:15px; color:var(--ck-text);">在线设备 (${list.length})</h3>`;
  
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.background = 'transparent';
  closeBtn.style.border = 'none';
  closeBtn.style.color = 'var(--ck-text-dim)';
  closeBtn.style.fontSize = '16px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.onclick = () => mask.remove();
  header.appendChild(closeBtn);

  const content = document.createElement('div');
  content.style.padding = '12px';
  content.style.overflowY = 'auto';
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.gap = '10px';

  for (const c of list) {
    const ip = typeof c.ip === 'string' ? c.ip : 'unknown';
    const ua = typeof c.ua === 'string' ? c.ua : '';
    const info = parseDeviceInfo(ua);
    
    const item = document.createElement('div');
    item.style.background = 'var(--ck-bg)';
    item.style.padding = '12px';
    item.style.borderRadius = '8px';
    item.style.border = '1px solid var(--ck-border)';
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.gap = '12px';

    const iconEl = document.createElement('div');
    iconEl.style.fontSize = '24px';
    iconEl.textContent = info.icon;
    
    const infoEl = document.createElement('div');
    infoEl.style.flex = '1';
    infoEl.style.overflow = 'hidden';
    
    const ipEl = document.createElement('div');
    ipEl.style.fontFamily = 'monospace';
    ipEl.style.fontSize = '13px';
    ipEl.style.color = 'var(--ck-text)';
    ipEl.style.fontWeight = '500';
    ipEl.textContent = ip;
    
    const detailEl = document.createElement('div');
    detailEl.style.fontSize = '12px';
    detailEl.style.color = 'var(--ck-text-dim)';
    detailEl.style.marginTop = '2px';
    detailEl.textContent = `${info.os} · ${info.browser}`;

    const locEl = document.createElement('div');
    locEl.style.fontSize = '11px';
    locEl.style.color = 'var(--ck-text-dim)';
    locEl.style.marginTop = '2px';
    locEl.textContent = '获取归属地中...';
    
    // 异步请求 IP 详情
    if (api.getRemoteIpDetail && ip !== 'unknown' && ip !== '127.0.0.1') {
      api.getRemoteIpDetail(ip).then(detail => {
        if (detail) {
          const parts = [detail.country, detail.region, detail.city].filter(Boolean).join(' ');
          let line = parts;
          if (detail.isp) line += ' · ' + detail.isp;
          if (detail.scene) line += ' · ' + detail.scene;
          locEl.textContent = line;
          locEl.style.opacity = '0.8';
          

        } else {
          locEl.textContent = '';
        }
      }).catch(() => { locEl.textContent = ''; });
    } else {
      locEl.textContent = '';
    }

    infoEl.appendChild(ipEl);
    infoEl.appendChild(detailEl);
    infoEl.appendChild(locEl);
    item.appendChild(iconEl);
    item.appendChild(infoEl);
    content.appendChild(item);
  }

  box.appendChild(header);
  box.appendChild(content);
  mask.appendChild(box);

  // 点击遮罩关闭
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };

  document.body.appendChild(mask);
}

function renderTunnelStatus(tunnel?: any): void {
  const dot = document.getElementById('rm-tunnel-dot');
  const txt = document.getElementById('rm-tunnel-status-text');
  if (!dot || !txt) return;
  if (!tunnel || !tunnel.running) {
    dot.className = 'fs-dot';
    txt.textContent = (tunnel && tunnel.error) ? ('未启动: ' + tunnel.error) : '未启动';
    return;
  }
  dot.className = 'fs-dot connected';
  if (tunnel.mode === 'fixed') {
    txt.textContent = '运行中（固定隧道模式）';
  } else if (tunnel.url) {
    txt.textContent = '运行中（临时隧道: ' + tunnel.url + '）';
  } else {
    txt.textContent = '运行中（正在建立连接…）';
  }
}

function updateDirectUrl(publicUrl: string, tunnelUrl: string, port: number, token: string): void {
  const directEl = document.getElementById('rm-direct-url') as HTMLInputElement | null;
  if (!directEl) return;
  if (!token) {
    directEl.value = '';
    return;
  }
  let safePort = port;
  if (isNaN(safePort) || safePort < 1 || safePort > 65535) safePort = 7799;
  let base = (publicUrl || '').trim();
  if (!base && tunnelUrl) base = tunnelUrl.trim();
  if (!base) base = 'http://127.0.0.1:' + safePort;
  base = base.replace(/\/+$/, '');
  directEl.value = base + '/?token=' + encodeURIComponent(token);
}

export async function loadRemote(): Promise<void> {
  if (!api.getRemoteConfig) return;
  try {
    const r = await api.getRemoteConfig();
    if (!r || !r.success) return;
    const c = r.config || {};
    const s = r.status || {};
    const enabledEl = document.getElementById('rm-enabled') as HTMLInputElement | null;
    const portEl = document.getElementById('rm-port') as HTMLInputElement | null;
    const tokenEl = document.getElementById('rm-token') as HTMLInputElement | null;
    const publicUrlEl = document.getElementById('rm-public-url') as HTMLInputElement | null;
    const tunnelEnabledEl = document.getElementById('rm-tunnel-enabled') as HTMLInputElement | null;
    const tunnelTokenEl = document.getElementById('rm-tunnel-token') as HTMLInputElement | null;

    if (enabledEl) enabledEl.checked = c.enabled === true;
    if (portEl) portEl.value = c.port || 7799;
    if (tokenEl) tokenEl.value = c.token || '';
    if (publicUrlEl) publicUrlEl.value = c.publicUrl || '';
    if (tunnelEnabledEl) tunnelEnabledEl.checked = c.tunnelEnabled === true;
    if (tunnelTokenEl) tunnelTokenEl.value = c.tunnelToken || '';

    const effectivePublicUrl = c.publicUrl || (publicUrlEl ? publicUrlEl.value : '');
    const tunnelUrl = s.tunnel && s.tunnel.url ? s.tunnel.url : '';
    updateDirectUrl(effectivePublicUrl, tunnelUrl, c.port || 7799, c.token || '');
    renderRemoteStatus(!!s.running, s.clients, s.clientList);
    renderTunnelStatus(s.tunnel);
  } catch (_) { /* ignore */ }
}

// 定时器：用于自动刷新在线设备数（采用 Gen 判活防并发竞态）
let refreshTimer: any = null;
let refreshGen = 0;

async function pollStatus(gen: number): Promise<void> {
  if (gen !== refreshGen) return;
  if (!api.getRemoteConfig) {
    if (gen === refreshGen) refreshTimer = null;
    return;
  }
  try {
    const r = await api.getRemoteConfig();
    if (gen !== refreshGen) return;
    
    if (r && r.success && r.status && r.status.running) {
      renderRemoteStatus(r.status.running, r.status.clients, r.status.clientList);
      // 成功，排下一轮
      if (gen === refreshGen) {
        refreshTimer = setTimeout(() => { void pollStatus(gen); }, 3000);
      }
    } else {
      // 服务已停止或查询失败，终止链式轮询
      if (gen === refreshGen) refreshTimer = null;
    }
  } catch (_) {
    // 异常容错：终止轮询，防止死循环
    if (gen === refreshGen) refreshTimer = null;
  }
}

function startAutoRefresh(): void {
  stopAutoRefresh();
  refreshGen++;
  const gen = refreshGen;
  refreshTimer = setTimeout(() => { void pollStatus(gen); }, 3000);
}

function stopAutoRefresh(): void {
  refreshGen++;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// 页面加载时，先拉一次状态
loadRemote().then(() => startAutoRefresh());

// 监听页面卸载（如果适用，但壳页面通常不卸载）
// window.addEventListener('beforeunload', stopAutoRefresh);

const rmSave = document.getElementById('rm-save') as HTMLButtonElement | null;
if (rmSave) rmSave.addEventListener('click', async () => {
  if (!api.saveRemoteConfig) return;
  const enabledEl = document.getElementById('rm-enabled') as HTMLInputElement | null;
  const portEl = document.getElementById('rm-port') as HTMLInputElement | null;
  const publicUrlEl = document.getElementById('rm-public-url') as HTMLInputElement | null;
  const tunnelEnabledEl = document.getElementById('rm-tunnel-enabled') as HTMLInputElement | null;
  const tunnelTokenEl = document.getElementById('rm-tunnel-token') as HTMLInputElement | null;

  let port = parseInt(portEl ? portEl.value : '7799', 10);
  if (isNaN(port) || port < 1 || port > 65535) port = 7799;
  const payload = {
    enabled: !!(enabledEl && enabledEl.checked),
    port,
    publicUrl: publicUrlEl ? publicUrlEl.value.trim() : '',
    tunnelEnabled: !!(tunnelEnabledEl && tunnelEnabledEl.checked),
    tunnelToken: tunnelTokenEl ? tunnelTokenEl.value.trim() : '',
  };

  try {
    const r = await api.saveRemoteConfig(payload);
    if (r && r.success) {
      await loadRemote();
      startAutoRefresh();
      ckAlert(payload.enabled ? '远程服务配置已保存并生效' : '已保存（远程服务已停用）');
    } else {
      ckAlert('保存失败：' + ((r && r.error) || '未知错误'));
    }
  } catch (_) { /* ignore */ }
});

const rmRestart = document.getElementById('rm-restart') as HTMLButtonElement | null;
if (rmRestart) rmRestart.addEventListener('click', async () => {
  if (!api.restartRemote) return;
  try {
    await api.restartRemote();
    await loadRemote();
    startAutoRefresh();
    ckAlert('远程服务已重启');
  } catch (_) { /* ignore */ }
});

const rmCopyDirect = document.getElementById('rm-copy-direct-url') as HTMLButtonElement | null;
if (rmCopyDirect) rmCopyDirect.addEventListener('click', async () => {
  const directEl = document.getElementById('rm-direct-url') as HTMLInputElement | null;
  if (!directEl || !directEl.value) {
    ckAlert('尚未生成直达链接，请先启用远程服务');
    return;
  }
  try {
    await navigator.clipboard.writeText(directEl.value);
    ckAlert('手机免密直达链接已复制！手机打开即可自动登录');
  } catch (_) { /* ignore */ }
});

const rmCopyToken = document.getElementById('rm-copy-token') as HTMLButtonElement | null;
if (rmCopyToken) rmCopyToken.addEventListener('click', async () => {
  const tokenEl = document.getElementById('rm-token') as HTMLInputElement | null;
  if (!tokenEl || !tokenEl.value) return;
  try {
    await navigator.clipboard.writeText(tokenEl.value);
    ckAlert('令牌已复制');
  } catch (_) { /* ignore */ }
});

const rmReset = document.getElementById('rm-reset-token') as HTMLButtonElement | null;
if (rmReset) rmReset.addEventListener('click', async () => {
  if (!api.resetRemoteToken) return;
  try {
    await api.resetRemoteToken();
    await loadRemote();
    ckAlert('令牌已重置，直达链接已更新');
  } catch (_) { /* ignore */ }
});
