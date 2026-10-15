# 最新接续状态 (2026-10-15 21:30)

## 核心进展
- **052 窗口切换迁移携带目标/计划 + 窗口页默认打开提示** 已闭环并发版 v0.8.80（提交 31cdffa，合并 10b6a70，tag v0.8.80 已推送，CI 已触发）。核心改动在 `src/ui/harness.html`：窗口组限流切换 / 手动转移对话时，harness 状态迁移从「仅 history + sendQueue」扩展为携带 **goal / goalNoProgress / planState / planTodos**，两条导入路径（`onSessionChanged` 暂存路径 + `applyImportState` 直接路径）均恢复，时序放在 `loadGoalState/loadPlanState` 之后覆盖。

## 核心动机与背景 (Motivation & Background)
- **问题**：窗口组（021）限流自动切换 / 手动转移时，源窗口 harness 状态只迁 history + sendQueue。goal / planState / planTodos 是**按会话隔离**态（存 localStorage 的 `<key>:<sid>`），目标窗口是新分享会话（新 sid），读的是新 key → 全空。源窗口若正跑 `/goal` 或 `/plan` 自动推进，切换后自动推进直接断，且源窗口随后被关（closeSource=true），上下文彻底丢失、无提示。
- **附加需求**：窗口页加提示，消除「启动打开哪个窗口」歧义（用户明确：不勾选默认打开 = 启动打开最后活跃窗口，无需改启动逻辑）。

## 关键设计与实现 (Implementation & Decisions)
- **迁移导出**（`exportHarnessState`）：返回值扩展为 `{ history, sendQueue, goal, goalNoProgress, planState, planTodos }`。`goalNoProgress` 是独立变量（不在 goal 对象内），必须显式带。
- **迁移导入**：
  - `onSessionChanged(sid)`：捕获 `_impGoal/_impPlanState/_impPlanTodos/_impGoalNoProgress`，在 `loadGoalState/loadPlanState` 之后覆盖并 `saveXxxState()`，再 `renderGoalBar/renderPlan/renderPlanBar`。
  - `applyImportState(data)`：会话已确定时的直接导入路径，同样恢复三项。
  - 两条路径都补 `planState.phase` 校验（对齐 `loadPlanState`：缺 phase 视为无效）。
- **resetConversation**：补 `cur = null`（流式气泡适配变量，原先漏清，测试靠源码窗口溢出"假通过"）。
- **窗口页提示**（`src/ui/shell/scripts/pages/windows.ts` + `partials/pages/windows.html` + `styles/pages.css`）：有勾选 → 「勾选的窗口会在启动时自动打开。」；无勾选 → 「未勾选任何『默认打开』时，启动会打开最后活跃的窗口。」；空列表清空提示。
- **未做**：输入框草稿 / 待发附件不迁移（用户确认属临时态）。

## 待办事项 (Next Steps)
- [ ] **watch v0.8.80 CI**：GitHub Actions（.github/workflows/release.yml）应自动构建 Win+Mac 并创建 Release，确认成功。
- [ ] **（遗留，低优先）lastUrl 脏记录**：限流关源窗口时可能记成分享中间态 URL，导致下次打开落在分享页。建议另开需求。
- [ ] **（可选）052 端到端真机验证**：本次只验证了 UI 层 + 代码路径，未跑完整「两账号触发限流 → 切换 → 目标窗口 goal/plan 续跑」链路（需两个真实账号）。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 主要文件:
  - `src/ui/harness.html`：迁移导出/导入（`exportHarnessState` 约 3642 行、`onSessionChanged` 约 1378 行、`applyImportState` 约 3666 行）、`resetConversation`
  - `src/ui/shell/scripts/pages/windows.ts`：`renderWindowList` 提示逻辑（`win-list-hint`）
  - `src/ui/shell/partials/pages/windows.html` + `src/ui/shell/styles/pages.css`：提示元素与 `.ck-win-hint` 样式
  - `docs/requirements/052-switch-migrate-goal-plan.md`：需求档案
  - 关联：`src/app/entry.ts`（`runSwitchForGroup` 约 967 行，切换编排）、`src/app/ipc/window-groups.ts`（`requestHarnessExport`/`stageHarnessImport` 暂存机制）
- 验证状态：typecheck / compile / test(978 用例) / lint(0 error) 全绿；窗口页提示真机 CDP 验证两分支正确。
