/**
 * 子代理运行器（主进程侧编排）
 *
 * 流程：创建子代理窗口 → 等加载 → 导航到新对话 → 注入提示词+任务
 *      → 等子代理回复完成（无工具调用）→ 取最终文本 → 关闭窗口 → 返回
 *
 * 依赖注入：createWindow / profileManager 由 entry.ts 注入，避免循环依赖。
 */
import * as windowState from './window.js';
import { acquireAgentSlot, makeAgentReleaser, tryAcquireAgentSlot, cancelQueuedByParent } from './agent-semaphore.js';
import { SUBAGENT_TIMEOUT_MS, GATEWAY_TIMEOUT_MS } from '../infra/timeouts.js';

type CreateWindowFn = (profile: any) => number;

let _createWindow: CreateWindowFn | null = null;
let _profileManager: any = null;

/** 由 entry.ts 注入依赖 */
export function injectSubagentDeps(deps: { createWindow: CreateWindowFn; profileManager: any }): void {
  _createWindow = deps.createWindow;
  _profileManager = deps.profileManager;
}

/** 子代理返回结果：文本 + 是否因达到轮次上限而截断（partial） */
interface SubagentResult {
  text: string;
  /** true = 达到 maxTurns 被截断，text 是半截结果 */
  partial?: boolean;
}

/** 等待子代理完成的回调注册表：windowId → resolve */
const pending = new Map<number, (r: SubagentResult) => void>();

/** 每个 profile 正在跑的子代理数量（用于远程消息拦截等） */
const runningByProfile = new Map<string, number>();

/** ===== 运行中子代理注册表（供壳页面展示进度）===== */
export interface RunningSubagent {
  windowId: number;
  parentWindowId: number;
  agentName: string;
  task: string;
  startedAt: number;
  status: 'starting' | 'running' | 'done' | 'error';
  turn: number;
  preview: string;
  error?: string;
  /** 该子代理的超时上限（毫秒），供 UI 显示剩余时间 */
  timeoutMs: number;
}
const runningSubagents = new Map<number, RunningSubagent>();

/** 注册一个刚开始的子代理 */
function registerRunning(info: { windowId: number; parentWindowId: number; agentName: string; task: string; timeoutMs: number }): void {
  runningSubagents.set(info.windowId, {
    windowId: info.windowId,
    parentWindowId: info.parentWindowId,
    agentName: info.agentName,
    task: info.task,
    startedAt: Date.now(),
    status: 'starting',
    turn: 0,
    preview: '',
    timeoutMs: info.timeoutMs,
  });
  notifyParent(info.parentWindowId);
}

/** 更新运行中子代理的状态（进度/轮次/预览） */
function updateRunning(windowId: number, patch: Partial<RunningSubagent>): void {
  const cur = runningSubagents.get(windowId);
  if (!cur) return;
  Object.assign(cur, patch);
  notifyParent(cur.parentWindowId);
}

/** 移除（结束） */
function removeRunning(windowId: number): void {
  const cur = runningSubagents.get(windowId);
  if (!cur) return;
  runningSubagents.delete(windowId);
  notifyParent(cur.parentWindowId);
}

/** 列出某父窗口下的运行中子代理 */
function listRunning(parentWindowId?: number): RunningSubagent[] {
  const all = Array.from(runningSubagents.values());
  const list = parentWindowId ? all.filter((s) => s.parentWindowId === parentWindowId) : all;
  return list.sort((a, b) => a.startedAt - b.startedAt);
}

/** 通知父窗口壳页面 + harness 页面（纯净模式）刷新子代理状态（静默，失败忽略） */
function notifyParent(parentWindowId: number): void {
  try {
    const ctx = windowState.getWindowContext(parentWindowId);
    if (!ctx) return;
    // 1) 壳页面「子代理」页列表刷新
    if (ctx.win && !ctx.win.isDestroyed()) {
      ctx.win.webContents.send('shell-subagents-changed');
    }
    // 2) 纯净模式（harness）：runAgent 工具卡片实时展示子代理进度
    const hv: any = (ctx as any).harnessView;
    if (hv && hv.webContents && !hv.webContents.isDestroyed()) {
      hv.webContents.send('harness-event', {
        type: 'subagents',
        subagents: listRunning(parentWindowId),
      });
    }
  } catch (_) { /* ignore */ }
}

/** 该 profile 是否有子代理正在运行 */
export function hasRunningSubagent(profileId: string): boolean {
  return !!profileId && (runningByProfile.get(profileId) || 0) > 0;
}

export { listRunning, updateRunning };

/**
 * 取消某父窗口下所有运行中的子代理（真杀：销毁隐藏窗口 + 唤醒等待）。
 * 供停止按钮经 IPC 调用。返回取消的数量。
 */
export function cancelSubagentsByParent(parentWindowId: number, targetWindowId?: number): number {
  // 先取消该窗口下**排队中**的请求：它们还没创建窗口、不在 runningSubagents 里，
  // 若不取消，前 3 个跑完后排队的照样会启动，用户的"停止"意图落空。
  // 指定 targetWindowId 时不取消排队（排队者没有 windowId，无法精确匹配目标）。
  let n = targetWindowId === undefined ? cancelQueuedByParent(parentWindowId) : 0;
  for (const [windowId, info] of Array.from(runningSubagents.entries())) {
    if (info.parentWindowId !== parentWindowId) continue;
    if (targetWindowId !== undefined && windowId !== targetWindowId) continue;
    try {
      const ctx = windowState.getWindowContext(windowId);
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        try { ctx.win.destroy(); }
        catch (e1) { try { ctx.win.close(); } catch (e2) { /* ignore */ } }
      }
    } catch (_) { /* ignore */ }
    const resolve = pending.get(windowId);
    if (resolve) { pending.delete(windowId); resolve({ text: '__SUBAGENT_CANCELLED__' }); }
    removeRunning(windowId);
    n++;
  }
  return n;
}

function incRunning(profileId: string): void {
  if (!profileId) return;
  runningByProfile.set(profileId, (runningByProfile.get(profileId) || 0) + 1);
}
function decRunning(profileId: string): void {
  if (!profileId) return;
  const n = (runningByProfile.get(profileId) || 0) - 1;
  if (n <= 0) runningByProfile.delete(profileId);
  else runningByProfile.set(profileId, n);
}

/** bridge 侧检测到子代理完成时调用（IPC 入口） */
export function onSubagentResponse(windowId: number, text: string, partial?: boolean): void {
  const resolve = pending.get(windowId);
  if (resolve) {
    pending.delete(windowId);
    resolve({ text: text || '', partial: !!partial });
  }
}

/** 等子代理回复完成（超时兜底） */
function waitForDone(windowId: number, timeoutMs: number): Promise<SubagentResult> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      pending.delete(windowId);
      resolve({ text: '__SUBAGENT_TIMEOUT__' });
    }, timeoutMs);
    pending.set(windowId, (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/**
 * 运行一个子代理。
 * @param parentProfileId 父窗口 profile id（决定 partition）
 * @param agentName 代理名
 * @param task 任务描述
 * @param systemPrompt 代理系统提示（正文）
 * @param tools 允许的工具（可选，空=全部）
 * @param timeoutMs 超时
 * @returns 子代理最终文本
 */
export async function runAgent(opts: {
  parentProfileId: string;
  parentWindowId: number;
  agentName: string;
  task: string;
  systemPrompt: string;
  tools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}): Promise<string> {
  if (!_createWindow || !_profileManager) throw new Error('子代理依赖未注入');
  const timeoutMs = opts.timeoutMs || SUBAGENT_TIMEOUT_MS; // 默认 10 分钟

  // 取父窗口的项目目录 + providerId（用于构建工具系统提示）
  const parentCtx = windowState.getWindowContext(opts.parentWindowId);
  const parentStore = parentCtx ? parentCtx.sessionStore : null;
  const projectDir = parentStore ? parentStore.state.selectedProjectDir : null;
  const providerId = (parentCtx && parentCtx.providerId) || 'deepseek';
  // 父会话 ID（发起子代理的那个对话；为 null 时血缘记不了）
  const parentSessionId = (parentStore && parentStore.state && parentStore.state.currentSessionId) || null;

  // 父 profile 先校验：同步快速失败，不占并发队列名额
  const parent = _profileManager.getProfileById(opts.parentProfileId);
  if (!parent) throw new Error('父 profile 不存在: ' + opts.parentProfileId);

  // 并发闸门：子代理复用父 partition（同一登录态 / 浏览器指纹），
  // 同账号多路并发是明显的机器人特征。超出 MAX_CONCURRENT_AGENTS 时排队，
  // 排队超时直接抛错（不静默降级）。
  await acquireAgentSlot({ profileId: opts.parentProfileId, parentWindowId: opts.parentWindowId });
  const releaseSlot = makeAgentReleaser(opts.parentProfileId);
  let windowId = -1;
  let counted = false;
  try {
    const subProfile = _profileManager.createSubagentProfile(parent, opts.agentName);
    subProfile.subagentConfig = {
      agentName: opts.agentName,
      task: opts.task,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools || null,
      maxTurns: opts.maxTurns || null,
      projectDir: projectDir || null, // 传给子代理窗口，供 overlay 显示"当前项目目录"
    };
    console.log('[子代理] 启动 ' + opts.agentName + ' (父窗口 ' + opts.parentWindowId + ', 项目目录 ' + (projectDir || '无') + ')');
    // 必须先创建窗口成功再计数：createWindow 抛错时若已计数，decRunning 会因
    // 外层 try 尚未进入而永不执行，造成 runningByProfile 计数泄漏。
    windowId = _createWindow(subProfile);
    incRunning(opts.parentProfileId);
    counted = true;
    registerRunning({ windowId, parentWindowId: opts.parentWindowId, agentName: opts.agentName, task: opts.task, timeoutMs });

    // 关键：把父窗口的项目目录写入子代理窗口的 sessionStore，
    // 否则子代理执行工具（execute-js 从 ctx.sessionStore.state.selectedProjectDir 取）
    // 时 projectDir 为 null，相对路径/初始化状态都会错。
    try {
      const subCtx = windowState.getWindowContext(windowId);
      if (subCtx && subCtx.sessionStore) {
        if (projectDir) subCtx.sessionStore.state.selectedProjectDir = projectDir;
        // 血缘：子代理对话 -> 父对话（会话 ID 出现时自动绑定）
        if (parentSessionId) {
          subCtx.sessionStore.state.pendingLineage = { parentId: parentSessionId, kind: 'subagent', agentName: opts.agentName };
        }
      }
    } catch (_) { /* ignore */ }

    // 提示词由子代理窗口自己调 initProject 生成（复用初始化流程）
    const r = await waitForDone(windowId, timeoutMs);
    if (r.text === '__SUBAGENT_TIMEOUT__') throw new Error('子代理执行超时');
    if (r.text === '__SUBAGENT_CANCELLED__') throw new Error('子代理已被用户取消');
    updateRunning(windowId, { status: 'done', preview: (r.text || '').slice(0, 200) });
    // 达轮次上限被截断：显式标注，避免主对话把半截结果当完整结论
    return r.partial ? '[子代理达到轮次上限，以下为部分结果]\n' + r.text : r.text;
  } catch (err: any) {
    if (windowId >= 0) {
      updateRunning(windowId, { status: 'error', error: err && err.message ? err.message : String(err) });
    }
    throw err;
  } finally {
    if (counted) decRunning(opts.parentProfileId);
    if (windowId >= 0) {
      removeRunning(windowId);
      // 关闭子代理窗口
      // 用 destroy()：close() 在隐藏窗口上可能不生效（实测窗口会堆积、最终资源耗尽）
      try {
        const ctx = windowState.getWindowContext(windowId);
        if (ctx && ctx.win && !ctx.win.isDestroyed()) {
          try { ctx.win.destroy(); }
          catch (e1) { try { ctx.win.close(); } catch (e2) { /* ignore */ } }
        }
      } catch (_) { /* ignore */ }
      // 通知父窗口刷新工作区列表（子代理的会话/血缘已写入账本）
      try {
        const parentCtx = windowState.getWindowContext(opts.parentWindowId);
        if (parentCtx && parentCtx.win && !parentCtx.win.isDestroyed()) {
          parentCtx.win.webContents.send('shell-sessions-changed');
        }
      } catch (_) { /* ignore */ }
    }
    // 槽位释放放在最后：即使清理抛错也不会漏放
    releaseSlot();
  }
}

// ========== 网关：隐藏窗口问答（供 ai-gateway 插件调用）==========
//
// 为什么不让网关直接借用用户的活动窗口：
//   1) 会污染用户正在进行的对话；
//   2) 工具调用轮会与用户对话的事件流搅在一起，捕获不到"最终回复"；
//   3) 用户手动停止/切换会话会打断外部请求。
// 因此网关走"独立隐藏窗口"——与子代理同款：复用父 partition 免登录，
// 有完整 Cuckoo 系统提示词（含全部工具），工具循环天然正常。

/** 网关流式回调表：windowId → 回调（收到该窗口流式进度时调用） */
const gatewayStreams = new Map<number, (chunk: any) => void>();

// 网关与子代理**共用** agent-semaphore 的 3 个名额。
// 早期实现用独立的 gatewayActive 计数，两条路径各 3 个 → 实际可同时跑 6 个隐藏窗口，
// 同账号多路并发的风控目标被绕过。现在统一到同一个池子。

/** 取某窗口的网关流式回调（IPC 层用） */
export function getGatewayStream(windowId: number): ((chunk: any) => void) | undefined {
  return gatewayStreams.get(windowId);
}

/**
 * 在独立隐藏窗口里跑一次问答（不污染用户窗口；工具循环天然正常）。
 * 与 runAgent 的区别：不写血缘、不注入子代理提示词、支持流式回调。
 */
export async function runGatewayQuery(opts: {
  text: string;
  parentWindowId: number;
  onChunk?: (chunk: { think?: string; text?: string; done?: boolean }) => void;
  timeoutMs?: number;
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!_createWindow || !_profileManager) return { ok: false, error: '子代理依赖未注入' };
  const parentCtx = windowState.getWindowContext(opts.parentWindowId);
  if (!parentCtx) return { ok: false, error: '父窗口不存在' };
  const parent = _profileManager.getProfileById(parentCtx.profileId);
  if (!parent) return { ok: false, error: '父 profile 不存在' };
  const projectDir = parentCtx.sessionStore ? parentCtx.sessionStore.state.selectedProjectDir : null;

  // 与子代理共用**同一账号**的名额池（按 profileId 隔离，不同账号互不影响）。
  // 网关是插件调用，应快速失败而不是排队挂住调用方。
  if (!tryAcquireAgentSlot(parentCtx.profileId)) {
    return { ok: false, error: '并发已达上限（该账号的子代理 + 网关已占满），请稍后重试' };
  }
  const releaseGatewaySlot = makeAgentReleaser(parentCtx.profileId);

  const subProfile = _profileManager.createSubagentProfile(parent, 'gateway');
  subProfile.subagentConfig = {
    agentName: 'gateway',
    task: opts.text,
    systemPrompt: '',
    tools: null,
    maxTurns: null,
    projectDir: projectDir || null,
    isGateway: true, // 纯用户消息（不加"任务"框架），让 AI 自由用工具
  };
  let windowId = -1;
  try {
    windowId = _createWindow(subProfile);
  } catch (err: any) {
    // 创建窗口失败：必须立刻归还名额，否则池子被永久占住
    releaseGatewaySlot();
    return { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
  if (opts.onChunk) gatewayStreams.set(windowId, opts.onChunk);
  const timeoutMs = opts.timeoutMs || GATEWAY_TIMEOUT_MS;
  let hardTimer: any = null;
  try {
    const r: SubagentResult = await Promise.race<SubagentResult>([
      waitForDone(windowId, timeoutMs),
      // 第二道保险：waitForDone 自带 timer 通常先到（同为 timeoutMs），此层极少触发，
      // 仅在 waitForDone 的 resolve 路径本身卡死时兜底（finally 里强制销毁窗口）。
      // 注：网关 maxTurns=null，不会产生 partial，故这里不处理 r.partial。
      new Promise<SubagentResult>((resolve) => { hardTimer = setTimeout(() => resolve({ text: '__GATEWAY_HARD_TIMEOUT__' }), timeoutMs + 8000); }),
    ]);
    const text = r.text;
    if (text === '__SUBAGENT_TIMEOUT__' || text === '__GATEWAY_HARD_TIMEOUT__') {
      return { ok: false, error: '等待回复超时' };
    }
    return { ok: true, text };
  } catch (err: any) {
    return { ok: false, error: (err && err.message) ? err.message : String(err) };
  } finally {
    if (hardTimer) { try { clearTimeout(hardTimer); } catch (_) {} }
    gatewayStreams.delete(windowId);
    // 强制销毁：close() 在隐藏窗口上可能不生效（实测窗口堆积、最终资源耗尽）
    try {
      const ctx = windowState.getWindowContext(windowId);
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        try { ctx.win.destroy(); }
        catch (e1) { try { ctx.win.close(); } catch (e2) { /* ignore */ } }
      }
    } catch (_) { /* ignore */ }
    // 名额归还放最后：即使销毁窗口抛错也不会漏放
    releaseGatewaySlot();
  }
}
