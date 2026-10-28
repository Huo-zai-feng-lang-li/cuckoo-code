/**
 * 子代理并发闸门（信号量）—— 按账号分池 + 可配并发 + 启动间隔
 *
 * 为什么需要：
 *  1. 子代理与网关查询都复用父 profile 的 partition（同一登录态 / 浏览器指纹），
 *     每路都开 SSE + 工具循环。同账号多路并发是明显的机器人特征。
 *  2. 封号按**账号**算：账号 A 跑满 3 个不该挤掉账号 B 的第 1 个。
 *     早期实现是全局单例计数，A 满额时 B 直接报"并发已达上限"（误伤）。
 *     现改为**按 profileId 分池**：配置值全账号共用，计数各算各的。
 *  3. 并发上限与启动间隔应可配（防封强度因账号而异）。
 *     配置由上层（entry.ts）注入，本模块不依赖 settings（保持可单测）。
 *
 * 关键：**子代理与网关共享同一个池**（同一 profileId）。
 * 早期实现里子代理用本模块、网关用独立计数，两条路径各 3 名额 → 实际 6 个窗口。
 *
 * 设计：纯计数信号量 + 可选启动间隔，无外部依赖（便于单测）。
 *  - acquireAgentSlot：排队版（子代理用），超时或用户取消时抛错
 *  - tryAcquireAgentSlot：非阻塞版（网关用），满了立即返回 false，保持"快速失败"语义
 *  - 启动间隔：只作用于子代理（acquireAgentSlot），网关（tryAcquire）不等待
 */

/** 默认并发上限（无配置注入 / 未指定 profile 时使用） */
export const MAX_CONCURRENT_AGENTS = 3;
/** 并发上限硬上界（配置超限时压到此处，防用户把自己弄成裸奔） */
const MAX_CONCURRENT_HARD_LIMIT = 10;

/** 排队最长等待时间：默认 5 分钟（单个子代理任务正常在 10 分钟内完成） */
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000;

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: any;
  /** 发起该排队的父窗口 id（用于用户点停止时取消排队） */
  parentWindowId: number | null;
}

interface Pool {
  active: number;
  waiters: Waiter[];
  /** 上一次「真正启动」的时间戳（ms）；用于启动间隔计算 */
  lastStartAt: number;
}

/** 默认池 key（未指定 profileId 时使用，兼容旧调用与测试） */
const DEFAULT_POOL_KEY = '';

const pools = new Map<string, Pool>();

function getPool(profileId?: string): Pool {
  const key = typeof profileId === 'string' ? profileId : DEFAULT_POOL_KEY;
  let p = pools.get(key);
  if (!p) {
    p = { active: 0, waiters: [], lastStartAt: 0 };
    pools.set(key, p);
  }
  return p;
}

/** 遍历所有池（用于全局统计与取消） */
function allPools(): Pool[] {
  return Array.from(pools.values());
}

// ================= 配置注入 =================

export interface SemaphoreConfig {
  /** 并发上限（1~10）；越界会被压到合法范围 */
  maxConcurrent: number;
  /** 启动间隔最小值（毫秒）；<=0 表示无间隔 */
  startIntervalMinMs: number;
  /** 启动间隔最大值（毫秒）；<min 时按 min 处理 */
  startIntervalMaxMs: number;
}

const DEFAULT_CONFIG: SemaphoreConfig = {
  maxConcurrent: MAX_CONCURRENT_AGENTS,
  startIntervalMinMs: 0,
  startIntervalMaxMs: 0,
};

let _configProvider: (() => SemaphoreConfig) | null = null;

/** 注入配置提供者（由 entry.ts 注入 global-settings 读取函数；测试可注入固定值） */
export function injectSemaphoreConfig(fn: (() => SemaphoreConfig) | null): void {
  _configProvider = fn;
}

/** 读取当前配置（无注入时返回默认） */
function readConfig(): SemaphoreConfig {
  let c: SemaphoreConfig;
  try {
    c = _configProvider ? _configProvider() : DEFAULT_CONFIG;
  } catch (_) {
    c = DEFAULT_CONFIG;
  }
  const max = Math.min(
    MAX_CONCURRENT_HARD_LIMIT,
    Math.max(1, Math.floor(Number(c.maxConcurrent) || MAX_CONCURRENT_AGENTS))
  );
  let minMs = Math.max(0, Number(c.startIntervalMinMs) || 0);
  let maxMs = Math.max(0, Number(c.startIntervalMaxMs) || 0);
  if (maxMs < minMs) maxMs = minMs;
  return { maxConcurrent: max, startIntervalMinMs: minMs, startIntervalMaxMs: maxMs };
}

/** 按配置随机取一个启动间隔（ms）；区间为 [min, max]，无间隔时返回 0 */
function randomInterval(cfg: SemaphoreConfig): number {
  if (cfg.startIntervalMaxMs <= 0) return 0;
  const span = cfg.startIntervalMaxMs - cfg.startIntervalMinMs;
  if (span <= 0) return cfg.startIntervalMinMs;
  return cfg.startIntervalMinMs + Math.floor(Math.random() * (span + 1));
}

// ================= 诊断 =================

/**
 * 当前占用数。
 * @param profileId 不传则返回所有池的总和（兼容旧测试）
 */
export function getActiveCount(profileId?: string): number {
  if (typeof profileId === 'string') return getPool(profileId).active;
  return allPools().reduce((s, p) => s + p.active, 0);
}

/**
 * 当前排队数。
 * @param profileId 不传则返回所有池的总和（兼容旧测试）
 */
export function getQueueLength(profileId?: string): number {
  if (typeof profileId === 'string') return getPool(profileId).waiters.length;
  return allPools().reduce((s, p) => s + p.waiters.length, 0);
}

// ================= 内部工具 =================

/** 从队列中摘除某个等待者（超时/取消共用），返回是否摘到 */
function detach(pool: Pool, w: Waiter): boolean {
  const i = pool.waiters.indexOf(w);
  if (i < 0) return false;
  pool.waiters.splice(i, 1);
  if (w.timer) { try { clearTimeout(w.timer); } catch (_) { /* ignore */ } }
  return true;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// ================= 占用 / 释放 =================

/**
 * 非阻塞占用：有空位立即占用并返回 true，否则返回 false（不排队）。
 * 网关路径用这个——插件请求应快速失败，不该长时间挂起。
 * 注意：网关**不等待启动间隔**（保持快速失败语义），只受并发上限约束。
 */
export function tryAcquireAgentSlot(profileId?: string): boolean {
  const pool = getPool(profileId);
  const cfg = readConfig();
  if (pool.active >= cfg.maxConcurrent) return false;
  pool.active++;
  pool.lastStartAt = Date.now();
  return true;
}

export interface AcquireOptions {
  /** 所属账号（profileId）；不传用默认池 */
  profileId?: string;
  /** 排队超时（毫秒），默认 5 分钟 */
  timeoutMs?: number;
  /** 父窗口 id：用户点停止时可取消该窗口下所有排队者 */
  parentWindowId?: number;
}

/**
 * 阻塞占用：有空位立即占用；无空位则排队。
 * 超时或排队期间被取消时 reject（调用方必须 try/finally 释放已获得的槽位）。
 *
 * 启动间隔：拿到名额后，若配置了间隔，会等待「距上次启动的剩余时间」再返回。
 * 间隔为 0 时零等待（默认，与原行为一致）。
 */
export async function acquireAgentSlot(opts: AcquireOptions = {}): Promise<void> {
  const cfg = readConfig();
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_QUEUE_TIMEOUT_MS;
  const profileKey = typeof opts.profileId === 'string' ? opts.profileId : undefined;
  const pool = getPool(profileKey);

  // ---- 第一步：拿到名额（有空位立即，满了排队） ----
  if (pool.active < cfg.maxConcurrent) {
    pool.active++;
  } else {
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        timer: null,
        parentWindowId: typeof opts.parentWindowId === 'number' ? opts.parentWindowId : null,
      };
      w.timer = setTimeout(() => {
        if (!detach(pool, w)) return;
        reject(new Error('子代理排队超时（当前 ' + pool.active + '/' + cfg.maxConcurrent + ' 个在跑）'));
      }, timeoutMs);
      pool.waiters.push(w);
    });
    // 名额由 releaseAgentSlot 交接过来，active 已就位
  }

  // ---- 第二步：启动间隔（默认 0 → 直接返回） ----
  const interval = randomInterval(cfg);
  if (interval > 0) {
    const elapsed = Date.now() - pool.lastStartAt;
    const wait = interval - elapsed;
    if (wait > 0) await sleep(wait);
  }
  pool.lastStartAt = Date.now();
}

/**
 * 取消某父窗口下所有排队中的请求（用户点停止时调用）。
 * 只取消**排队中**的，已在跑的不受影响（那些由调用方销毁窗口处理）。
 * @returns 取消数量
 */
export function cancelQueuedByParent(parentWindowId: number): number {
  if (typeof parentWindowId !== 'number') return 0;
  let total = 0;
  for (const pool of allPools()) {
    const victims = pool.waiters.filter((w) => w.parentWindowId === parentWindowId);
    for (const w of victims) {
      if (!detach(pool, w)) continue;
      w.reject(new Error('子代理已被用户取消'));
      total++;
    }
  }
  return total;
}

/**
 * 释放一个槽位。
 * 有等待者时直接把名额**交接**给队首（active 不变），否则 active--。
 * 这样既保证公平（先来先得），又不会出现「先减再加」被插队的窗口。
 */
export function releaseAgentSlot(profileId?: string): void {
  const pool = getPool(profileId);
  const next = pool.waiters.shift();
  if (next) {
    if (next.timer) { try { clearTimeout(next.timer); } catch (_) { /* ignore */ } }
    next.resolve(); // active 不变：名额直接转交
    return;
  }
  if (pool.active > 0) pool.active--;
}

/**
 * 生成幂等释放器。用于 try/finally —— 即使调用方重复调用，
 * 也不会把计数减成负数（曾有过 decRunning 与 incRunning 不配对的计数泄漏）。
 */
export function makeAgentReleaser(profileId?: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAgentSlot(profileId);
  };
}

/** 测试用：重置内部状态 */
export function _resetForTest(): void {
  for (const pool of allPools()) {
    for (const w of pool.waiters) { if (w.timer) { try { clearTimeout(w.timer); } catch (_) { /* ignore */ } } }
  }
  pools.clear();
  _configProvider = null;
}
