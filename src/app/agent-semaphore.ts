/**
 * 子代理并发闸门（信号量）
 *
 * 为什么需要：子代理与网关查询都复用父 profile 的 partition（同一登录态 / 浏览器指纹），
 * 每路都开 SSE + 工具循环。同账号多路并发是明显的机器人特征。
 *
 * 关键：**两条路径共享同一个池子**。
 * 早期实现里子代理用本模块、网关用 subagent.ts 内的独立 gatewayActive 计数，
 * 两边各 3 个名额 → 实际可同时跑 6 个隐藏窗口，闸门形同虚设。
 *
 * 设计：纯计数信号量，无外部依赖（便于单测）。
 *  - acquireAgentSlot：排队版（子代理用），超时或用户取消时抛错
 *  - tryAcquireAgentSlot：非阻塞版（网关用），满了立即返回 false，保持"快速失败"语义
 */

/** 同时运行的子代理 / 网关窗口总上限 */
export const MAX_CONCURRENT_AGENTS = 3;

/** 排队最长等待时间：默认 5 分钟（单个子代理任务正常在 10 分钟内完成） */
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000;

let active = 0;

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: any;
  /** 发起该排队的父窗口 id（用于用户点停止时取消排队） */
  parentWindowId: number | null;
}
const waiters: Waiter[] = [];

/** 当前占用数（供测试与诊断） */
export function getActiveCount(): number { return active; }

/** 当前排队数（供测试与诊断） */
export function getQueueLength(): number { return waiters.length; }

/** 从队列中摘除某个等待者（超时/取消共用），返回是否摘到 */
function detach(w: Waiter): boolean {
  const i = waiters.indexOf(w);
  if (i < 0) return false;
  waiters.splice(i, 1);
  if (w.timer) { try { clearTimeout(w.timer); } catch (_) { /* ignore */ } }
  return true;
}

/**
 * 非阻塞占用：有空位立即占用并返回 true，否则返回 false（不排队）。
 * 网关路径用这个——插件请求应快速失败，不该长时间挂起。
 */
export function tryAcquireAgentSlot(): boolean {
  if (active >= MAX_CONCURRENT_AGENTS) return false;
  active++;
  return true;
}

export interface AcquireOptions {
  /** 排队超时（毫秒），默认 5 分钟 */
  timeoutMs?: number;
  /** 父窗口 id：用户点停止时可取消该窗口下所有排队者 */
  parentWindowId?: number;
}

/**
 * 阻塞占用：有空位立即占用；无空位则排队。
 * 超时或排队期间被取消时 reject（调用方必须 try/finally 释放已获得的槽位）。
 */
export function acquireAgentSlot(opts: AcquireOptions = {}): Promise<void> {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_QUEUE_TIMEOUT_MS;
  if (active < MAX_CONCURRENT_AGENTS) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = {
      resolve,
      reject,
      timer: null,
      parentWindowId: typeof opts.parentWindowId === 'number' ? opts.parentWindowId : null,
    };
    w.timer = setTimeout(() => {
      if (!detach(w)) return; // 已被取消/已交接
      reject(new Error('子代理排队超时（当前 ' + active + '/' + MAX_CONCURRENT_AGENTS + ' 个在跑）'));
    }, timeoutMs);
    waiters.push(w);
  });
}

/**
 * 取消某父窗口下所有排队中的请求（用户点停止时调用）。
 * 只取消**排队中**的，已在跑的不受影响（那些由调用方销毁窗口处理）。
 * @returns 取消数量
 */
export function cancelQueuedByParent(parentWindowId: number): number {
  if (typeof parentWindowId !== 'number') return 0;
  const victims = waiters.filter((w) => w.parentWindowId === parentWindowId);
  for (const w of victims) {
    if (!detach(w)) continue;
    w.reject(new Error('子代理已被用户取消'));
  }
  return victims.length;
}

/**
 * 释放一个槽位。
 * 有等待者时直接把名额**交接**给队首（active 不变），否则 active--。
 * 这样既保证公平（先来先得），又不会出现「先减再加」被插队的窗口。
 */
export function releaseAgentSlot(): void {
  const next = waiters.shift();
  if (next) {
    if (next.timer) { try { clearTimeout(next.timer); } catch (_) { /* ignore */ } }
    next.resolve(); // active 不变：名额直接转交
    return;
  }
  if (active > 0) active--;
}

/**
 * 生成幂等释放器。用于 try/finally —— 即使调用方重复调用，
 * 也不会把计数减成负数（曾有过 decRunning 与 incRunning 不配对的计数泄漏）。
 */
export function makeAgentReleaser(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAgentSlot();
  };
}

/** 测试用：重置内部状态 */
export function _resetForTest(): void {
  active = 0;
  for (const w of waiters) { if (w.timer) { try { clearTimeout(w.timer); } catch (_) { /* ignore */ } } }
  waiters.length = 0;
}
