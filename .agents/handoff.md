# 最新接续状态 (2026-10-29)

## 核心进展
- **需求 092 已落地并提交**：子代理并发闸门改为**按账号（profileId）分池**，并支持**配置化并发上限 + 启动间隔**。

## 动机
- 旧实现 `agent-semaphore.ts` 是**全局单例计数**：账号 A 跑满 3 个会挤掉账号 B 的第 1 个（误伤）。
- 封号按账号算，不同账号应各算各的；配置值（上限/间隔）全账号共用即可。
- 并发与启动间隔应可在设置页调，不应写死。

## 关键实现
- `src/app/agent-semaphore.ts`（重写）：
  - 内部 `Map<profileId, { active, waiters, lastStartAt }>`，按账号分池；不传 profileId 走默认池 `''`（兼容旧调用）。
  - `injectSemaphoreConfig(fn)` 注入配置提供者；`readConfig()` 每次 acquire 实时读，改配置不打断已跑任务。
  - 并发上限钳制在 [1, 10]（**注意**：不能用 `Number(x) || 默认`，0 会被 `||` 误判为假值，已用 `Number.isFinite` 显式处理）。
  - 启动间隔：拿到名额后按 `[min,max]` 随机 sleep；**间隔为 0 时零等待**（默认，行为不变）；**网关 tryAcquire 不等待间隔**（保持快速失败）。
  - `cancelQueuedByParent` 遍历所有池；`getActiveCount()`/`getQueueLength()` 无参=所有池总和，传 profileId 只看该池。
- `src/app/subagent.ts`：`acquireAgentSlot({ profileId: parentProfileId, ... })`、`makeAgentReleaser(parentProfileId)`；网关 `tryAcquireAgentSlot(parentCtx.profileId)`。
- `src/app/global-settings.ts`：新增 `maxConcurrentAgents`(1~10, 默认 3) / `agentStartIntervalMin` / `agentStartIntervalMax`（秒，默认 0）；`normalize` 显式返回三字段。
- `src/app/entry.ts`：`injectSemaphoreConfig(() => globalSettings.readAgentSettings() 映射)`。
- 设置页：`src/ui/shell/partials/pages/settings.html` 新增「子代理」卡片；`src/ui/shell/scripts/pages/settings.ts` SET_FIELDS + collectSettings；`src/overlay/panels/settings.ts` SettingsData / getSettingsData / applySettingsData 三处补齐。
- 需求档案：`docs/requirements/092-subagent-concurrency-config.md`。

## 验证
- `npm run typecheck` ✅ / `npm test` ✅（曾修复 2 例失败：readConfig 的 0 误判、无参统计契约断言）/ `npm run lint` ✅（仅既有 warning）/ `npm run compile` ✅。
- **未做真机验证**：改了运行时行为（并发池 / 设置页 UI），需 `npm start` 真机确认。

## 待办
- 真机验证（见下）。
- 三项设置全局化（字号 / 自动压缩 / 活动栏图标）是**另一个需求**，本次未做。
- `goalMaxIterations` 在设置页与纯净模式 harness 之间不同步（既有隐患，本次未修）。
