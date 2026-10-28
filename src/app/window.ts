/**
 * 窗口管理（多窗口 + 每窗口 profile 上下文）
 * 每个窗口关联一个 profileId，拥有独立的 sessionStore 实例。
 */
interface WindowContext {
  win: any;
  /** AI 网页所在的 WebContentsView（壳窗口的 win.webContents 是地址栏壳页面） */
  view: any;
  profileId: any;
  providerId: any;
  sessionStore: any;
  /** 是否子代理窗口（子代理与父窗口共用 profileId，靠此标志区分） */
  isSubagent?: boolean;
  /** 插件覆盖层视图（透明置顶，插件 UI 住这里） */
  overlayView?: any;
  /** 确保覆盖层创建（懒加载） */
  __ckEnsureOverlay?: () => any;
}

const windows = new Map<number, WindowContext>(); // windowId -> { win, profileId, providerId, sessionStore }
let lastActiveWindowId: number | null = null;

/** 窗口集合变化监听器（供远程控制等同步窗口列表；回调注入，避免上层依赖） */
const windowsChangedListeners = new Set<() => void>();
function onWindowsChanged(cb: () => void): () => void {
  windowsChangedListeners.add(cb);
  return () => { windowsChangedListeners.delete(cb); };
}
function emitWindowsChanged(): void {
  for (const cb of windowsChangedListeners) { try { cb(); } catch (_) { /* ignore */ } }
}

/**
 * profileId → 是否正在生成（AI 页面忙闲）。
 * 数据源：bridge 每 2 秒上报的 ai-state 事件。
 * 主窗口与子代理**分开存储**：子代理与父窗口共用 profileId，若混在一起，
 * 空闲子代理上报 false 会覆盖父窗口的 true（反之亦然），污染两类消费者：
 *   - 窗口组切换需要"含子代理"的聚合状态（避免切走跑子代理的窗口）；
 *   - 远程 watchdog 需要"仅主窗口"的状态（子代理在跑不代表主对话未结束）。
 */
const generatingProfiles = new Set<string>();        // 主窗口生成中
const generatingSubagents = new Set<string>();       // 子代理生成中

function setGenerating(profileId: any, generating: boolean, isSubagent?: boolean): void {
  if (!profileId) return;
  const key = String(profileId);
  const set = isSubagent ? generatingSubagents : generatingProfiles;
  if (generating) set.add(key);
  else set.delete(key);
}

/** 主窗口是否正在生成（远程 watchdog 用；不受子代理干扰） */
function isGenerating(profileId: any): boolean {
  return !!profileId && generatingProfiles.has(String(profileId));
}

/** 该窗口（含子代理）是否有任务在跑（窗口组切换用） */
function isGeneratingAny(profileId: any): boolean {
  if (!profileId) return false;
  const key = String(profileId);
  return generatingProfiles.has(key) || generatingSubagents.has(key);
}

/** 选出「主窗口」：最近活跃的非子代理窗口（排除子代理，防止内部临时窗口顶替主对话） */
function pickMainWindowId(): number | null {
  if (lastActiveWindowId !== null) {
    const cur = windows.get(lastActiveWindowId);
    if (cur && !cur.isSubagent) return lastActiveWindowId;
  }
  // 回退语义是「最后创建的主窗口」而非「次近活跃」（本模块不记录活跃历史），
  // 作为兜底足够；不要误以为这里是 LRU。
  let fallback: number | null = null;
  for (const [id, ctx] of windows) {
    if (!ctx.isSubagent) fallback = id;
  }
  return fallback;
}

function addWindow(win: any, profileId: any, providerId: any, sessionStore: any, view: any, isSubagent?: boolean): void {
  windows.set(win.id, { win, view, profileId, providerId, sessionStore, isSubagent: !!isSubagent });
  // 子代理窗口不参与「主窗口」选举：否则子代理创建期间 getMainContext() 会返回子代理，
  // 使手机远程 stop / 会话导出等以"最近活跃窗口"为目标的逻辑误命中子代理。
  if (!isSubagent) lastActiveWindowId = win.id;
  win.on('closed', () => {
    windows.delete(win.id);
    generatingProfiles.delete(String(profileId));
    generatingSubagents.delete(String(profileId));
    if (lastActiveWindowId === win.id) {
      lastActiveWindowId = pickMainWindowId();
    }
    emitWindowsChanged();
  });
  emitWindowsChanged();
}

function removeWindow(windowId: number): void {
  windows.delete(windowId);
  if (lastActiveWindowId === windowId) {
    lastActiveWindowId = pickMainWindowId();
  }
  emitWindowsChanged();
}

function getWindowContext(windowId: number): WindowContext | null {
  return windows.get(windowId) || null;
}

function getContextByWebContents(webContents: any): WindowContext | null {
  for (const ctx of windows.values()) {
    if (ctx.win.webContents === webContents) return ctx;
    if (ctx.view && ctx.view.webContents === webContents) return ctx;
    if ((ctx as any).harnessView && (ctx as any).harnessView.webContents === webContents) return ctx;
  }
  return null;
}

/** 取窗口的 AI 页面 view（若已销毁返回 null） */
function getViewOf(windowId: number): any {
  const ctx = windows.get(windowId);
  return ctx ? ctx.view : null;
}

/** 按 webContents 取 AI 页面 view（IPC 中从 event.sender 反查用） */
function getViewByWebContents(webContents: any): any {
  const ctx = getContextByWebContents(webContents);
  return ctx ? ctx.view : null;
}

function getMainWindow(): any {
  const ctx = getMainContext();
  return ctx ? ctx.win : null;
}

function getMainContext(): WindowContext | null {
  // lastActiveWindowId 不应指向子代理（addWindow/removeWindow/setMainWindow 均已排除），
  // 这里再兜一层，避免任何遗漏路径把子代理当成主窗口。
  if (lastActiveWindowId !== null) {
    const ctx = windows.get(lastActiveWindowId);
    if (ctx && !ctx.isSubagent) return ctx;
  }
  const fallback = pickMainWindowId();
  return fallback !== null ? windows.get(fallback) || null : null;
}

function setMainWindow(win: any): void {
  if (!win) { lastActiveWindowId = null; return; }
  // 子代理窗口不得被设为主窗口（它是内部临时窗口，不该代表主对话）。
  // 依赖调用方先 addWindow 再 setMainWindow（entry.ts:462 → 533），
  // ctx 查不到时放行，避免将来调用顺序变化反而阻断主窗口设置。
  const ctx = windows.get(win.id);
  if (ctx && ctx.isSubagent) return;
  lastActiveWindowId = win.id;
}

function getAllWindows(): any[] {
  return Array.from(windows.values()).map(ctx => ctx.win);
}

function getAllContexts(): WindowContext[] {
  return Array.from(windows.values());
}

/**
 * 按 profileId 取窗口。
 * 子代理与父窗口共用 profileId，故此方法**只返回主窗口**（跳过子代理），
 * 避免"已开就聚焦""删除窗口""远程转发"等场景误命中子代理窗口。
 */
function getWindowByProfileId(profileId: any): WindowContext | null {
  for (const ctx of windows.values()) {
    if (ctx.profileId === profileId && !ctx.isSubagent) return ctx;
  }
  return null;
}

/** 按 profileId 取**全部**窗口（含子代理）。用于"删除窗口"时把分身一并关掉。 */
function getAllWindowsByProfileId(profileId: any): WindowContext[] {
  const out: WindowContext[] = [];
  for (const ctx of windows.values()) {
    if (ctx.profileId === profileId) out.push(ctx);
  }
  return out;
}

export {
  addWindow,
  removeWindow,
  setGenerating,
  isGenerating,
  isGeneratingAny,
  getWindowContext,
  getContextByWebContents,
  getViewOf,
  getViewByWebContents,
  getMainWindow,
  getMainContext,
  setMainWindow,
  getAllWindows,
  getAllContexts,
  getWindowByProfileId,
  getAllWindowsByProfileId,
  onWindowsChanged,
};
