/**
 * IPC：远程控制
 *  - 配置读写 / 启停 / 状态查询（壳页面「远程」页调用）
 *  - 令牌显示 / 重置
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { readConfig, writeConfig, resetToken } from '../../remote/config.js';
import { getPort, isRunning, getClientCount, getClientList } from '../../remote/server.js';
import { initRemote, stopRemote, onAiStream, onAiReply, onAiStop, onAiError, onTool, onTaskDone, getTunnelStatus, broadcastRemoteMode } from '../../remote/manager.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerRemoteIpc(): void {
  // 读配置 + 状态
  ipcMain.handle('remote-get-config', async () => {
    const cfg = readConfig();
    return {
      success: true,
      config: {
        enabled: cfg.enabled,
        port: cfg.port,
        token: cfg.token,
        publicUrl: cfg.publicUrl || '',
        tunnelEnabled: cfg.tunnelEnabled || false,
        tunnelToken: cfg.tunnelToken || '',
      },
      status: {
        running: isRunning(),
        port: getPort(),
        clients: getClientCount(),
        clientList: getClientList(),
        tunnel: getTunnelStatus(),
      },
    };
  });

  // 保存配置 + 启停
  ipcMain.handle('remote-save-config', async (_e: any, { data }: any) => {
    const before = readConfig();
    const ok = writeConfig(data || {});
    if (!ok) return { success: false, error: '保存失败' };
    const cfg = readConfig();
    const connChanged = before.enabled !== cfg.enabled ||
      before.port !== cfg.port ||
      before.token !== cfg.token ||
      before.tunnelEnabled !== cfg.tunnelEnabled ||
      before.tunnelToken !== cfg.tunnelToken;
    if (!connChanged) return { success: true };
    await stopRemote();
    if (cfg.enabled) await initRemote();
    broadcastRemoteMode(isRunning());
    return { success: true };
  });

  // 重置令牌
  ipcMain.handle('remote-reset-token', async () => {
    const t = resetToken();
    // 令牌变了 → 重启服务让新令牌生效
    await stopRemote();
    const cfg = readConfig();
    if (cfg.enabled) await initRemote();
    broadcastRemoteMode(isRunning());
    return { success: true, token: t };
  });

  // 手动启停
  ipcMain.handle('remote-restart', async () => {
    await stopRemote();
    await initRemote();
    broadcastRemoteMode(isRunning());
    return { success: true, running: isRunning(), port: getPort() };
  });

  // 查询 IP 归属地详情（百度 brief-info 免鉴权接口，带缓存防止限流）
  const ipCache = new Map<string, { data: any, expire: number }>();
  let lastQueryAt = 0;
  ipcMain.handle('remote-get-ip-detail', async (_e: any, ip: string) => {
    if (!ip || ip === 'unknown' || ip === '127.0.0.1') return null;
    
    const now = Date.now();
    const cached = ipCache.get(ip);
    if (cached && now < cached.expire) return cached.data;

    // 串行限流：百度非官方接口，间隔至少 120ms
    const wait = Math.max(0, 120 - (Date.now() - lastQueryAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastQueryAt = Date.now();

    try {
      const url = `https://qifu.baidu.com/api/v1/ip-portrait/brief-info?ip=${encodeURIComponent(ip)}`;
      const res = await fetch(url, {
        headers: {
          'Referer': 'https://qifu.baidu.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (json.code === 200 && json.data) {
        const d = json.data;
        let riskDetail = '';
        if (d.security_risks) {
          const labels: string[] = [];
          for (const key of Object.keys(d.security_risks)) {
            const items = d.security_risks[key];
            if (Array.isArray(items)) {
              for (const item of items) {
                if (item.label) labels.push(item.label);
              }
            }
          }
          riskDetail = labels.join('、');
        }
        const detail = {
          country: d.country || '',
          region: d.province || '',
          city: d.city || '',
          isp: d.isp || '',
          scene: d.scene || '',
          risk: d.risk_score || '',
          riskDetail,
        };
        ipCache.set(ip, { data: detail, expire: now + 12 * 3600 * 1000 });
        return detail;
      }
    } catch (_) { /* ignore */ }
    return null;
  });

  // bridge 初始化时查询启用状态
  ipcMain.handle('remote-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && isRunning() };
  });

  // AI 页面上报（回复 / 流式 / 停止 / 错误 / 工具状态）→ 广播给手机
  // 从 event.sender 反查发起窗口的 profileId，实现多窗口隔离
  ipcMain.handle('remote-report', async (event: any, payload: any) => {
    if (!isRunning()) return { success: false };
    const ctx = windowState.getContextByWebContents(event.sender);
    // 子代理窗口复用父 profileId，它的事件（尤其收工时的 ai-stop）若被转播，
    // 手机会在父对话仍在生成时误显示「已停止生成」。子代理属内部过程，一律不上报。
    if (ctx && (ctx as any).isSubagent) return { success: true };
    const profileId = (ctx && ctx.profileId) || '';
    const type = payload && payload.type;
    try {
      if (type === 'ai-stream') onAiStream(String(payload.text || ''), String(payload.think || ''), profileId);
      else if (type === 'ai-reply') onAiReply(String(payload.text || ''), profileId);
      else if (type === 'ai-stop') onAiStop(profileId);
      else if (type === 'ai-error') onAiError(profileId, String(payload.error || ''));
      else if (type === 'tool') onTool(String(payload.phase || ''), String(payload.name || ''), profileId);
      else if (type === 'task-done') onTaskDone(profileId, String(payload.text || ''));
    } catch (_) { /* ignore */ }
    return { success: true };
  });
}

export { registerRemoteIpc };
