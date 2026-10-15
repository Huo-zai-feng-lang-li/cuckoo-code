---
id: 066
type: fix
title: 子代理审计：完成通知隔离 + tools 白名单生效 + 通知精确化
status: done
branch: fix/066-subagent-audit
created: 2026-10-16
updated: 2026-10-16
---

## 背景

用户审计子代理（项目级 10 + 插件专家包 5），发现：

### 🔴 1. 子代理完成弹系统通知
`observer.ts:254` 在"普通文本回复=任务完成"分支无条件调 `showAiNotification()`；
`observer.ts` 是所有窗口共用（含子代理窗口）→ 子代理每轮纯文本回复都触发通知。
用户诉求：**只有父代理/主对话真正完成才通知，子代理是内部过程不通知**。

### 🔴 2. tools 字段完全失效
子代理 frontmatter 的 `tools:` 声明（如 code-reviewer 的 `read, readLines, glob, grep`）
被 scanner 解析、存入 AgentMeta、传入 subagentConfig，但**全链路无任何消费**。
→ "只读"子代理实际能 edit/write/bash，专家约束形同虚设。

### 🟡 3. 通知文案 + flashFrame
- 通知固定文案 "{窗口名} - AI任务已完成"，子代理触发时显示"子代理: xxx"，易困惑。
- `renderer.ts:89` 对隐藏的子代理窗口也 `flashFrame(true)`。

## 目标

1. 子代理完成**不弹通知、不 flashFrame**；只有主窗口（非子代理）真正完成才通知。
2. 子代理的 `tools` 白名单**真正生效**（在系统提示里明确约束 + 记录）。
3. 通知文案精确（能区分"哪类完成"）。

## 方案

### A. 通知隔离（改 renderer.ts + observer.ts + bridge）
- `renderer.ts` 的 `show-ai-notification` 处理里：若 `ctx.isSubagent` → 直接返回 skipped（不通知、不 flash）。
- 兜底：observer 侧可先判窗口是否子代理再决定是否调用（双保险）。

### B. tools 白名单生效（bridge/subagent.ts）
- 子代理是独立 AI 对话，机制层无法"物理"禁用工具（工具由沙箱 bootstrap 注入）。
- 可行做法：在子代理系统提示里**显式声明工具白名单**：
  "你只能使用以下工具：read, readLines, glob, grep。其他工具（edit/write/bash 等）一律不可用。"
- 在 `buildSubagentPrompt` 里根据 `cfg.tools` 拼入该约束。

### C. 通知文案 + flashFrame
- 通知标题区分：主窗口完成 = "{窗口名} 已完成"；body 可带助手名（若可获取）。
- flashFrame 仅对非子代理窗口调用。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核（重点：对 Harness 零影响）
- 真机：子代理完成不弹通知；主对话完成正常弹；code-reviewer 不再乱改文件

## 风险

- 通知隔离改 `renderer.ts`——只"跳过子代理"，不影响主窗口/Harness 的正常通知。
- tools 白名单是"提示词约束"而非机制强制——子代理仍可能越界。属已知限制（机制层无法硬禁），但比完全不声明好得多。

## 子代理机制审计结论（主代理核查）

| 项 | 结论 |
|---|---|
| 通知隔离 | ✅ 正确。`renderer.ts` 判 `ctx.isSubagent` 在取 win 之前 |
| tools 白名单 | ✅ 链路完整（agent.tools → entry.ts:834 → subagent.ts:198 → cfg.tools → 提示词） |
| 超时清理 | ✅ `waitForDone` 超时 resolve + finally 里 destroy 窗口，无泄漏 |
| 资源清理 | ✅ 完成/超时/取消/异常四路径都走 finally → destroy |
| 防递归 | ✅ `_isSubagentWindow` 判定 |
| **并发上限** | ⚠️ `runAgents` 用 `Promise.all` 无并发上限（N 任务 → N 隐藏窗口）。本次不改（属增强，引入排队复杂度），记入遗留 |

## 子代理现状（回答"要不要新建"）

实际 13 个，来自两处：
- **项目级** `.cuckoo/agents/`（10）：api-mapper / arch-guard / build-doctor / code-reviewer / doc-writer / explore / hook-surgeon / req-writer / test-runner / tool-smith
- **插件级** `~/.cuckoo/plugins/cuckoo-agents-pack/agents/`（5）：code-reviewer / debugger / doc-writer / security-auditor / test-engineer

合并规则（`scanner.ts:92`）：**项目级 > 用户级 > 插件级**。故 `code-reviewer`/`doc-writer` 用项目级（更针对本仓库），`debugger`/`security-auditor`/`test-engineer` 用插件级。

**结论：不需要新建**，13 个已覆盖搜索、审查、测试、安全、调试、文档、架构、构建、hook、工具开发、需求。

## 遗留

- `runAgents` 并发上限（当前无，多任务时窗口压力）
- tools 白名单是软约束（机制层限制）
