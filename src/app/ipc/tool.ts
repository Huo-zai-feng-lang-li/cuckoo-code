/**
 * IPC：执行工具与 JS 脚本
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { registry as toolRegistry, jsRunner } from '../../tools/index.js';
import { guardExecutionCall } from '../ipc-guard.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

// 上次推送的 todoWrite 列表（去重）
let lastTodosJson = '';

/** 重置计划（新任务/新对话时调用，避免旧 todo 残留） */
function resetTodosCache(): void {
  lastTodosJson = '';
  (globalThis as any).__cuckooTodos = [];
}

export { resetTodosCache };

/** 从 ctx 解析项目目录 / windowId（ctx 为 null 时调用方应已拒绝） */
function resolveCtx(ctx: any): { selectedDir: string | null; windowId: number | null } {
  const store = ctx ? ctx.sessionStore : null;
  const selectedDir = store ? store.state.selectedProjectDir : null;
  const win = ctx ? ctx.win : null;
  const windowId = win && !win.isDestroyed() ? win.id : null;
  return { selectedDir, windowId };
}

function registerToolIpc(): void {
  // 执行工具（X-001：host 校验 + 策略闸；ctx 为 null 直接拒绝）
  ipcMain.handle('execute-tool', async (event: any, { toolName, params, callId }: any) => {
    const guard = await guardExecutionCall(event, 'tool', { toolName, params });
    if (!guard.pass) {
      return { callId, success: false, error: guard.error ? guard.error.error : '已拒绝执行' };
    }
    const ctx = guard.ctx || windowState.getContextByWebContents(event.sender);
    const { selectedDir, windowId } = resolveCtx(ctx);
    try {
      const result = await toolRegistry.execute(toolName, { ...params, projectDir: selectedDir, currentWindowId: windowId });
      return { callId, success: result.success, data: result.data, error: result.error };
    } catch (err: any) {
      return { callId, success: false, error: err.message };
    }
  });

  // 执行 JS 脚本（X-001：host 校验 + 策略闸；ctx 为 null 直接拒绝）
  ipcMain.handle('execute-js', async (event: any, { code, callId, attachDelayMin, attachDelayMax, ssrfGuard }: any) => {
    if (!code || typeof code !== 'string') {
      return { callId, success: false, error: '无效的 JS 代码' };
    }
    const guard = await guardExecutionCall(event, 'js', { code });
    if (!guard.pass) {
      return { callId, success: false, error: guard.error ? guard.error.error : '已拒绝执行' };
    }
    const ctx = guard.ctx || windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    const sessionId = store ? store.state.currentSessionId : null;
    const win = ctx ? ctx.win : null;
    const windowId = win && !win.isDestroyed() ? win.id : null;
    try {
      const result = await jsRunner.run(code, selectedDir, windowId, { attachDelayMin, attachDelayMax, sessionId, ssrfGuard });
      // 复用官方 todoWrite 结果：执行后读取 globalThis.__cuckooTodos（官方规范化的列表），推给 harness
      try {
        const allTodos = (globalThis as any).__cuckooTodos;
        let todos = [];
        if (Array.isArray(allTodos)) {
          todos = allTodos;
        } else if (allTodos && typeof allTodos === 'object') {
          todos = allTodos[selectedDir || '__default__'] || [];
        }
        if (Array.isArray(todos) && todos.length) {
          const json = JSON.stringify(todos);
          if (json !== lastTodosJson) {
            lastTodosJson = json;
            const hv = ctx && (ctx as any).harnessView;
            if (hv && !hv.webContents.isDestroyed()) {
              hv.webContents.send('harness-event', { type: 'plan', todos: todos });
            }
          }
        }
      } catch (_) { /* ignore */ }
      return { callId, ...result };
    } catch (err: any) {
      return { callId, success: false, error: err.message };
    }
  });
}

export { registerToolIpc };
