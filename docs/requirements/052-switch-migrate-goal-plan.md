---
id: 052
type: feature
title: 窗口切换迁移携带目标/计划 + 启动提示
status: done
branch: feat/052-switch-migrate-goal-plan
created: 2026-10-15
updated: 2026-10-15
---

## 背景

窗口组（021）限流自动切换 / 手动转移对话时，会把源窗口的 harness 状态迁移到目标窗口。
当前迁移**只带了两项**（\`exportHarnessState\` 返回 \`{ history, sendQueue }\`）：

- 对话历史 history（含 system / tool / plan 快照）
- 待发队列 sendQueue

**缺失**：目标 goal、计划模式状态 planState、计划步骤 planTodos。
这三个都按会话隔离（存 localStorage 的 \`<key>:<sid>\`）。目标窗口是**新分享会话**（新 sid），
读的是新 key → 全空。若源窗口正在 \`/goal\` 或 \`/plan\` 自动推进，切换后**自动推进直接断**，
且源窗口随后被关闭（closeSource=true），目标/计划上下文彻底丢失、无提示。

## 目标

窗口切换（限流自动 + 手动转移，共用同一链路）时，把源窗口的**目标 + 计划**一并携带到目标窗口，
实现"切换后自动推进不断"。另：窗口页加提示，说明"不勾选默认打开 = 启动打开最后活跃窗口"。

### 范围

- ✅ 迁移导出扩展：goal + planState + planTodos
- ✅ 迁移导入应用：目标窗口 session 确定后恢复这三项
- ✅ 窗口页提示文案（不勾选默认打开的行为说明）
- ❌ 不带：输入框草稿、待发附件（属跨对话临时态，clearTransientState 本应清）

## 方案

### 数据层（harness.html）

\`exportHarnessState()\` 返回值扩展：

\`\`\`js
return {
  history: history,
  sendQueue: sendQueue,
  goal: goal,                                   // 目标对象或 null
  planState: planState,                         // 计划模式闸门状态或 null
  planTodos: planBySession[currentSessionId] || []  // 当前会话的计划步骤
};
\`\`\`

\`applyImportState(data)\` / \`onSessionChanged\` 应用端：

- goal：\`goal = data.goal; saveGoalState(); renderGoalBar();\`
- planState：\`planState = data.planState; savePlanState(); renderPlanBar();\`
- planTodos：\`planBySession[currentSessionId] = data.planTodos || [];\` 并 renderPlan

关键：**必须在 currentSessionId 确定后应用**（与现有 \`_pendingImportState\` 暂存机制一致），
否则会存到空 key 被随后 loadGoalState/loadPlanState 覆盖。

### UI（窗口页）

\`src/ui/shell/scripts/pages/windows.ts\` + 对应 partial：在窗口列表顶部（或"默认打开"复选框附近）
加一行说明："不勾选任何『默认打开』时，启动会打开最后活跃的窗口"。

## 验收标准

- [ ] 源窗口有 goal 时切换 → 目标窗口目标条恢复（文本/轮数/暂停态一致），自动推进继续
- [ ] 源窗口 plan 处于 exec 阶段时切换 → 目标窗口计划面板恢复，闸门状态一致，续跑正常
- [ ] 源窗口 planTodos 非空时切换 → 目标窗口计划步骤逐条恢复
- [ ] 无 goal / 无 plan 时切换 → 目标窗口无残留（不被 null 覆盖成脏态）
- [ ] 窗口页显示"不勾选默认打开=打开最后活跃窗口"提示
- [ ] typecheck / test / lint / compile 全绿
- [ ] 真机验证：限流自动切换 + 手动转移各跑一次

## 遗留

- 草稿/附件不迁移（如需，另开需求）
- lastUrl 在限流关源窗口时可能记成分享中间态（未在本需求处理，先记录）
