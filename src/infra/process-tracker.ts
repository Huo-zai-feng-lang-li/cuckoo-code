/**
 * 前台进程追踪器（供 runCaptured / runRipgrep 等使用）
 *
 * 工具在主进程执行时，会 spawn 出系统进程（cmd.exe / powershell.exe / rg.exe）。
 * 这些进程目前只有超时才退出，无法响应 UI 的“停止”信号。
 * 本模块负责登记这些子进程，并在用户点击停止时按窗口强杀。
 *
 * 依赖：只依赖 node 内置模块（infra 层）。
 */
import { killProcessTree } from './task-manager.js';

interface TrackedProcess {
  pid: number;
  child: any;
  windowId: number | null;
}

const tracked = new Set<TrackedProcess>();

/**
 * 登记一个前台子进程。
 * @param child spawn 返回的子进程实例
 * @param windowId 归属的窗口 id（便于按窗口取消）
 */
export function trackProcess(child: any, windowId: number | null = null): void {
  if (!child || !child.pid) return;
  const item: TrackedProcess = { pid: child.pid, child, windowId };
  
  // 去重：同一个 child 不重复挂载监听
  for (const it of tracked) {
    if (it.child === child) return;
  }
  
  tracked.add(item);

  const cleanup = () => { tracked.delete(item); };
  child.on('close', cleanup);
  child.on('exit', cleanup);
  child.on('error', () => {
    // 只有当确实退出时才移除
    if (child.exitCode !== null || child.signalCode !== null) cleanup();
  });
}

/**
 * 强杀属于指定窗口的所有前台子进程。
 * @param windowId 窗口 id。如果不传，则杀全部（进程退出时兜底）。
 */
export function abortWindowProcesses(windowId?: number): void {
  for (const item of Array.from(tracked)) {
    if (windowId !== undefined && item.windowId !== windowId) continue;
    
    // 进程已结束则跳过
    if (item.child.exitCode !== null || item.child.signalCode !== null) {
      tracked.delete(item);
      continue;
    }
    
    // 统一走 killProcessTree（Windows: taskkill /T /F, Unix: kill 进程组）
    killProcessTree(item.pid, 'SIGKILL');
  }
}
