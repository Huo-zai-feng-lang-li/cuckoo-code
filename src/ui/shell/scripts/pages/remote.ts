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

function showClientDetails(list: any[]): void {
  if (!list || !list.length) return;
  const msgs: string[] = [];
  for (const c of list) {
    const ip = typeof c.ip === 'string' ? c.ip : 'unknown';
    let ua = typeof c.ua === 'string' ? c.ua : '';
    if (ua.includes('iPhone')) ua = 'iPhone / Safari';
    else if (ua.includes('Android')) ua = 'Android / 浏览器';
    else if (ua.includes('Windows')) ua = 'Windows PC';
    else if (ua.includes('Mac OS')) ua = 'Mac';
    else if (ua.length > 20) ua = ua.substring(0, 20) + '...';
    msgs.push(`${ip}（${ua || '未知设备'}）`);
  }
  let text = '当前在线设备:\n' + msgs.join('\n');
  if (msgs.length > 10) {
    text = '当前在线设备（前 10 台）:\n' + msgs.slice(0, 10).join('\n') + '\n...等共 ' + msgs.length + ' 台';
  }
  ckAlert(text);
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
