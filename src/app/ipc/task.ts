/**
 * IPC：后台任务管理（「任务」页）
 *
 * 壳页面通过 window.shellAPI 调用：
 *  - task-start        ：启动后台命令（手动输入 / package.json script）
 *  - task-stop         ：停止一个任务（精准杀进程树）
 *  - task-list         ：列出全部任务
 *  - task-output       ：取某任务输出（增量：from 字节偏移）
 *  - task-remove       ：移除一条已退出的任务记录
 *  - task-clear-exited ：清空所有已退出的任务
 *  - task-read-scripts ：读当前项目 package.json 的 scripts（一键运行）
 *
 * 安全：危险命令过 isDangerous 拦截；cwd 由当前窗口的 selectedProjectDir 决定。
 * 通知：任务变更（启动/输出/退出）→ 推 'shell-tasks-changed' 给壳页面。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import * as taskManager from '../../infra/task-manager.js';
import { isDangerous } from '../../infra/dangerous-commands.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 取当前窗口的项目根目录（绝对路径），无则 null */
function getProjectRoot(event: any): string | null {
  const ctx = windowState.getContextByWebContents(event.sender);
  const store = ctx ? ctx.sessionStore : null;
  const rootDir = (store && store.state && store.state.selectedProjectDir) || null;
  return rootDir ? path.resolve(rootDir) : null;
}

/** 取当前窗口的壳页面 webContents（用于推送变更） */
function getShellSender(event: any): any {
  const ctx = windowState.getContextByWebContents(event.sender);
  return ctx ? ctx.win.webContents : null;
}

/** 把任务变更推给所有窗口的壳页面 */
function broadcastChange(): void {
  for (const ctx of windowState.getAllContexts()) {
    try {
      if (ctx.win && !ctx.win.isDestroyed && ctx.win.webContents) {
        ctx.win.webContents.send('shell-tasks-changed');
      }
    } catch (_) { /* ignore */ }
  }
}

function registerTaskIpc(): void {
  // 任务变更 → 推壳页面（去抖在 task-manager 内部）
  taskManager.setChangeListener(broadcastChange);

  // 启动后台命令
  ipcMain.handle('task-start', async (event: any, { command, label, source }: any) => {
    try {
      if (!command || typeof command !== 'string') {
        return { success: false, error: '命令为空' };
      }
      const trimmed = command.trim();
      if (!trimmed) return { success: false, error: '命令为空' };
      if (isDangerous(trimmed)) {
        return { success: false, error: '命令被安全策略拒绝（危险命令）' };
      }
      const cwd = getProjectRoot(event) || process.env.USERPROFILE || process.cwd();
      const src = source === 'script' ? 'script' : 'manual';
      const info = taskManager.start({ command: trimmed, cwd, source: src, label: label || undefined });
      return { success: true, task: info };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // 停止
  ipcMain.handle('task-stop', async (_event: any, { id }: any) => {
    if (!id || typeof id !== 'string') return { success: false, error: '缺少任务 ID' };
    const ok = taskManager.stop(id);
    return ok ? { success: true } : { success: false, error: '任务不存在或已结束' };
  });

  // 列表
  ipcMain.handle('task-list', async () => {
    return { success: true, tasks: taskManager.list() };
  });

  // 取输出（支持增量：from = 已读字节数，返回 nextFrom）
  ipcMain.handle('task-output', async (_event: any, { id, from }: any) => {
    if (!id || typeof id !== 'string') return { success: false, error: '缺少任务 ID' };
    const full = taskManager.getOutput(id);
    const totalBytes = Buffer.byteLength(full, 'utf-8');
    let start = typeof from === 'number' && from > 0 ? from : 0;
    if (start > totalBytes) start = 0; // 缓冲被截断过 → 全量重取
    // 从字节偏移取尾部：按字符累计到 start 字节
    let text: string;
    if (start === 0) {
      text = full;
    } else {
      let acc = 0;
      let cut = 0;
      for (let i = 0; i < full.length; i++) {
        if (acc >= start) { cut = i; break; }
        acc += Buffer.byteLength(full[i], 'utf-8');
      }
      text = full.slice(cut);
    }
    return { success: true, text, totalBytes };
  });

  // 移除已退出任务
  ipcMain.handle('task-remove', async (_event: any, { id }: any) => {
    if (!id || typeof id !== 'string') return { success: false, error: '缺少任务 ID' };
    return taskManager.remove(id) ? { success: true } : { success: false, error: '任务运行中或不存在' };
  });

  // 清空已退出
  ipcMain.handle('task-clear-exited', async () => {
    const n = taskManager.clearExited();
    return { success: true, removed: n };
  });

  // 读 package.json scripts
  ipcMain.handle('task-read-scripts', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录', scripts: [] };
    return { success: true, scripts: taskManager.readPackageScripts(root) };
  });
}

export { registerTaskIpc };
