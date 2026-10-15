---
id: 065
type: fix
title: 工具结果回传偶发丢失（模型停下）—— observer 层重试 + 发送校验
status: done
branch: fix/065-tool-result-retry
created: 2026-10-16
updated: 2026-10-16
---

## 现象

偶发（1~2 次）：工具执行完，模型停下不继续 —— 工具结果没有回传到输入框发给模型。

## 根因

回传链路 `observer.ts` → `sendCombinedJsResultsToChat` → `doSendToChat`，失败时**无重试**：
- `findInputArea()` 返回 null → 返回 false → observer 只隐藏遮罩、不重试
- `setInputContent()` 填充失败 → 返回 false → 不重试
- `triggerSend()` 静默失败（fallbackSend 是 void，无法返回结果）→ **假阳性 true** → 无从察觉

任一偶发失败 = 本轮工具结果永久丢失 → 模型收不到结果 → 停下。

## 修复（全部在 observer.ts / bridge 层，隔离安全）

### A. 发送失败重试
`sendCombinedJsResultsToChat` 返回 false 时，退避重试（600ms 间隔，最多 2 次）。覆盖"找不到输入框 / 填充失败"。

### B. 发送后校验（防 triggerSend 假阳性）
发送"成功"（返回 true）后延迟 800ms 检查输入框：
- 若输入框**仍等于我们填入的原文**（说明 triggerSend 没生效）→ 再 `triggerSend` 一次（最多 1 次）。
- 若已清空 / 内容不同（用户编辑了）→ 不动。

防误判：只在"内容完全等于原文"时重试；800ms 给站点足够清空时间。

### 配套
- `chat-input.ts` 导出 `getInputText`（纯读函数，新增导出，零影响核心）。

## 为什么不动 chat-input 核心
Harness 走 `sendToChat`；本修复只在 bridge 的工具回传路径（observer）包装重试/校验，**不改 chat-input 任何函数签名与默认行为** → Harness 零影响。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核（重点：双发风险 / 对 Harness 零影响 / 重试逻辑闭环）
- 真机：工具结果正常回传；模拟失败 → 重试生效

## 风险

- 改动全在 observer.ts（bridge 工具回传路径），不触碰 Harness 的 sendToChat 默认行为。

## 审计意见处理（子代理审计）

子代理审计发现"发送后校验（verifySend）"机制有 3 个真缺陷：
- **🔴 R1 双发**：站点清空输入框延迟 >800ms → 误判未发送 → 重复 triggerSend → 工具重复执行。
- **🔴 R2 补发定时器不受停止约束**：用户点停止后仍补发。
- **🔴 R3 校验在 sendChain 之外**：重试机制覆盖不到补发阶段（假成功）。
- 🟡 R4：contenteditable 的 innerText 归一化导致 cur===msg 恒不成立 → 校验空转。

**主代理决策：回退 verifySend，只保留 observer 层失败重试。** 理由：
1. "triggerSend 假阳性"无法可靠检测（受站点 DOM/清空时机影响），强行检测会引入双发（工具重复执行=破坏性 > 原 bug）；
2. 失败重试已覆盖"可检测的机械失败"（找不到输入框 / 填充失败），这是偶发失败最可能的形态。

**已回退**：chat-input.ts 全部改动（git checkout 还原）；observer.ts 只保留 sendToolResultWithRetry。
**Harness 零影响**：子代理确认（sendToChat 调用点无一传 verifySend；改动仅 observer 工具回传路径），信心 9/10。
