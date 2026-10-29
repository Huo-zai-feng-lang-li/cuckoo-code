/**
 * IPC：设置读写（壳页面设置页 ↔ 全局文件 ↔ 各窗口 AI 页面 localStorage）
 *
 * 数据流（统一同步机制）：
 *  - 主进程 global-settings.ts 是**唯一真相源**（~/.cuckoo/agent-settings.json）。
 *  - AI 页面 localStorage 降级为**运行时缓存**（hook / loop 同步读，零改动）。
 *  - 保存：发起窗口 AI 页面校验并写 localStorage → 成功则落盘 → 广播其他窗口。
 *  - 打开设置页：直接读全局文件；文件不存在时从发起窗口 localStorage 迁移（保留用户已有配置）。
 *  - 新窗口：entry.ts 在 did-finish-load 时主动下发一次。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { readPrefs, writePrefs } from '../ui-prefs.js';
import { applyHarnessZoom } from '../harness-zoom.js';
import * as globalSettings from '../global-settings.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

let reqSeq = 0;
/** reqId → { resolve, timer } */
const pending = new Map<string, any>();

/** 收到 AI 页面回执 */
function onResult(_event: any, payload: any): void {
  const { reqId } = payload || {};
  if (!reqId || !pending.has(reqId)) return;
  const p = pending.get(reqId);
  pending.delete(reqId);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(payload);
}

/** 向指定窗口的 AI 页面请求设置操作，等回执（超时 5s） */
function requestFromAiPage(shellEvent: any, channel: string, data?: any): Promise<any> {
  return new Promise((resolve) => {
    const ctx = windowState.getContextByWebContents(shellEvent.sender);
    const view = ctx && ctx.view;
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      resolve({ ok: false, error: '未找到 AI 页面' });
      return;
    }
    const reqId = 'set-' + (++reqSeq) + '-' + Date.now();
    const timer = setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        resolve({ ok: false, error: 'AI 页面响应超时' });
      }
    }, 5000);
    pending.set(reqId, { resolve, timer });
    try {
      view.webContents.send(channel, { reqId, data });
    } catch (err: any) {
      pending.delete(reqId);
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * 广播设置到所有窗口的 AI 页面（仅 ctx.view；harnessView 是独立 origin，不参与全局设置同步）。
 * @param skip 跳过的 webContents（发起方已自行写入时避免重复）
 */
function broadcastSettings(data: any, skip?: any): void {
  const ctxs = windowState.getAllContexts();
  for (const ctx of ctxs) {
    // 只发 AI 页面：harness 视图是独立 origin，且没有 cuckoo-sync-settings 监听；
    // 它的 goalMaxIterations 属自身 localStorage，不参与全局设置同步。
    const v = ctx.view;
    if (!v || !v.webContents || v.webContents.isDestroyed()) continue;
    if (skip && v.webContents === skip) continue;
    try { v.webContents.send('cuckoo-sync-settings', { data }); } catch (err: any) {
      console.warn('[Cuckoo Code] 设置广播失败:', err && err.message);
    }
  }
}

/**
 * 广播壳页面布局到所有窗口（含发起方，幂等应用）。
 * @param layout 白名单内的键值（cuckoo-sidebar-width 等）
 */
function broadcastShellLayout(layout: any): void {
  const ctxs = windowState.getAllContexts();
  for (const ctx of ctxs) {
    const wc = ctx.win && ctx.win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try { wc.send('shell-layout-changed', { layout: layout || {} }); } catch (err: any) {
      console.warn('[Cuckoo Code] 布局广播失败:', err && err.message);
    }
  }
}

/** 取发起窗口的 AI 页面 webContents（用于广播时跳过） */
function getAiWebContents(sender: any): any {
  const ctx = windowState.getContextByWebContents(sender);
  return ctx && ctx.view ? ctx.view.webContents : null;
}

/**
 * 确保全局设置已建立（首次升级迁移的唯一入口）。
 *
 * 背景：老用户配置存在 AI 页面 localStorage。升级后必须迁移一次到全局文件，
 * 否则防封新默认对老用户完全无效（他们从不打开设置页也会继续用旧默认）。
 *
 * 关键约束（子代理审查 High 1/2/3）：
 *  - AI 页面不可达时**绝不落盘**（否则文件被建成纯默认，迁移永久失效、用户配置丢失）
 *  - 迁移完成后必须**回写发起窗口**（否则该窗口 UI 显示新值、运行时仍用旧 localStorage）
 */
async function migrateIfNeeded(vc: any): Promise<any> {
  if (globalSettings.hasAgentSettingsFile()) return globalSettings.readAgentSettings();
  if (!vc || vc.isDestroyed()) return null;

  const reqId = 'mig-' + (++reqSeq) + '-' + Date.now();
  const payload: any = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(reqId)) { pending.delete(reqId); resolve({ ok: false, error: 'AI 页面响应超时' }); }
    }, 5000);
    pending.set(reqId, { resolve, timer });
    try { vc.send('cuckoo-get-settings', { reqId }); } catch (err: any) {
      pending.delete(reqId); clearTimeout(timer); resolve({ ok: false, error: err.message });
    }
  });
  // 不可达 → 不落盘，留给下次（页面重载/打开设置页）重试
  if (!payload.ok || !payload.data) return null;

  const merged = globalSettings.writeAgentSettings(globalSettings.migrateLegacy(payload.data));
  // 回写发起窗口（不跳过自己）+ 广播其他窗口
  try { vc.send('cuckoo-sync-settings', { data: merged }); } catch (_) { /* ignore */ }
  broadcastSettings(merged, vc);
  return merged;
}

function registerSettingsIpc(): void {
  // AI 页面回执入口
  ipcMain.on('cuckoo-settings-result', onResult);
  ipcMain.on('cuckoo-autocompact-result', onResult);

  // 读设置：全局文件优先；文件不存在时走统一迁移（AI 页面不可达则不落盘、返回失败）
  ipcMain.handle('get-settings', async (event: any) => {
    if (globalSettings.hasAgentSettingsFile()) {
      return { success: true, data: globalSettings.readAgentSettings() };
    }
    const migrated = await migrateIfNeeded(getAiWebContents(event.sender));
    if (migrated) return { success: true, data: migrated };
    return { success: false, error: 'AI 页面未就绪，无法初始化设置，请稍后重试' };
  });

  // 保存设置：壳页面提交的是**增量**（只含本次变更字段）。
  // 流程：最新文件值 + 增量 = 完整设置 → 交 AI 页面校验并写 localStorage → 落盘 → 广播。
  // 关键：落盘必须用「最新文件值 + 增量」而不是 AI 页面回执的全量快照，
  // 否则两个窗口并发保存不同字段时，后保存的一方会用自己窗口的旧值覆盖对方的改动。
  ipcMain.handle('save-settings', async (event: any, { data }: any) => {
    const delta = (data && typeof data === 'object') ? data : {};
    const merged = globalSettings.applyDelta(globalSettings.readAgentSettings(), delta);
    const r = await requestFromAiPage(event, 'cuckoo-save-settings', merged);
    if (!r.ok) return { success: false, error: r.error || '保存失败' };
    // await 期间其他窗口可能已写入新值 → 再读一次最新值做基底，只叠加本次增量
    const latest = globalSettings.readAgentSettings();
    const next = globalSettings.writeAgentSettings(globalSettings.applyDelta(latest, delta));
    // 不跳过发起方：并发保存时，发起方自己的 AI 页面可能已被另一窗口的广播覆盖成
    // 「缺本次增量」的陈旧数据；若跳过它，它与最终落盘文件会永久不一致（hook/loop 读 localStorage）。
    // 发起方重复收到同一份数据是幂等应用，成本可忽略。
    broadcastSettings(next);
    return { success: true, data: next };
  });

  // 恢复默认：发起窗口清 localStorage → 落盘默认 → 广播所有窗口
  ipcMain.handle('reset-settings', async (event: any) => {
    await requestFromAiPage(event, 'cuckoo-reset-settings');
    const def = globalSettings.writeAgentSettings({});
    broadcastSettings(def);
    return { success: true, data: def };
  });

  // 自动压缩配置：读（全局通用）
  ipcMain.handle('get-autocompact', async () => {
    const s = globalSettings.readAgentSettings();
    return { success: true, data: { enabled: s.autoCompactEnabled, threshold: s.autoCompactThreshold } };
  });
  // 自动压缩配置：保存（全局通用）
  ipcMain.handle('save-autocompact', async (event: any, { data }: any) => {
    const th = parseFloat(data.threshold);
    if (!Number.isFinite(th) || th <= 0) return { success: false, error: '阈值需为正数（万）' };
    const next = globalSettings.writeAgentSettings({ autoCompactEnabled: !!data.enabled, autoCompactThreshold: th });
    broadcastSettings(next);
    return { success: true, data: { enabled: next.autoCompactEnabled, threshold: next.autoCompactThreshold } };
  });
  // 手动触发压缩
  ipcMain.handle('trigger-compact', async (event: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const currentDir = (ctx && ctx.sessionStore && ctx.sessionStore.state)
      ? (ctx.sessionStore.state.selectedProjectDir || null) : null;
    const r = await requestFromAiPage(event, 'cuckoo-trigger-compact', { projectDir: currentDir });
    return r.ok ? { success: true } : { success: false, error: r.error };
  });

  // ===== UI 偏好（主进程直存，全窗口共享）=====
  ipcMain.handle('get-ui-prefs', async () => {
    return { success: true, data: readPrefs() };
  });
  ipcMain.handle('set-ui-prefs', async (event: any, { data }: any) => {
    const next = writePrefs(data || {});
    try {
      const contexts = windowState.getAllContexts();
      for (const ctx of contexts) {
        const hv = ctx && (ctx as any).harnessView;
        if (hv && hv.webContents && !hv.webContents.isDestroyed()) {
          applyHarnessZoom(hv.webContents, next.harnessZoom);
        }
      }
    } catch (_) { /* ignore */ }
    // 布局变化（侧栏宽度 / 活动栏顺序 / 显隐）→ 广播给所有壳页面（含本窗口，幂等）。
    // 原因：壳页面 localStorage 按 partition 隔离，跨 profile 窗口互不相通，只能由主进程中转。
    if (data && data.shellLayout !== undefined) {
      broadcastShellLayout(next.shellLayout);
    }
    // 子代理宠物配置变化 -> 广播给所有页面刷新
    if (data && data.subagentPet !== undefined) {
      try {
        const contexts = windowState.getAllContexts();
        for (const ctx of contexts) {
          if (ctx.win && !ctx.win.isDestroyed()) {
            ctx.win.webContents.send('cuckoo-pets-changed');
          }
          const hv = ctx && (ctx as any).harnessView;
          if (hv && hv.webContents && !hv.webContents.isDestroyed()) {
            hv.webContents.send('cuckoo-pets-changed');
          }
        }
      } catch (_) { /* ignore */ }
    }
    return { success: true, data: next };
  });
}

export { registerSettingsIpc, broadcastSettings, migrateIfNeeded, broadcastShellLayout };
