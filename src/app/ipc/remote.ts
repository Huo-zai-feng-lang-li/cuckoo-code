/**
 * IPC：远程控制
 *  - 配置读写 / 启停 / 状态查询（壳页面「远程」页调用）
 *  - 令牌显示 / 重置
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { readConfig, writeConfig, resetToken } from '../../remote/config.js';
import { getPort, isRunning, getClientCount, getClientList } from '../../remote/server.js';
import { initRemote, stopRemote, onAiStream, onAiReply, onAiStop, onAiError, onTool, getTunnelStatus, broadcastRemoteMode } from '../../remote/manager.js';

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
    const profileId = (ctx && ctx.profileId) || '';
    const type = payload && payload.type;
    try {
      if (type === 'ai-stream') onAiStream(String(payload.text || ''), String(payload.think || ''), profileId);
      else if (type === 'ai-reply') onAiReply(String(payload.text || ''), profileId);
      else if (type === 'ai-stop') onAiStop(profileId);
      else if (type === 'ai-error') onAiError(profileId, String(payload.error || ''));
      else if (type === 'tool') onTool(String(payload.phase || ''), String(payload.name || ''), profileId);
    } catch (_) { /* ignore */ }
    return { success: true };
  });
}

export { registerRemoteIpc };
