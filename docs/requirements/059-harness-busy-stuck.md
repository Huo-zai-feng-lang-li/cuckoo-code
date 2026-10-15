---
id: 059
type: fix
title: Harness 卡"生成中"—— aiGenerating 置位后无可靠复位时机
status: done
branch: fix/059-harness-busy-stuck
created: 2026-10-16
updated: 2026-10-16
---

## 现象

AI 网页原始版本已回答终止（真实任务结束），但 Harness 纯净模式仍显示"生成中"，发送键停在"停止"态。

## 根因（证据链）

`aiGenerating` 一旦被置 true，缺少可靠的复位时机，叠加"心跳续命"形成死循环：

1. `src/bridge/harness-bridge.ts:80`：`if (!ev.finished && (ev.text || ev.think)) setAiGenerating(true)` —— **finished 帧（流结束）不处理**，只置位不复位。
2. `src/bridge/harness-bridge.ts:89`：`if (!HAS_TOOL_BLOCK_RE.test(raw)) setAiGenerating(false)` —— 只有"回复不含 js/cuckoo 代码块"才复位；含代码块的回复**永不复位**。
3. `src/bridge/harness-bridge.ts:68`：`if (aiGenerating === next) return` —— 卡 true 后，2s 心跳**持续上报 true**。
4. `src/ui/harness.html:2424`：`onAiState(true)` 每次都刷新 `lastActivityAt`（把心跳当成"有新活动"）。
5. `src/ui/harness.html:2429`：`if (Date.now() - lastActivityAt <= AI_STATE_QUIET_MS) return` —— 6s 静默保护**永不满足** → 永不收尾。

即：心跳本用于"解套卡死"，但 `aiGenerating` 卡 true 时，心跳反而成为"续命器"，使静默兜底失效。

## 修复

### A. finished 帧复位（治本）
`harness-bridge.ts` 的 `onStream`：
- finished 帧 → `setAiGenerating(false)`（流式输出结束 = 网页已停止生成，权威信号）
- 非 finished 且有内容 → `setAiGenerating(true)`

### B. 工具运行中放宽 onAiState(false) 阈值（防副作用）
改成 A 后，工具执行期间 `aiGenerating` 会变 false（语义正确：网页确实停止生成了，工具是框架在跑）。
但 `onAiState(false)` 现有 6s 静默会**误清长时间工具**（>6s 的工具）。故：
- `toolRunningCount > 0` 时，静默阈值放宽到 600s（工具长任务宽容；仅兜底 tool-end 丢失）
- 否则维持 6s（普通生成结束 6s 后收尾）

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机：普通回复结束 → 及时收尾；长工具（>6s）→ 不被误清；tool-end 丢失 → 600s 兜底

## 风险

- finished 帧语义依赖 hook 在流结束时确实发 finished（harness.html 已有对 finished 帧全量渲染的处理，可佐证）。

## 审计意见处理

- **🟡-2（工具结束→下一轮回传间闪"就绪"）**：驳回。`harness.html` 的 `tool-end` 分支已 `lastActivityAt = Date.now()` 且 `setStatus('生成中…','busy')` 保持 `generating=true`，不会闪。
- **🟡-1（AI_STATE_QUIET_TOOL_MS=600s 对 tool-end 丢失退化到 10 分钟）**：权衡后保留 600s。
  - 关键：`onAiState` 的 `quietMs` 由**当前** `toolRunningCount` 决定。`tool-end` 一到达即 `toolRunningCount=0`，阈值立即回落 6s → 正常场景不受影响。
  - 600s 仅作用于「`tool-end` **真丢失**」的罕见场景（页面导航/异常中断）。
  - 若缩小到 120s，会让 >120s 的长工具（子代理）被误清（`onAiState(false)` 每 2s 触发，工具跑满阈值即清零），代价更大。
  - 结论：安全优先，保留 600s；已在注释说明权衡。
- **🔵-1（常量 600000 重复）**：采纳，interval 的字面量改用 `AI_STATE_QUIET_TOOL_MS`。
- **🔵-2（>600s 超长工具误判）**：属已知上限（工具侧无周期心跳），记录不改。
