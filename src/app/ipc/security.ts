/**
 * IPC：安全/执行策略设置（壳页面消费）
 *
 * 通道（仅限自有窗口 own-window）：
 *  - get-execution-policy     → { success, mode }
 *  - set-execution-policy     { mode } → { success, mode }
 *  - get-trusted-workspaces   → { success, workspaces: [{path, since}] }
 *  - revoke-workspace-trust   { dir } → { success }
 */
import { createRequire } from 'node:module';
import { getExecutionMode, setExecutionMode } from '../execution-policy.js';
import { listTrustedWorkspaces, revokeWorkspaceTrust } from '../../infra/workspace-trust.js';
import { assertSenderOk } from '../ipc-guard.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 要求来源必须是自有窗口（壳页面），否则拒绝 */
function requireOwnWindow(event: any): boolean {
  const cls = assertSenderOk(event);
  return cls.ok && cls.kind === 'own-window';
}

function registerSecurityIpc(): void {
  ipcMain.handle('get-execution-policy', async (event: any) => {
    if (!requireOwnWindow(event)) return { success: false, error: '来源校验失败' };
    return { success: true, mode: getExecutionMode() };
  });

  ipcMain.handle('set-execution-policy', async (event: any, { mode }: any = {}) => {
    if (!requireOwnWindow(event)) return { success: false, error: '来源校验失败' };
    const effective = setExecutionMode(typeof mode === 'string' ? mode : '');
    return { success: true, mode: effective };
  });

  ipcMain.handle('get-trusted-workspaces', async (event: any) => {
    if (!requireOwnWindow(event)) return { success: false, error: '来源校验失败' };
    return { success: true, workspaces: listTrustedWorkspaces() };
  });

  ipcMain.handle('revoke-workspace-trust', async (event: any, { dir }: any = {}) => {
    if (!requireOwnWindow(event)) return { success: false, error: '来源校验失败' };
    if (typeof dir !== 'string' || !dir) return { success: false, error: '缺少 dir' };
    revokeWorkspaceTrust(dir);
    return { success: true };
  });
}

export { registerSecurityIpc };
