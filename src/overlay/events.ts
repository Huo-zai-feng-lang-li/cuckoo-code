/**
 * 覆盖层按钮事件绑定（编排层）
 *
 * 注：原 overlay 的整套注入式面板/悬浮球已迁移到壳页面（见 commit 92c5abc），
 * overlay 现仅保留工具提示条 + 首次引导框。此文件只保留仍有效的绑定
 * （首次引导框、发送延迟配置恢复、token/TPS 统计、压缩触发等）。
 */
import { state } from './state.js';
import { showToast, hideFirstTimeDialog } from './panel.js';
import { handleInitProject } from './session-list.js';
import { runCompaction, checkPendingCompact, checkPendingInit } from '../session/compaction.js';
import { getProviderByUrl } from '../providers/registry.js';
import { createTpsMeter, formatTps } from './tps.js';

// 回调注入（P4.2-A：overlay 不依赖 bridge）
let hooks: {
  onInterceptedResponse?: (cb: (text: string, meta: any) => void) => void;
  onTaskIdle?: (cb: () => void) => void;
  onStream?: (cb: (ev: any) => void) => void;
} = {};
// 服务端权威 token 统计（由 bridge 经回调推送，不共享状态）
let serverTokenUsage: any = null;

// ========== 输出速度（TPS）估算 ==========
// 服务端不给单轮输出 token，只能用流式正文长度估算（见 tps.ts）
const tpsMeter = createTpsMeter();
// 避免高频 IPC：同一展示值不重复推送，并增加 150ms 节流窗口
let lastPushedTps = '';
let lastPushedTpsAt = 0;
const TPS_PUSH_INTERVAL_MS = 150;

/**
 * 把当前 TPS 推送给壳页面状态栏。
 * 生成中实时更新（150ms 节流）；**生成结束后保留本轮最终速度**（不清零），
 * 直到下一轮生成开始才被新值覆盖。无任何数据时推空串（壳页面显示 "--"）。
 * @param force 为 true 时无视节流立即推送（例如完成帧）
 */
function pushTps(force: boolean = false): void {
  const now = Date.now();
  if (!force && now - lastPushedTpsAt < TPS_PUSH_INTERVAL_MS) return;
  lastPushedTpsAt = now;
  const text = tpsMeter.value > 0 ? formatTps(tpsMeter.value) : '';
  if (text === lastPushedTps) return;
  lastPushedTps = text;
  try {
    (window as any).electronAPI.updateTps(text).catch(() => {});
  } catch (_) {}
}

// ========== 对话 token 按会话缓存 ==========
const TOKEN_CACHE_KEY = 'cuckoo-token-cache';
// 按天累计（保留所有历史，供后续统计）
const TOKEN_DAILY_KEY = 'cuckoo-token-daily';
// 每日统计口径版本：
//  v1 = 累加完整 acc 但无限膨胀（错误）
//  v2 = 累加 delta（跨天会漏算，与预期不符）
//  v3 = 每天累加"当轮完整 acc"（今天每轮的总量之和，跨天归零）
const DAILY_VERSION_KEY = 'cuckoo-token-daily-version';
const DAILY_VERSION = '3';

/** 是否子代理窗口（由 bridge 注入）。子代理共享父窗口 localStorage，不应参与 token 统计 */
let isSubagentWindow = false;
function setIsSubagentWindow(v: boolean): void { isSubagentWindow = !!v; }

/** 旧口径数据迁移：v1 的今日值是"完整 acc 之和"（会膨胀），不可比，检测到就清空重来 */
function migrateDailyVersion(): void {
  try {
    if (localStorage.getItem(DAILY_VERSION_KEY) !== DAILY_VERSION) {
      localStorage.removeItem(TOKEN_DAILY_KEY);
      localStorage.setItem(DAILY_VERSION_KEY, DAILY_VERSION);
    }
  } catch (_) {}
}

/** 取本地日期字符串 YYYY-MM-DD */
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 某天累加 token（传入"当轮完整 acc"） */
function addDailyToken(delta: number): void {
  if (typeof delta !== 'number' || delta <= 0) return;
  try {
    const raw = localStorage.getItem(TOKEN_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const map = (obj && typeof obj === 'object') ? obj : {};
    const k = todayKey();
    map[k] = (typeof map[k] === 'number' ? map[k] : 0) + delta;
    localStorage.setItem(TOKEN_DAILY_KEY, JSON.stringify(map));
  } catch (_) {}
}

/** 今日累计消耗（今天新消耗的 token；跨天归零） */
function getTodayCumulative(): number {
  try {
    migrateDailyVersion();
    const raw = localStorage.getItem(TOKEN_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const v = obj ? obj[todayKey()] : 0;
    return typeof v === 'number' ? v : 0;
  } catch (_) {
    return 0;
  }
}

/** 近 N 日的每日用量（升序，含今天；缺失日补 0） */
function getRecentDaily(days: number): Array<{ date: string; value: number }> {
  try {
    migrateDailyVersion();
    const raw = localStorage.getItem(TOKEN_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const map = (obj && typeof obj === 'object') ? obj : {};
    const out: Array<{ date: string; value: number }> = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const key = y + '-' + m + '-' + day;
      const v = typeof map[key] === 'number' ? map[key] : 0;
      out.push({ date: key, value: v });
    }
    return out;
  } catch (_) {
    return [];
  }
}

/** 取当前页面对应的会话 ID（无则 null） */
function getCurrentSessionId(): string | null {
  try {
    const provider = getProviderByUrl(window.location.href);
    if (provider && typeof provider.extractSessionId === 'function') {
      return provider.extractSessionId(window.location.href) || null;
    }
  } catch (_) {}
  return null;
}

/** 单个会话的 token 数据 */
interface SessionToken {
  /** 当前上下文总量（最新 accumulated） */
  context: number;
  /** 累计消耗（各轮回复结束时的 accumulated 之和） */
  cumulative: number;
  /** 上次记录的 accumulated（用于去重/判断是否新增一轮） */
  lastAcc: number;
}

/** 读整个 token 缓存（sessionId → SessionToken） */
function readTokenCache(): Record<string, SessionToken> {
  try {
    const raw = localStorage.getItem(TOKEN_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) {
    return {};
  }
}

/**
 * 记录某会话的当前上下文 token，并累加累计消耗。
 * 累计消耗 = 各轮回复结束时的 accumulated 之和
 *（DeepSeek 每轮都把完整历史作为 prompt 重发，故每轮实际处理的 token ≈ 当轮 accumulated）。
 * 仅在 acc 相比上次增大时才累加，避免同一轮重复事件重复计数。
 */
function saveTokenForSession(sessionId: string, acc: number): void {
  if (!sessionId || typeof acc !== 'number') return;
  try {
    const cache = readTokenCache();
    let entry: any = cache[sessionId];
    // 兼容旧格式（数字）
    if (typeof entry === 'number') entry = { context: entry, cumulative: entry, lastAcc: entry };
    if (!entry || typeof entry !== 'object') entry = { context: 0, cumulative: 0, lastAcc: 0 };
    const lastAcc = typeof entry.lastAcc === 'number' ? entry.lastAcc : 0;
    if (acc > lastAcc) {
      // 窗口累计：累加"当轮完整上下文"（DeepSeek 每轮都重发完整历史）
      entry.cumulative = (typeof entry.cumulative === 'number' ? entry.cumulative : 0) + acc;
      // 今日窗口：累加"当轮完整 acc"（今天每轮的总量之和）；跨天由 todayKey() 天然归零
      addDailyToken(acc);
    }
    entry.context = acc;
    entry.lastAcc = acc;
    cache[sessionId] = entry;
    // 限制缓存条数，避免无限增长（保留最近 200 个）
    const keys = Object.keys(cache);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete cache[k];
    }
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

/** 窗口累计：本窗口所有会话的累计消耗之和（localStorage 按 partition 隔离，天然是本窗口的） */
function getWindowCumulative(): number {
  try {
    const cache = readTokenCache();
    let sum = 0;
    for (const k of Object.keys(cache)) {
      const e: any = cache[k];
      if (typeof e === 'number') sum += e;
      else if (e && typeof e.cumulative === 'number') sum += e.cumulative;
    }
    return sum;
  } catch (_) {
    return 0;
  }
}

/** 取某会话的 token 数据（兼容旧格式） */
function getTokenForSession(sessionId: string | null): { context: number; cumulative: number } {
  if (!sessionId) return { context: 0, cumulative: 0 };
  const entry: any = readTokenCache()[sessionId];
  if (typeof entry === 'number') return { context: entry, cumulative: entry };
  if (entry && typeof entry === 'object') {
    return {
      context: typeof entry.context === 'number' ? entry.context : 0,
      cumulative: typeof entry.cumulative === 'number' ? entry.cumulative : 0,
    };
  }
  return { context: 0, cumulative: 0 };
}
/** 由 bridge/entry 在初始化时注入 bridge 能力 */
function wireEvents(h: typeof hooks): void {
  hooks = h;
}

let eventsBound = false;

/**
 * 格式化 token 数：过万显示为「xxx万」，否则原样显示
 */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 10000) {
    return (n / 10000).toFixed(2) + '万';
  }
  return String(Math.round(n));
}

/**
 * 刷新面板里的「对话 Token」显示
 * 数据来源：服务端 accumulated_token_usage（含 prompt+输出）；未收到时显示 0。
 */
function updateConversationTokenDisplay() {
  const countEl = document.getElementById('cuckoo-conv-token-count');
  // 优先用"当前会话"的缓存值（切会话/刷新后仍能显示该会话的 token）
  const sid = getCurrentSessionId();
  const cached = sid ? getTokenForSession(sid) : { context: 0, cumulative: 0 };
  const context = (cached.context > 0)
    ? cached.context
    : (serverTokenUsage && typeof serverTokenUsage.accumulatedTokens === 'number' ? serverTokenUsage.accumulatedTokens : 0);
  const cumulative = cached.cumulative || 0;

  if (countEl) countEl.textContent = formatTokenCount(context);

  // 同步到壳页面状态条（地址栏下方）：上下文 + 对话累计 + 窗口累计 + 今日累计 + 近 10 日
  try {
    (window as any).electronAPI.updateTokenUsage(
      context, cumulative, getWindowCumulative(), getTodayCumulative(), getRecentDaily(10)
    ).catch(() => {});
  } catch (_) {}
}

/** 供 bridge 在 URL 变化时调用：刷新当前会话的 token 显示 */
function refreshTokenForCurrentSession(): void {
  updateConversationTokenDisplay();
}

// ========== 自动压缩上下文 ==========
// 配置：是否启用 + 阈值（单位：万 token）
let autoCompactEnabled = false;
let autoCompactThresholdWan = 80;
// 防止压缩过程中重复触发
let autoCompactTriggering = false;

/** 从 localStorage 读取自动压缩配置并同步到 UI */
function loadAutoCompactConfig() {
  try {
    const en = localStorage.getItem('cuckoo-auto-compact-enabled');
    const th = localStorage.getItem('cuckoo-auto-compact-threshold');
    autoCompactEnabled = en === '1';
    // 同样避免 "parseFloat() || 80"（0 会被丢弃）
    if (th !== null) { const v = parseFloat(th); if (Number.isFinite(v) && v > 0) autoCompactThresholdWan = v; }
  } catch (_) {}
  const enEl = document.getElementById('cuckoo-auto-compact-enabled');
  const thEl = document.getElementById('cuckoo-auto-compact-threshold');
  if (enEl) (enEl as any).checked = autoCompactEnabled;
  if (thEl) (thEl as any).value = autoCompactThresholdWan;
}

/** 保存自动压缩配置 */
function saveAutoCompactConfig() {
  const enEl = document.getElementById('cuckoo-auto-compact-enabled');
  const thEl = document.getElementById('cuckoo-auto-compact-threshold');
  const enabled = !!(enEl && (enEl as any).checked);
  let th = thEl ? parseFloat((thEl as any).value) : 80;
  if (!Number.isFinite(th) || th <= 0) {
    showToast('阈值需为正数（万）', 3000);
    return;
  }
  autoCompactEnabled = enabled;
  autoCompactThresholdWan = th;
  try {
    localStorage.setItem('cuckoo-auto-compact-enabled', enabled ? '1' : '0');
    localStorage.setItem('cuckoo-auto-compact-threshold', String(th));
  } catch (_) {}
  showToast('自动压缩设置已保存：' + (enabled ? '开启，阈值 ' + th + ' 万' : '关闭'), 2500);
}

/**
 * 检查是否触发自动压缩
 * 数据源：state.serverTokenUsage.accumulatedTokens
 */
function checkAutoCompact() {
  if (!autoCompactEnabled || autoCompactTriggering) return;
  const server = serverTokenUsage;
  if (!server || typeof server.accumulatedTokens !== 'number') return;
  const thresholdTokens = autoCompactThresholdWan * 10000;
  if (server.accumulatedTokens < thresholdTokens) return;
  // 触发
  autoCompactTriggering = true;
  console.log('[Cuckoo Compact] 自动触发：当前 ' + server.accumulatedTokens + ' >= 阈值 ' + thresholdTokens);
  showToast('Token 超阈值（' + autoCompactThresholdWan + '万），自动压缩中...', 4000);
  runCompaction(state.currentProjectDir || undefined).finally(() => {
    // 压缩会跳转页面；若未跳转（失败），重置标志允许下次重试
    autoCompactTriggering = false;
  });
}

/**
 * 启动对话 token 显示 + 自动压缩检查（事件驱动）
 * 仅在收到成功回复事件时刷新 token 显示并检查自动压缩，
 * 避免失败/停止时因旧 token 值反复触发压缩。
 */
function startTokenCounter() {
  hooks.onInterceptedResponse?.((_text: string, meta: any) => {
    // 一轮回复完成：保留本轮最终 TPS（不清零），仅更新 token 统计。
    // 下一轮生成开始时由测速器内部自动重置。
    serverTokenUsage = (meta && meta.tokenUsage) || null;
    // 按当前会话写入缓存（切回来时能显示该会话的值）
    const tokens = serverTokenUsage && serverTokenUsage.accumulatedTokens;
    if (typeof tokens === 'number') {
      const sid = getCurrentSessionId();
      if (sid) saveTokenForSession(sid, tokens);
    }
    updateConversationTokenDisplay();
  });
  // 自动压缩：只在"任务空闲"（工具循环结束）时检查——避免与工具结果抢输入框
  hooks.onTaskIdle?.(() => checkAutoCompact());
  updateConversationTokenDisplay();

  // 输出速度（TPS）：订阅流式正文增量，实时计算并推送。
  // 生成中实时更新；finished 后测速器冻结最终值，pushTps 保留显示（不清零）。
  hooks.onStream?.((ev: any) => {
    try {
      const text = (ev && ev.text) || '';
      const finished = !!(ev && ev.finished);
      // DeepSeek 提供 accumulatedTokens（权威）；其余平台为 null，回退估算
      const acc = ev && typeof ev.accumulatedTokens === 'number' ? ev.accumulatedTokens : null;
      tpsMeter.update(text, finished, acc);
      pushTps(finished);
    } catch (_) { /* ignore */ }
  });
}

/**
 * 绑定覆盖层所有 UI 事件
 * 包括按钮点击、键盘快捷键、状态徽章点击等
 */
function bindEvents() {
  // 防止重复绑定（SPA 导航或 preload 重载时可能导致多次执行）
  if (eventsBound) return;
  eventsBound = true;

  // 从 localStorage 恢复发送延迟配置
  try {
    const savedMin = localStorage.getItem('cuckoo-send-delay-min');
    const savedMax = localStorage.getItem('cuckoo-send-delay-max');
    // 注意：不能用 "parseInt() || 默认值"——0 是有效值，会被 || 误判为假值丢弃
    if (savedMin !== null) { const v = parseInt(savedMin, 10); if (Number.isFinite(v) && v >= 0) state.sendDelayMin = v; }
    if (savedMax !== null) { const v = parseInt(savedMax, 10); if (Number.isFinite(v) && v >= 0) state.sendDelayMax = v; }
  } catch (e) {}

  // 首次使用提示浮窗：初始化 + 关闭
  const firstInitBtn = document.getElementById('cuckoo-btn-first-init');
  firstInitBtn?.addEventListener('click', handleInitProject);
  const firstCloseBtn = document.getElementById('cuckoo-btn-first-close');
  firstCloseBtn?.addEventListener('click', hideFirstTimeDialog);

  // 自动压缩：加载配置
  loadAutoCompactConfig();

  // 启动输入框 token 估算 + 自动压缩检查
  startTokenCounter();

  // 压缩流程：先检查是否处于"段2"（刷新后等 IDB 重建），否则检查"段3"（分享页初始化）
  checkPendingCompact().then((handled) => {
    if (!handled) checkPendingInit();
  });

  // 键盘快捷键：Esc 关闭首次引导框
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideFirstTimeDialog();
    }
  });
}

// ========== 自动压缩（供 IPC：壳页面 Token 页调用） ==========
/** 读自动压缩配置（不解 DOM） */
function getAutoCompactConfig(): { enabled: boolean; threshold: number } {
  let enabled = false;
  let threshold = 80;
  try {
    enabled = localStorage.getItem('cuckoo-auto-compact-enabled') === '1';
    const th = localStorage.getItem('cuckoo-auto-compact-threshold');
    if (th !== null) { const v = parseFloat(th); if (Number.isFinite(v) && v > 0) threshold = v; }
  } catch (_) {}
  return { enabled, threshold };
}

/** 保存自动压缩配置（更新内存 + localStorage） */
function applyAutoCompactConfig(data: any): { success: boolean; error?: string; data?: any } {
  const enabled = !!(data && data.enabled);
  let th = data ? parseFloat(data.threshold) : 80;
  if (!Number.isFinite(th) || th <= 0) return { success: false, error: '阈值需为正数（万）' };
  autoCompactEnabled = enabled;
  autoCompactThresholdWan = th;
  try {
    localStorage.setItem('cuckoo-auto-compact-enabled', enabled ? '1' : '0');
    localStorage.setItem('cuckoo-auto-compact-threshold', String(th));
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, data: { enabled, threshold: th } };
}

/** 手动触发压缩（调用压缩流程） */
function triggerCompaction(): void {
  runCompaction(state.currentProjectDir || undefined).catch((e: any) => {
    console.error('[Cuckoo Code] 压缩失败:', e && e.message);
  });
}

export { bindEvents, wireEvents, refreshTokenForCurrentSession, setIsSubagentWindow, getAutoCompactConfig, applyAutoCompactConfig, triggerCompaction };
