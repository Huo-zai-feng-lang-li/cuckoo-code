/**
 * IPC：窗口组（多账号限流轮换）
 */
import { createRequire } from "node:module";
import * as wg from "../window-groups.js";
import * as windowState from "../window.js";

const require = createRequire(import.meta.url);
const { ipcMain } = require("electron");

// 请求源窗口的 AI 页面执行"全量分享"，等回执
let reqSeq = 0;
const pendingShare = new Map<string, any>();

// 请求源窗口的 harness 导出状态（历史 + 队列），等回执
const pendingExport = new Map<string, any>();

/** harness 状态导出回执入口（由 index 注册） */
function onHarnessExportResult(_event: any, payload: any): void {
  const { reqId, state } = payload || {};
  if (!reqId || !pendingExport.has(reqId)) return;
  const p = pendingExport.get(reqId);
  pendingExport.delete(reqId);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(state || null);
}

/**
 * 导出指定窗口的 harness 状态（历史 + 待发队列）。
 * harness 可能未创建（懒加载）→ 返回 null，调用方降级。
 */
function requestHarnessExport(windowId: number, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve) => {
    const ctx = windowState.getWindowContext(windowId);
    const hv = ctx && (ctx as any).harnessView;
    if (!hv || hv.webContents.isDestroyed()) { resolve(null); return; }
    const reqId = 'hx-' + (++reqSeq) + '-' + Date.now();
    const timer = setTimeout(() => {
      if (pendingExport.has(reqId)) { pendingExport.delete(reqId); resolve(null); }
    }, timeoutMs);
    pendingExport.set(reqId, { resolve, timer });
    try { hv.webContents.send('harness-export-state-req', { reqId }); }
    catch (_) { pendingExport.delete(reqId); clearTimeout(timer); resolve(null); }
  });
}

/** 向目标窗口的 harness 推送源状态（切换后重建） */
function pushHarnessImport(windowId: number, state: any): void {
  if (!state) return;
  try {
    const ctx = windowState.getWindowContext(windowId);
    const hv = ctx && (ctx as any).harnessView;
    if (hv && !hv.webContents.isDestroyed()) hv.webContents.send('harness-import-state', state);
  } catch (_) { /* ignore */ }
}

// 切换状态暂存：harness 页面可能尚未加载完（监听器未注册），直接 push 会丢。
// 暂存后由 harness-ready 信号触发 push（harness.ts 调用）。
const stagedImport = new Map<number, any>();
const harnessReadyWindows = new Set<number>();

/** 暂存待导入状态；若 harness 已就绪则立即推送 */
function stageHarnessImport(windowId: number, state: any): void {
  if (!state) return;
  if (harnessReadyWindows.has(windowId)) { pushHarnessImport(windowId, state); return; }
  stagedImport.set(windowId, state);
}

/** harness 页面就绪时调用：若该窗口有暂存状态则推送 */
function onHarnessReady(windowId: number): void {
  harnessReadyWindows.add(windowId);
  const st = stagedImport.get(windowId);
  if (st) { stagedImport.delete(windowId); pushHarnessImport(windowId, st); }
}

/** 窗口关闭时清理 */
function clearHarnessReady(windowId: number): void {
  harnessReadyWindows.delete(windowId);
  stagedImport.delete(windowId);
}

/** AI 页面回执入口（由 index 注册） */
function onSwitchShareResult(_event: any, payload: any): void {
  const { reqId } = payload || {};
  if (!reqId || !pendingShare.has(reqId)) return;
  const p = pendingShare.get(reqId);
  pendingShare.delete(reqId);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(payload);
}

/** 让指定窗口的 AI 页面执行全量分享，返回 { ok, shareId, sessionId, error } */
// 超时 90s：切换现走"清 IDB + 刷新 + 等重建 + 分享"流程（跨页面刷新），比直接读 IDB 慢
function requestShareFromWindow(windowId: number, timeoutMs = 90000): Promise<any> {
  return new Promise((resolve) => {
    const ctx = windowState.getWindowContext(windowId);
    const view = ctx && ctx.view;
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      resolve({ ok: false, error: "源窗口不可用" });
      return;
    }
    const reqId = "wg-" + (++reqSeq) + "-" + Date.now();
    const timer = setTimeout(() => {
      if (pendingShare.has(reqId)) { pendingShare.delete(reqId); resolve({ ok: false, error: "分享请求超时" }); }
    }, timeoutMs);
    pendingShare.set(reqId, { resolve, timer });
    try { view.webContents.send("cuckoo-switch-share", { reqId }); }
    catch (err: any) { pendingShare.delete(reqId); clearTimeout(timer); resolve({ ok: false, error: err.message }); }
  });
}

// 由 entry.ts 注入的"窗口操作"（避免 ipc 层直接依赖 entry 的 createWindow）
let _deps: any = null;
function injectWindowGroupDeps(deps: any): void { _deps = deps; }

function registerWindowGroupsIpc(): void {
  // 列出所有组
  ipcMain.handle("wg-list", async () => {
    return { success: true, groups: wg.listGroups() };
  });

  // 新建组
  ipcMain.handle("wg-create", async (_e: any, { name }: any = {}) => {
    const g = wg.createGroup(name);
    return { success: true, group: g };
  });

  // 把窗口加入组
  ipcMain.handle("wg-add-window", async (_e: any, { groupId, windowId }: any = {}) => {
    const ok = wg.addWindowToGroup(groupId, windowId);
    return { success: ok };
  });

  // 从组移除窗口
  ipcMain.handle("wg-remove-window", async (_e: any, { groupId, windowId }: any = {}) => {
    const ok = wg.removeWindowFromGroup(groupId, windowId);
    return { success: ok };
  });

  // 重命名组
  ipcMain.handle("wg-rename", async (_e: any, { groupId, name }: any = {}) => {
    const ok = wg.renameGroup(groupId, name);
    return { success: ok };
  });

  // 删除组
  ipcMain.handle("wg-delete", async (_e: any, { groupId }: any = {}) => {
    const ok = wg.deleteGroup(groupId);
    return { success: ok };
  });

  // 切换：手动触发"分享当前对话给组内下一个窗口"
  ipcMain.handle("wg-switch", async (_e: any, { groupId }: any = {}) => {
    if (!groupId) return { success: false, error: "缺少 groupId" };
    if (!_deps || typeof _deps.runSwitch !== "function") return { success: false, error: "切换依赖未注入" };
    try {
      return await _deps.runSwitch(groupId, _e.sender);
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  });
}

export { registerWindowGroupsIpc, injectWindowGroupDeps, onSwitchShareResult, requestShareFromWindow, onHarnessExportResult, requestHarnessExport, pushHarnessImport, stageHarnessImport, onHarnessReady, clearHarnessReady };
