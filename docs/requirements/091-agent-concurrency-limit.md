# 需求 091：子代理并发上限（降低同账号多路并发风控）

## 1. 核心目标

给 `runAgent` / `runAgents` 加并发闸门，限制同一 profile 同时运行的子代理窗口数，降低「同一账号同时开多路 SSE 流 + 工具循环」被平台风控识别的概率。

## 2. 问题分析与根因定位

1. **子代理复用父 profile 的 partition**（`src/app/profile.ts:151-160`）：子代理不是独立账号，是同一账号再开一个窗口，共享 cookie / localStorage / 登录态 / 浏览器指纹。平台视角看是「同一设备同时开 N 个会话」。
2. **`runAgents` 无并发上限**（`src/tools/impl/run-agent.ts:123`）：`Promise.all(jobs)` 有几个 task 就同时开几个窗口，无排队、无上限。
3. **网关已有上限，子代理没有**：`src/app/subagent.ts:275` 的 `GATEWAY_MAX_CONCURRENT = 3` 只保护网关路径，子代理路径不受约束。
4. **既存计数泄漏**：`runAgent` 里 `incRunning` 在 `_createWindow` 之前调用，若 `_createWindow` 抛错，`decRunning` 永不执行，`runningByProfile` 计数永久偏高（会影响远程消息拦截判定）。

## 3. 详细设计

> **重要修订**：初版只在子代理路径接了闸门，网关仍用文件内独立的 `gatewayActive`（上限 3），
> 两条路径各 3 个 → 实际可同时跑 6 个隐藏窗口，闸门形同虚设。现统一到同一个池子，
> 并给排队加上"用户停止即取消"能力。

- `src/app/agent-semaphore.ts`：
  - 信号量 `MAX_CONCURRENT_AGENTS = 3`，子代理与网关**共用**。
  - `acquireAgentSlot({ timeoutMs, parentWindowId })`：排队版，超时或取消时抛错。
  - `tryAcquireAgentSlot()`：非阻塞版，满额立即返回 false（网关用）。
  - `cancelQueuedByParent(parentWindowId)`：取消某父窗口下排队中的请求。
- `src/app/subagent.ts`：
  - `acquireAgentSlot(timeoutMs?)`：有空位立即占用；无空位则排队，排队超时（默认 300 秒）抛错并移出队列。
  - `releaseAgentSlot()`：直接把槽位交接给下一个等待者（不增减计数），无等待者才 `--`。
  - `makeAgentReleaser()`：返回幂等释放函数，防重复调用把计数减成负数。
  - `runAgent`：早期同步校验（依赖注入、父 profile）不占锁；之后 `await acquireAgentSlot()`，用 `try/finally` 包住整个函数体，`finally` 释放。
  - 顺手修复计数泄漏：`incRunning` 从 `_createWindow` 之前挪到之后，并用 `counted` 标记，保证 `decRunning` 与 `incRunning` 严格配对。
- `src/tools/impl/run-agent.ts`：
  - `runAgents` 的 prompt section 补充说明「超过 3 个会排队」。
- 测试 `test/app/subagent-concurrency.test.js`：
  - 3 个并发能同时进入。
  - 第 4 个排队，前 3 个未完成时不进入；释放 1 个后第 4 个进入。
  - `createWindow` 抛错时槽位正确释放（回归既存泄漏）。
  - 排队超时抛错且不泄漏槽位。
  - 重复调用释放函数不把计数减成负数。

## 4. 验证要求

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿。
