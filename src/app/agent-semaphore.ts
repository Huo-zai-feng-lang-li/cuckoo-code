/**
 * 子代理并发闸门（信号量）
 *
 * 为什么需要：子代理复用父 profile 的 partition（同一登录态 / 浏览器指纹），
 * 每个子代理都开一路 SSE + 工具循环。同账号多路并发是明显的机器人特征，
 * 而 `runAgents` 用 `Promise.all` 并发启动，此前没有任何上限。
 * 网关路径已有 GATEWAY_MAX_CONCURRENT=3，本模块把同一约束补给子代理路径。
 *
 * 设计：纯计数信号量，无外部依赖（便于单测）。排队超时抛错，绝不静默降级。
 */

/** 同时运行的子代理上限（与网关保持一致） */
export const MAX_CONCURRENT_AGENTS = 3;

/** 排队最长等待时间：默认 5 分钟（单个子代理任务正常在 10 分钟内完成） */
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000;

let active = 0;

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: any;
}
const waiters: Waiter[] = [];

/** 当前占用数（供测试与诊断） */
export function getActiveCount(): number { return active; }

/** 当前排队数（供测试与诊断） */
export function getQueueLength(): number { return waiters.length; }

/**
 * 占用一个槽位。有空位立即占用；无空位则排队，超时抛错。
 * 超时必须把自己从队列里摘掉，否则会造成排队位泄漏。
 */
export function acquireAgentSlot(timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS): Promise<void> {
  if (active < MAX_CONCURRENT_AGENTS) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { resolve, reject, timer: null };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('子代理排队超时（当前 ' + active + '/' + MAX_CONCURRENT_AGENTS + ' 个在跑）'));
    }, timeoutMs);
    waiters.push(w);
  });
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
 * 也不会把计数减成负数（曾有过 `decRunning` 与 `incRunning` 不配对的计数泄漏）。
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
