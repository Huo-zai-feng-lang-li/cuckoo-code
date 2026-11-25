/**
 * API transport 主进程运行时。
 *
 * 每个窗口（profile）一条独立对话历史；请求由主进程直接发出，
 * 不创建/不驱动 AI 网页，因此不会触发网页风控与 DOM 指纹链路。
 *
 * 工具调用：原生 OpenAI tool_calls → 现有 ToolRegistry，
 * 执行前走 ipc-guard（来源校验/workspace 信任/弹窗确认），不另开权限通道。
 */
import { readPrefs, getApiConnection } from '../app/ui-prefs.js';
import { abortWindowProcesses } from '../infra/process-tracker.js';
import { jsRunner } from '../tools/index.js';
import { resolveApiConfig } from './config.js';
import type { ApiConnectionPrefs } from '../app/ui-prefs.js';
import { streamChat, ApiRequestError, ApiTimeoutError } from './client.js';
import type { ApiChatMessage, ApiToolCall, ApiUsage } from './client.js';
import { buildOpenAiTools, executeApiToolCall, formatToolCall } from './tool-loop.js';
import { buildApiSystemPrompt } from './system-prompt.js';
import { estimateJsonTokens, resolveContextBudget, trimMessagesToBudget, estimateMessageTokens, estimateTokens } from './context.js';
import type { ContextBudget } from './context.js';
import { loadApiSessionSnapshot, saveApiSession, clearApiSession, createApiSession, setActiveApiSession, deleteApiSession, listApiSessions, getActiveApiSessionId, deriveSessionTitle, pruneProfileAttachments, setApiSessionProjectDir } from './session-store.js';
import { saveIncomingAttachments, materializeMessages } from './attachments.js';
import type { IncomingAttachment, StoredAttachment } from './attachments.js';

interface SessionState {
  sessionId: string;
  title: string;
  createdAt: number;
  messages: ApiChatMessage[];
  controller: AbortController | null;
  /** 当前会话绑定的项目目录（持久化在会话快照里） */
  projectDir: string | null;
  /** 当前在途 turn；新消息必须等旧 turn 收尾，避免旧 finally 污染新历史 */
  turn: Promise<void> | null;
  /** 新对话请求：等旧 turn 收尾后再清空历史，避免清空数组被旧 turn 继续 push */
  pendingReset: boolean;
  /** 当前 system message 的构建键；项目目录/自定义提示词变化时重建 */
  systemKey: string;
  /** 上游明确拒绝图片后置 true，后续回合不再反复发图/反复 400 */
  visionUnsupported: boolean;
  /** 触发图片降级的模型名；切换模型后自动解除，避免影响新的视觉模型 */
  visionUnsupportedModel?: string;
  /** 窗口关闭后旧 turn 仍可能收尾，禁止它再把快照写回磁盘 */
  disposed?: boolean;
  /** 累计 usage（网关返回才累计） */
  usageTotal: ApiUsage;
}

export type ApiSendCode = 'empty' | 'not_configured' | 'request_failed' | 'stopped' | 'tools_disabled' | 'rounds_limit' | 'attachments_disabled';

export interface ApiSendResult {
  success: boolean;
  error?: string;
  text?: string;
  code?: ApiSendCode;
}

const sessions = new Map<string, SessionState>();
const MAX_HISTORY_MESSAGES = 500;


function stateKey(ctx: any, sessionId: string): string {
  const profileId = ctx && ctx.profileId ? String(ctx.profileId) : '';
  const winId = ctx && ctx.win && ctx.win.id ? String(ctx.win.id) : '';
  return profileId + '#' + winId + '#' + sessionId;
}

function profileOf(ctx: any): string {
  return ctx && ctx.profileId ? String(ctx.profileId) : '';
}

function persist(ctx: any, state: SessionState): void {
  if (state.disposed) return; // 窗口已关闭：旧 turn 的收尾不得把快照重新写回磁盘
  const profileId = profileOf(ctx);
  if (!profileId) return;
  if (!state.title || state.title === '新对话') state.title = deriveSessionTitle(state.messages);
  const currentDir = ctx && ctx.sessionStore && ctx.sessionStore.state
    ? ctx.sessionStore.state.selectedProjectDir
    : state.projectDir;
  state.projectDir = currentDir || null;
  saveApiSession(profileId, state.messages, {
    sessionId: state.sessionId,
    title: state.title,
    createdAt: state.createdAt,
    usageTotal: state.usageTotal,
    projectDir: state.projectDir,
  });
}

/** 把项目目录同步到窗口 sessionStore，并通知壳页面顶栏与 harness 首屏。 */
function applyProjectDir(ctx: any, projectDir: string | null): void {
  const dir = projectDir || null;
  try {
    if (ctx && ctx.sessionStore && ctx.sessionStore.state) ctx.sessionStore.state.selectedProjectDir = dir;
  } catch (_) { /* ignore */ }
  try { if (ctx && ctx.harnessView && ctx.harnessView.webContents) ctx.harnessView.webContents.send('harness-event', { type: 'project-dir', dir }); } catch (_) { /* ignore */ }
  try { if (ctx && ctx.win && ctx.win.webContents) ctx.win.webContents.send('shell-project-dir', dir); } catch (_) { /* ignore */ }
}

function getState(ctx: any, sessionId?: string): SessionState {
  const profileId = profileOf(ctx);
  const sid = sessionId || getActiveApiSessionId(profileId);
  const key = stateKey(ctx, sid);
  let st = sessions.get(key);
  if (!st) {
    const snap = loadApiSessionSnapshot(profileId, sid);
    st = {
      sessionId: sid,
      title: snap ? snap.title : '新对话',
      createdAt: snap ? snap.createdAt : Date.now(),
      messages: snap ? snap.messages : [],
      controller: null,
      projectDir: snap ? (snap.projectDir || null) : null,
      turn: null,
      pendingReset: false,
      systemKey: '',
      visionUnsupported: false,
      visionUnsupportedModel: '',
      usageTotal: snap && snap.usageTotal ? { ...snap.usageTotal } : {},
    };
    sessions.set(key, st);
  }
  return st;
}

function emit(ctx: any, payload: any): void {
  try {
    const hv = ctx && ctx.harnessView;
    if (!hv || !hv.webContents || hv.webContents.isDestroyed()) return;
    hv.webContents.send('harness-event', payload);
  } catch (_) { /* ignore */ }
}

function ensureSystemMessage(state: SessionState, prompt: string, key: string): void {
  if (state.messages.length > 0 && state.messages[0].role === 'system' && state.systemKey === key) return;
  if (state.messages.length > 0 && state.messages[0].role === 'system') {
    state.messages[0] = { role: 'system', content: prompt };
  } else {
    state.messages.unshift({ role: 'system', content: prompt });
  }
  state.systemKey = key;
}

/**
 * 按上下文预算裁剪历史，只从 user 边界切，避免把 assistant(tool_calls) 与 tool
 * 结果切成孤儿。长度上限只是防御性兜底，不是主要裁剪依据。
 */
function trimHistory(state: SessionState, budget: number): void {
  if (state.messages.length > MAX_HISTORY_MESSAGES) {
    const system = state.messages[0] && state.messages[0].role === 'system' ? state.messages[0] : null;
    state.messages = system ? [system, ...state.messages.slice(-MAX_HISTORY_MESSAGES + 1)] : state.messages.slice(-MAX_HISTORY_MESSAGES);
  }
  if (budget > 0) state.messages = trimMessagesToBudget(state.messages, budget);
}

/**
 * 补齐中断轮里缺失的 tool 结果。
 * OpenAI 要求每个 assistant.tool_calls 后面都有对应 tool 消息；停止/异常时
 * 缺一条就会让下一轮请求 400，所以这里统一补 cancelled，而不是只回滚内存。
 */
export function fillMissingToolResults(
  messages: ApiChatMessage[],
  assistant: ApiChatMessage | null,
  calls: ApiToolCall[],
  completedIds: Set<string>,
): void {
  if (!assistant || !Array.isArray(calls) || calls.length === 0) return;
  if (!messages.includes(assistant)) return;
  for (const call of calls) {
    if (!call || !call.id || completedIds.has(call.id)) continue;
    messages.push({ role: 'tool', tool_call_id: call.id, content: 'ERROR: cancelled' });
  }
}

interface ApiRuntimeOptions {
  success: true;
  config: any;
  connection: ApiConnectionPrefs;
  toolsEnabled: boolean;
  maxToolRounds: number;
  tools: any[];
  budget: ContextBudget;
  systemPrompt: string;
  systemKey: string;
  toolsTokens: number;
}

function readOptions(ctx: any): ApiRuntimeOptions | { success: false; error: string } {
  const prefs = readPrefs();
  const conn = getApiConnection(prefs, ctx && ctx.profileId ? String(ctx.profileId) : '');
  const cfg = resolveApiConfig(conn);
  if (!cfg.success) return cfg;

  const toolsEnabled = conn.toolsEnabled !== false;
  const tools = toolsEnabled ? buildOpenAiTools() : [];
  const toolsTokens = estimateJsonTokens(tools);
  const budget = resolveContextBudget({
    contextWindow: conn.contextWindow,
    maxOutputTokens: conn.maxOutputTokens,
    toolsTokens,
  });
  const selectedDir = (ctx && ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.selectedProjectDir)
    || process.cwd();
  // 规则/技能/记忆/MCP 变化后不能继续复用旧 system message。把构建结果指纹
  // 放进 key，内容变了就替换 system，确保每次请求都吃到最新注入。
  const systemPrompt = buildApiSystemPrompt({ selectedDir: String(selectedDir), customSystemPrompt: conn.systemPrompt });
  const systemKey = String(selectedDir) + '\n' + String(conn.systemPrompt || '') + '\n' + systemPrompt.length + ':' + promptHash(systemPrompt);
  return {
    success: true,
    config: cfg.config,
    connection: conn,
    toolsEnabled,
    maxToolRounds: conn.maxToolRounds,
    tools,
    budget,
    systemPrompt,
    systemKey,
    toolsTokens,
  };
}

/** 轻量 FNV-1a 指纹：只用于判断 system prompt 是否变化 */
function promptHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function formatError(err: any): string {
  if (err instanceof ApiTimeoutError) return err.message;
  if (err instanceof ApiRequestError) return err.message;
  return 'API 请求失败：' + ((err && err.message) || String(err));
}

function abortWindowWork(windowId: number | null): void {
  if (windowId === null) return;
  try { abortWindowProcesses(windowId); } catch (_) { /* ignore */ }
  try { if (jsRunner && typeof jsRunner.abortAll === 'function') jsRunner.abortAll(windowId); } catch (_) { /* ignore */ }
}

/** 新对话/关窗后，旧 turn 的流式与工具事件不得再画进新界面 */
function uiDropped(state: SessionState): boolean {
  return !!(state.disposed || state.pendingReset);
}

function abortRunningWork(ctx: any): void {
  const winId = ctx && ctx.win && !ctx.win.isDestroyed() ? ctx.win.id : null;
  abortWindowWork(winId);
}

/**
 * 导出主进程磁盘快照里的用户/助手正文，供 harness 页面在重启后恢复 UI。
 * 不返回 system / tool / tool_calls；模型上下文仍在主进程，UI 只负责显示。
 */
export function getApiHistory(ctx: any): {
  success: boolean;
  items: Array<{ t: 'user' | 'assistant'; text: string }>;
  sessionId: string;
  title: string;
} {
  const st = getState(ctx);
  const items: Array<{ t: 'user' | 'assistant'; text: string }> = [];
  for (const m of st.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    // 用户消息的 content 可能包含隐藏的技能/计划指令；displayText 是气泡里真正展示的文本。
    let text = m.role === 'user' && typeof (m as any).displayText === 'string'
      ? String((m as any).displayText)
      : '';
    if (!text) {
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
        }
      }
    }
    text = text.trim();
    if (!text && m.attachments && m.attachments.length) text = '[附件 ' + m.attachments.length + ' 个]';
    if (text) items.push({ t: m.role, text });
  }
  return { success: true, items: items.slice(-200), sessionId: st.sessionId, title: st.title };
}

/**
 * 从指定 user 消息处物理截断模型上下文；用于 API 模式编辑旧消息后“从此处重发”。
 * 传的是“从后往前第 N 条 user”（0 = 最后一条），这样即使 UI 历史缺少更早的前缀，
 * 也不会把目标消息错位；system 始终保留，target 及其后的 assistant/tool 全部删除。
 * @param userIndexFromEnd 目标 user 从末尾算起的序号，0 开始
 */
export function truncateApiHistory(ctx: any, userIndexFromEnd: number): {
  success: boolean;
  removed?: number;
  remaining?: number;
  error?: string;
} {
  const st = getState(ctx);
  const fromEnd = Number.isInteger(userIndexFromEnd) && userIndexFromEnd >= 0 ? userIndexFromEnd : -1;
  if (fromEnd < 0) return { success: false, error: 'bad-index' };
  const system = st.messages.filter((m) => m.role === 'system');
  const nonSystem = st.messages.filter((m) => m.role !== 'system');
  let seen = 0;
  let cut = -1;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i].role !== 'user') continue;
    if (seen === fromEnd) { cut = i; break; }
    seen++;
  }
  if (cut < 0) return { success: false, error: 'user-not-found' };
  const removed = nonSystem.length - cut;
  const kept = nonSystem.slice(0, cut);
  st.messages = [...system, ...kept];
  persist(ctx, st);
  return { success: true, removed, remaining: kept.length };
}

/**
 * 从 harness localStorage 历史导入一次旧对话。
 * 只导入用户/助手正文，工具卡与思考内容不进入模型上下文；
 * 若磁盘会话已有两条以上用户消息，说明快照更新，放弃导入避免覆盖。
 */
export function importApiHistory(ctx: any, items: any[]): { success: boolean; imported: boolean; count?: number } {
  const st = getState(ctx);
  const existing = st.messages;
  const existingUsers = existing.filter((m) => m.role === 'user').length;
  // 后端已有用户消息就说明这份快照已在正常使用；再导入本地旧历史会把同一句
  // 用户话重复插到上下文前面（实测出现两遍“你好”），只允许纯空快照迁移。
  if (existingUsers > 0) return { success: true, imported: false };
  const mapped: ApiChatMessage[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || (item.t !== 'user' && item.t !== 'assistant')) continue;
    const text = String(item.text == null ? '' : item.text).trim();
    if (!text) continue;
    mapped.push({ role: item.t, content: text.length > 6000 ? text.slice(0, 6000) + '\n…[历史记录已截断]' : text, displayText: text });
  }
  if (!mapped.length) return { success: true, imported: false };
  const system = existing.find((m) => m.role === 'system');
  const extra = existing.filter((m) => m.role !== 'system');
  st.messages = [
    ...(system ? [system] : []),
    ...mapped.slice(-80),
    ...extra,
  ].slice(-MAX_HISTORY_MESSAGES);
  persist(ctx, st);
  return { success: true, imported: true, count: mapped.length };
}

/** 停掉当前 turn 并等它收尾；切换/新建会话前必须做，避免旧 turn 往新会话 push。 */
async function settleTurn(ctx: any, state: SessionState): Promise<void> {
  if (state.controller) {
    try { state.controller.abort(); } catch (_) { /* ignore */ }
  }
  abortRunningWork(ctx);
  const turn = state.turn;
  if (turn) {
    try { await turn; } catch (_) { /* ignore */ }
  }
  state.controller = null;
}

/** 新对话：新建一份空会话并切换 active，旧会话保留可回看。 */
export async function startNewApiSession(ctx: any): Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }> {
  const profileId = profileOf(ctx);
  if (!profileId) return { success: false, error: 'no-profile' };
  try {
    const current = getState(ctx);
    await settleTurn(ctx, current);
    const currentDir = ctx && ctx.sessionStore && ctx.sessionStore.state ? ctx.sessionStore.state.selectedProjectDir : current.projectDir;
    const sessionId = createApiSession(profileId, { projectDir: currentDir || null });
    const st = getState(ctx, sessionId);
    applyProjectDir(ctx, st.projectDir || currentDir || null);
    emit(ctx, { type: 'usage', total: {} });
    emit(ctx, { type: 'api-session', sessionId, title: st.title });
    return { success: true, sessionId, title: st.title };
  } catch (err: any) {
    return { success: false, error: (err && err.message) || '新建会话失败' };
  }
}

/** 切换 active 会话；旧会话已由 persist 落盘，新会话从磁盘加载。 */
export async function selectApiSession(ctx: any, sessionId: string): Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }> {
  const profileId = profileOf(ctx);
  if (!profileId || !sessionId) return { success: false, error: 'no-session' };
  const list = listApiSessions(profileId);
  if (!list.sessions.some((s) => s.id === sessionId)) return { success: false, error: '会话不存在' };
  const current = getState(ctx);
  if (current.sessionId === sessionId) return { success: true, sessionId, title: current.title };
  try {
    await settleTurn(ctx, current);
    if (!setActiveApiSession(profileId, sessionId)) return { success: false, error: '会话不存在' };
    const st = getState(ctx, sessionId);
    const currentDir = ctx && ctx.sessionStore && ctx.sessionStore.state ? ctx.sessionStore.state.selectedProjectDir : current.projectDir;
    const dir = st.projectDir || currentDir || null;
    if (!st.projectDir && dir) {
      st.projectDir = dir;
      setApiSessionProjectDir(profileId, sessionId, dir);
    }
    applyProjectDir(ctx, dir);
    sessionStateCleanup(ctx, current.sessionId, false);
    emit(ctx, { type: 'usage', total: { ...st.usageTotal } });
    emit(ctx, { type: 'api-session', sessionId, title: st.title });
    emit(ctx, { type: 'status', text: '就绪', busy: false });
    emit(ctx, { type: 'ai-state', generating: false });
    emit(ctx, { type: 'task-idle' });
    return { success: true, sessionId, title: st.title };
  } catch (err: any) {
    return { success: false, error: (err && err.message) || '切换会话失败' };
  }
}

/** 删除会话；删 active 时自动切到最近一份，并清理孤儿附件。 */
export async function removeApiSession(ctx: any, sessionId: string): Promise<{ success: boolean; activeSessionId?: string; error?: string }> {
  const profileId = profileOf(ctx);
  if (!profileId || !sessionId) return { success: false, error: 'no-session' };
  const list = listApiSessions(profileId);
  if (!list.sessions.some((s) => s.id === sessionId)) return { success: false, error: '会话不存在' };
  const current = getState(ctx);
  try {
    if (current.sessionId === sessionId) await settleTurn(ctx, current);
    const active = deleteApiSession(profileId, sessionId);
    sessionStateCleanup(ctx, sessionId, false);
    const st = getState(ctx, active);
    if (current.sessionId === sessionId) {
      const currentDir = current.projectDir || (ctx && ctx.sessionStore && ctx.sessionStore.state ? ctx.sessionStore.state.selectedProjectDir : null);
      const dir = st.projectDir || currentDir || null;
      if (!st.projectDir && dir) {
        st.projectDir = dir;
        setApiSessionProjectDir(profileId, active, dir);
      }
      applyProjectDir(ctx, dir);
    }
    emit(ctx, { type: 'usage', total: { ...st.usageTotal } });
    emit(ctx, { type: 'api-session', sessionId: active, title: st.title });
    return { success: true, activeSessionId: active };
  } catch (err: any) {
    return { success: false, error: (err && err.message) || '删除会话失败' };
  }
}

/** 清理某个 session 的内存态；disposed=true 时禁止旧 turn 回写。 */
function sessionStateCleanup(ctx: any, sessionId: string, disposed: boolean): void {
  const key = stateKey(ctx, sessionId);
  const st = sessions.get(key);
  if (st) {
    if (disposed) st.disposed = true;
    sessions.delete(key);
  }
}

/** 清空某个窗口的 API 对话历史（兼容旧入口；新对话应走 startNewApiSession）。 */
export function resetApiSession(ctx: any): void {
  const st = getState(ctx);
  // stop 会把 controller 置空但旧 turn 仍在收尾；此时不能立刻清空历史，
  // 否则旧 turn 仍可能把 tool 结果 push 回来，形成没有 assistant 的孤儿 tool 消息。
  const hadActive = !!st.controller || !!st.turn;
  if (st.controller) {
    try { st.controller.abort(); } catch (_) { /* ignore */ }
  }
  if (st.turn) {
    // 有在途 turn：等它的 finally 统一清空，避免旧 turn 在清空后继续 push tool 结果
    st.pendingReset = true;
  } else {
    st.messages = [];
  }
  st.systemKey = '';
  st.visionUnsupported = false;
  st.visionUnsupportedModel = '';
  st.usageTotal = {};
  clearApiSession(profileOf(ctx));
  st.controller = null;
  abortRunningWork(ctx);
  emit(ctx, { type: 'usage', total: {} });
  if (hadActive) emit(ctx, { type: 'retry-state', state: 'cancelled' });
}

/** 窗口关闭/销毁时彻底释放：中止在途请求 + 杀工具进程 + 删除 Map 条目 */
export function disposeApiSession(profileId: string, windowId: number | null): void {
  if (windowId === null) return;
  const prefix = String(profileId) + '#' + String(windowId) + '#';
  for (const [key, st] of sessions) {
    if (key !== prefix && !key.startsWith(prefix)) continue;
    st.disposed = true;
    if (st.controller) {
      try { st.controller.abort(); } catch (_) { /* ignore */ }
    }
    sessions.delete(key);
  }
  abortWindowWork(windowId);
}

/** 停止某个窗口正在进行的 API 请求/工具 */
export function stopApiSession(ctx: any): void {
  const st = getState(ctx);
  if (st.controller) {
    try { st.controller.abort(); } catch (_) { /* ignore */ }
  }
  st.controller = null;
  abortRunningWork(ctx);
  emit(ctx, { type: 'retry-state', state: 'cancelled' });
  emit(ctx, { type: 'ai-state', generating: false });
  emit(ctx, { type: 'task-idle' });
}

/**
 * 发送一条用户消息并流式回传。
 * @returns 与 harness-send IPC 相同的 { success, error, text }
 */
export async function sendApiMessage(ctx: any, text: string, files?: IncomingAttachment[], displayText?: string): Promise<ApiSendResult> {
  const content = typeof text === 'string' ? text.trim() : '';
  const incoming = Array.isArray(files) ? files : [];
  if (!content && incoming.length === 0) return { success: false, error: '消息为空', code: 'empty' };

  const st = getState(ctx);
  // 防并行：先 abort 旧请求并等旧 turn 收尾，再改历史；否则旧 finally 可能把
  // cancelled tool 消息插到新 user 消息后面，形成非法历史。
  const previousTurn = st.turn;
  if (st.controller) {
    try { st.controller.abort(); } catch (_) { /* ignore */ }
    abortRunningWork(ctx);
  }
  if (previousTurn) {
    try { await previousTurn; } catch (_) { /* ignore */ }
  }
  st.controller = new AbortController();
  const controller = st.controller;

  const opts = readOptions(ctx);
  if (!opts.success) {
    st.controller = null;
    emit(ctx, { type: 'notice', text: opts.error });
    emit(ctx, { type: 'status', text: 'API 未配置', busy: false });
    emit(ctx, { type: 'task-idle' });
    return { success: false, error: opts.error, code: 'not_configured' };
  }

  let stored: StoredAttachment[] = [];
  if (incoming.length > 0) {
    const saved = await saveIncomingAttachments(String(ctx.profileId || ''), incoming);
    stored = saved.stored || [];
    if (saved.error) emit(ctx, { type: 'notice', text: saved.error });
    if (!opts.connection.vision) {
      const imgs = stored.filter((a) => a.kind === 'image');
      if (imgs.length > 0) {
        stored = stored.filter((a) => a.kind !== 'image');
        emit(ctx, {
          type: 'notice',
          text: '当前 API 连接未开启“图片输入”，已跳过 ' + imgs.length + ' 张图片；可在 API 设置里开启（网关不支持 vision 时不要开）。',
        });
      }
    }
    if (!content && stored.length === 0) {
      st.controller = null;
      emit(ctx, { type: 'status', text: '就绪', busy: false });
      emit(ctx, { type: 'task-idle' });
      return { success: false, error: saved.error || '附件不可用', code: 'attachments_disabled' };
    }
  }

  const { config, toolsEnabled, maxToolRounds, budget, tools } = opts;
  // 切换模型后重新允许图片：旧模型被 400 拒绝不代表新模型不支持视觉
  const visionModel = String(config.model || '');
  if (st.visionUnsupported && st.visionUnsupportedModel && st.visionUnsupportedModel !== visionModel) {
    st.visionUnsupported = false;
    st.visionUnsupportedModel = '';
  }
  ensureSystemMessage(st, opts.systemPrompt, opts.systemKey);
  const shown = typeof displayText === 'string' && displayText.trim() ? displayText.trim() : content;
  st.messages.push({
    role: 'user',
    content: content || '（附件）',
    displayText: shown || undefined,
    attachments: stored.length ? stored : undefined,
  });
  trimHistory(st, budget.inputBudget);
  persist(ctx, st);
  emit(ctx, { type: 'ai-state', generating: true });
  // 模型响应阶段统一三态：还没出字 = 思考中；onText 起由 harness 的 onStream 切到输出中。
  emit(ctx, { type: 'status', text: '模型思考中…', busy: true });

  let finishTurn: () => void = () => { /* set below */ };
  const turn = new Promise<void>((resolve) => { finishTurn = resolve; });
  st.turn = turn;
  let lastText = '';
  // 本轮工具调用如果被停止/异常打断，finally 里补齐缺失的 tool 消息，
  // 绝不把 assistant(tool_calls=[...]) 单独留在历史里（下一轮网关会 400）。
  let pendingAssistant: ApiChatMessage | null = null;
  let pendingCalls: ApiToolCall[] = [];
  const completedToolIds = new Set<string>();
  try {
    for (let round = 0; round < maxToolRounds; round++) {
      if (controller.signal.aborted) return { success: false, error: '已停止', code: 'stopped' };
      pendingAssistant = null;
      pendingCalls = [];
      completedToolIds.clear();
      // 每轮工具循环开始 = 模型基于（上轮工具结果）继续思考；出字后由 harness 的 onStream 接管为输出中。
      emit(ctx, { type: 'status', text: '模型思考中…', busy: true });

      trimHistory(st, budget.inputBudget);
      const requestMessages = await materializeMessages(
        st.messages,
        opts.connection.vision && !st.visionUnsupported ? 8 : 0,
      );
      const requestOptions = {
        config,
        tools,
        signal: controller.signal,
        reasoningEffort: opts.connection.reasoningEffort,
        maxOutputTokens: budget.outputReserve,
        usageReporting: opts.connection.usageReporting,
        onRetry: (retry: any) => {
          emit(ctx, {
            type: 'retry-state',
            state: retry && retry.state,
            delayMs: retry && retry.delayMs,
            is429: !!(retry && retry.is429),
            count: retry && retry.count,
          });
        },
        onText: (textSoFar: string, thinkSoFar: string) => {
          if (uiDropped(st)) return;
          emit(ctx, { type: 'stream', think: thinkSoFar, text: textSoFar, finished: false });
          // 流式过程中按已生成字符估算速度，节流 600ms；最终以 usage.completion_tokens 为准。
          const now = Date.now();
          if (now - lastTpsAt >= 600) {
            lastTpsAt = now;
            const est = estimateTokens(textSoFar) + estimateTokens(thinkSoFar);
            const sec = Math.max(0.2, (now - roundStartedAt) / 1000);
            const liveTps = Math.round((est / sec) * 10) / 10;
            if (liveTps > 0) emit(ctx, { type: 'tps', tps: liveTps });
          }
        },
      };
      const roundStartedAt = Date.now();
      let lastTpsAt = 0;
      let result;
      try {
        result = await streamChat({ ...requestOptions, messages: requestMessages });
      } catch (err: any) {
        // 有的网关/上游会把 image_url 内容块序列化成 type=unknown 并 400。
        // 图片是尽力而为的增强，不能因此让整轮对话失败：自动降级纯文本重试一次。
        const hasImage = requestMessages.some((m) => Array.isArray(m.content)
          && m.content.some((p: any) => p && p.type === 'image_url'));
        if (Number(err && err.status) !== 400 || !hasImage) throw err;
        if (controller.signal.aborted || uiDropped(st)) return { success: false, error: '已停止', code: 'stopped' };
        // 400 不一定是“不支持图片”：可能是上下文超限/参数错误。只有错误详情确实
        // 指向 image/vision/content 时才永久禁用当前模型的图片，避免误伤其他模型。
        const errDetail = String((err && err.message) || '') + ' ' + String((err && (err as any).body) || '');
        const imageRelated = /image|vision|multimodal|image_url|unknown|content/i.test(errDetail);
        if (imageRelated) {
          st.visionUnsupported = true;
          st.visionUnsupportedModel = visionModel;
        }
        emit(ctx, {
          type: 'notice',
          text: imageRelated
            ? '上游网关不支持图片内容块（400），已自动去掉图片、改为纯文本重试；本次图片没有进入模型上下文。'
            : '上游拒绝带图片的请求（400），已自动去掉图片重试；未禁用后续图片输入。',
        });
        const textOnly = await materializeMessages(st.messages, 0, {
          zeroImagePlaceholder: '[图片未发送：上游网关拒绝图片输入（400），本轮对话没有图片内容，不能描述或猜测图片内容]',
        });
        result = await streamChat({ ...requestOptions, messages: textOnly });
      }
      if (controller.signal.aborted || uiDropped(st)) return { success: false, error: '已停止', code: 'stopped' };
      const elapsedSec = Math.max(0.2, (Date.now() - roundStartedAt) / 1000);
      const promptTokens = Number(result.usage && result.usage.prompt_tokens) || 0;
      const completionTokens = Number(result.usage && result.usage.completion_tokens) || 0;
      const tps = completionTokens > 0
        ? Math.round((completionTokens / elapsedSec) * 10) / 10
        : Math.round(((result.text || '').length / 3.5 / elapsedSec) * 10) / 10;
      const contextTokens = (promptTokens + completionTokens) > 0
        ? promptTokens + completionTokens
        : st.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
      if (result.usage) {
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          st.usageTotal[key] = (Number(st.usageTotal[key]) || 0) + (Number(result.usage[key]) || 0);
        }
      }
      emit(ctx, {
        type: 'usage',
        usage: result.usage || {},
        total: { ...st.usageTotal },
        context: contextTokens,
        tps: tps > 0 ? tps : 0,
      });

      if (controller.signal.aborted) return { success: false, error: '已停止', code: 'stopped' };

      lastText = result.text || '';
      const calls: ApiToolCall[] = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      if (calls.length === 0) {
        if (lastText) {
          st.messages.push({ role: 'assistant', content: lastText });
          trimHistory(st, budget.inputBudget);
          persist(ctx, st);
        }
        emit(ctx, { type: 'stream', think: result.think || '', text: lastText, finished: true });
        emit(ctx, { type: 'assistant-done', text: lastText, hasTool: false });
        emit(ctx, { type: 'status', text: '就绪', busy: false });
        emit(ctx, { type: 'task-idle' });
        return { success: true, text: lastText };
      }

      if (!toolsEnabled) {
        const msg = '模型返回了工具调用，但当前 API 连接的工具调用开关是关闭的。可在“API 设置”里打开。';
        emit(ctx, { type: 'notice', text: msg });
        emit(ctx, { type: 'assistant-done', text: lastText || msg, hasTool: false });
        emit(ctx, { type: 'status', text: 'API 工具调用已关闭', busy: false });
        emit(ctx, { type: 'task-idle' });
        return { success: false, error: msg, code: 'tools_disabled' };
      }

      // 中间轮若有文字，先作为一条 assistant 消息展示并入库；工具卡随后出现。
      if (lastText) {
        emit(ctx, { type: 'assistant', text: lastText, hasTool: true });
      }
      const assistant: ApiChatMessage = {
        role: 'assistant',
        content: lastText || null,
        tool_calls: calls,
      };
      pendingAssistant = assistant;
      pendingCalls = calls;
      completedToolIds.clear();
      st.messages.push(assistant);
      trimHistory(st, budget.inputBudget);
      persist(ctx, st);

      for (const call of calls) {
        if (controller.signal.aborted || uiDropped(st)) return { success: false, error: '已停止', code: 'stopped' };
        const code = formatToolCall(call);
        emit(ctx, { type: 'tool-start', code });
        const exec = await executeApiToolCall(ctx, call, controller.signal);
        // 工具执行期间用户点了新对话/关窗：结果已经产生，但不能再画到新会话里，
        // 也不能 push 进已清空的 messages（否则出现没有 assistant 的孤儿 tool）
        if (controller.signal.aborted || uiDropped(st)) return { success: false, error: '已停止', code: 'stopped' };
        emit(ctx, {
          type: 'tool-end',
          success: exec.success,
          output: exec.output,
          error: exec.error || '',
          code,
        });
        st.messages.push({ role: 'tool', tool_call_id: call.id, content: exec.output || 'ok' });
        completedToolIds.add(call.id);
        persist(ctx, st);
      }
      pendingAssistant = null;
      pendingCalls = [];
      trimHistory(st, budget.inputBudget);
    }

    const msg = '工具调用超过最大轮数（' + maxToolRounds + '），已停止。可在“API 设置”里调大轮数（上限 500），或把任务拆小。';
    if (uiDropped(st)) return { success: false, error: '已停止', code: 'stopped' };
    emit(ctx, { type: 'notice', text: msg });
    emit(ctx, { type: 'assistant-done', text: lastText || msg, hasTool: false });
    emit(ctx, { type: 'status', text: '工具轮数超限', busy: false });
    emit(ctx, { type: 'task-idle' });
    return { success: false, error: msg, code: 'rounds_limit' };
  } catch (err: any) {
    if (controller.signal.aborted || uiDropped(st)) return { success: false, error: '已停止', code: 'stopped' };
    const msg = formatError(err);
    emit(ctx, { type: 'notice', text: msg });
    emit(ctx, { type: 'status', text: 'API 请求失败', busy: false });
    emit(ctx, { type: 'task-idle' });
    return { success: false, error: msg, code: 'request_failed' };
  } finally {
    if (!st.disposed) {
      if (st.pendingReset) {
        st.messages = [];
        st.pendingReset = false;
      } else {
        fillMissingToolResults(st.messages, pendingAssistant, pendingCalls, completedToolIds);
      }
      persist(ctx, st);
    }
    if (st.turn === turn) st.turn = null;
    finishTurn();
    if (st.controller === controller) st.controller = null;
    emit(ctx, { type: 'ai-state', generating: false });
  }
}
