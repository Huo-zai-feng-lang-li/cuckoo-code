# 最新接续状态 (2026-10-29)

## 核心进展
- **需求 092 已落地并发布**：子代理并发闸门改为**按账号（profileId）分池**，并支持**配置化并发上限 + 启动间隔**。
- **当前版本**：v0.10.165（已 push master + tag）。

## 动机
- 旧实现 `agent-semaphore.ts` 是**全局单例计数**：账号 A 跑满 3 个会挤掉账号 B 的第 1 个（误伤）。
- 封号按账号算，不同账号应各算各的；配置值（上限/间隔）全账号共用即可。
- 并发与启动间隔应可在设置页调，不应写死。

## 关键实现（已在 v0.10.159 落地，v0.10.160~v0.10.165 修复迭代）
- `src/app/agent-semaphore.ts`（重写）：
  - 内部 `Map<profileId, { active, waiters, lastStartAt, intervalChain, intervalWaiters }>`，按账号分池；不传 profileId 走默认池 `''`。
  - `injectSemaphoreConfig(fn)` 注入配置提供者；`readConfig()` 每次 acquire 实时读。
  - 并发上限钳制 [1, 10]（`Number.isFinite` 显式判断，**不能** `Number(x) || 默认`）。
  - 启动间隔钳制 [0, 300000ms]；间隔串行化（`intervalChain` Promise 链），防并发同时启动。
  - 等间隔可取消（`intervalWaiters` 登记，取消时归还名额）。
  - 网关 `tryAcquire` 不等待间隔、不更新 `lastStartAt`。
  - `cancelQueuedByParent` 同时扫 `waiters` 和 `intervalWaiters`。
- `src/app/subagent.ts`：`acquireAgentSlot({ profileId: parentProfileId, ... })`、`makeAgentReleaser(parentProfileId)`；网关 `tryAcquireAgentSlot(parentCtx.profileId)`。
- `src/app/global-settings.ts`：新增 `maxConcurrentAgents`(1~10, 默认 3) / `agentStartIntervalMin` / `agentStartIntervalMax`（秒，默认 0）；`normalize` 显式返回三字段。
- `src/app/entry.ts`：`injectSemaphoreConfig(() => globalSettings.readAgentSettings() 映射)`。
- 设置页：`src/ui/shell/partials/pages/settings.html` 新增「子代理」卡片；`src/ui/shell/scripts/pages/settings.ts` SET_FIELDS + collectSettings；`src/overlay/panels/settings.ts` SettingsData / getSettingsData / applySettingsData / resetSettingsData 四处补齐。
- 需求档案：`docs/requirements/092-subagent-concurrency-config.md`。

## 已修的 bug（v0.10.159→v0.10.165 迭代）
1. 并发时间隔完全失效（intervalChain 串行化修）
2. 等间隔期间点停止取消不掉 + 名额泄漏（intervalWaiters 修）
3. 网关调用重置子代理间隔计时器（tryAcquire 删 lastStartAt 更新）
4. 并发上限配 0 被误判为默认 3（Number.isFinite）
5. 启动间隔无上限（钳制 300s）
6. applySettingsData 校验顺序错误（提到 setItem 之前，v0.10.161）
7. resetSettingsData 漏清 3 个子代理 key（KEYS 补齐，v0.10.162）
8. `.gitignore` 缺失（v0.10.164 补规则，v0.10.165 对齐版本号）

## 验证
- `npm run typecheck` ✅
- `npm test` ✅（1298 用例全过 + 新增 resetSettingsData 回归测试）
- `npm run lint` ✅（仅既有 warning）
- `npm run compile` ✅
- **未做真机验证**：改了运行时行为（并发池 / 设置页 UI），需 `npm start` 真机确认（清单见下）。

## 真机验证清单（待做）
- A. 设置页 UI：并发填 0/11 应被拦；间隔 max<min 应自动修正
- B. 间隔真生效：3 任务 150ms 间隔 → 分别 ~0/~150/~300ms 启动
- C. 等间隔时点停止：提示「已被用户取消」，不偷偷启动
- D. 按账号隔离：账号 A 跑满不影响账号 B（**本次核心修复**）
- E. 网关不被间隔卡住：立即返回
- F. 间隔上限钳制：填 999999 → 回显 300
- G. 设置校验失败不留污染：并发填 0 后，发送延迟区间不被污染
- H. 恢复默认彻底：3 个子代理 key 返回 `null`

## 待办 / 遗留
- **v0.10.164 tag 违规**：含数字 4，但已推送 origin（指向 `0b9daf3`，只含 .gitignore 改动）。未删除，需用户决定是否 `git push origin :refs/tags/v0.10.164`。
- 真机验证（见上，A~H）。
- 三项设置全局化（字号 / 自动压缩 / 活动栏图标）是**另一个需求**，本次未做。
- `goalMaxIterations` 在设置页与纯净模式 harness 之间不同步（既有隐患，本次未修）。

## 教训（给下一次的自己）
- **把「计划要做」当「已经做完」写进总结是本会话反复犯的错**（3 次：v0.10.160 说改了 settings.ts 实际没改、v0.10.163 说加了 .gitignore 实际没加、v0.10.164 edit 失败但 commit/tag 照跑）。改完必须 `grep` / `read` 二次确认再写总结。
- 用 `type xxx > test/rs.txt` 之类重定向生成调试文件后**必须清理**，别让 `git add -A` 一把梭带进提交。已在 `.gitignore` 加防护。
