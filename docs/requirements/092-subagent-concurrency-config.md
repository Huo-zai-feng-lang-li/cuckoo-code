# 需求 092：子代理并发与启动间隔可配置（按账号隔离）

## 1. 核心目标

1. 子代理并发池**按账号（profile）隔离**：账号 A 跑满不再挤掉账号 B（修复误伤）。
2. 并发上限、启动间隔**可配置**（设置页），全账号共用一份配置。
3. 默认值保持不变（并发 3，间隔 0），零行为回归。

## 2. 问题分析与根因定位

1. `src/app/agent-semaphore.ts:22` 的 `let active = 0` 是模块级单例，全进程共用。
2. `src/app/subagent.ts:207` 调用 `acquireAgentSlot({ parentWindowId })` 只传父窗口 id，没传 profileId。
3. 结果：账号 A 跑满 3 个子代理时，账号 B 的 `runGatewayQuery` 直接返回「并发已达上限」，明明 B 一个都没跑。
4. 封号按账号算，不同账号互不影响，应各算各的。

## 3. 详细设计

### 3.1 池化（按账号）

- `agent-semaphore.ts` 内部 `active`/`waiters` 换成 `Map<profileId, Pool>`。
- 每个 Pool：`{ active, waiters, lastStartAt, intervalLock }`。
- `acquireAgentSlot({ profileId?, parentWindowId?, timeoutMs? })`：不传 profileId 用默认池 `''`（兼容旧调用/测试）。
- `tryAcquireAgentSlot(profileId?)` / `releaseAgentSlot(profileId?)` / `makeAgentReleaser(profileId?)`。
- `cancelQueuedByParent(parentWindowId)` 遍历所有池。
- `getActiveCount(profileId?)` / `getQueueLength(profileId?)`：无参数返回所有池总和。

### 3.2 可配并发与间隔

- `global-settings.ts` 新增 3 字段：
  - `maxConcurrentAgents`（1~10，默认 3）
  - `agentStartIntervalMin`（秒，默认 0）
  - `agentStartIntervalMax`（秒，默认 0）
- `agent-semaphore.ts` 加 `injectSemaphoreConfig(fn)` 注入配置提供者（默认返回内置默认值）。
- 每次 `acquireAgentSlot` 时读配置；改配置后新 acquire 用新值，已在跑的不打断。

### 3.3 启动间隔

- 间隔 = 两次「启动子代理窗口」之间的最小时间差，随机取 `[min, max]`。
- 间隔等待在「拿到名额后」执行，串行化（每池一把锁）。
- **间隔为 0（默认）时完全跳过**，零开销、零行为变更。
- 间隔只影响新子代理启动，不打断正在跑的子代理。
- 网关路径 `tryAcquireAgentSlot` **不等待间隔**（保持快速失败语义）。

### 3.4 注入

- `entry.ts` 在启动时注入配置提供者：
  ```ts
  injectSemaphoreConfig(() => {
    const s = globalSettings.readAgentSettings();
    return {
      maxConcurrent: s.maxConcurrentAgents,
      startIntervalMinMs: s.agentStartIntervalMin * 1000,
      startIntervalMaxMs: s.agentStartIntervalMax * 1000,
    };
  });
  ```

### 3.5 设置页

- 新增「子代理」卡片：
  - 并发上限（1~10）
  - 启动间隔区间（秒，0 = 不等待）

## 4. 验证要求

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿。
- 新增测试：
  - 不同 profileId 独立计数。
  - 配置注入后上限生效。
  - 间隔 > 0 时 acquire 耗时增加。
  - 间隔 = 0 时零延迟（回归）。
- 真机：设置页改并发/间隔后，新子代理按新值执行；账号 A 跑满不影响账号 B。
