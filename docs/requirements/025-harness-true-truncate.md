---
id: 025
type: feature
title: 纯净模式真截断（从某条消息重开新会话）
status: done
branch: feat/025-harness-true-truncate
created: 2026-10-12
updated: 2026-10-12
---

## 背景

纯净模式（harness）的消息气泡有「从此处截断重发」按钮，tooltip 承诺"丢弃此消息之后的所有对话，从此处重新接续生成"。

**但实测发现这是假截断**：按钮只删了 harness 本地 DOM + localStorage 历史，**DeepSeek 网页里的真实会话原封不动**。用户点完以为删了历史，AI 却仍能看到全部旧消息。

## 目标

让「截断重发」**真正生效**——从指定位置**新开一个会话**，只保留该位置之前的历史，然后在其中发送编辑后的新消息。

复用「窗口组迁移 / 压缩」已跑通的 DeepSeek share API（`session/compaction.ts`），不碰脆弱的 DOM 编辑按钮。

### 范围

- ✅ 本功能上线后新产生的 AI 回复：记录 `webMsgId`（服务端 response_message_id），支持精确截断
- ✅ 截断 = 用 share API 复制"到某条为止"的新会话 → 跳转 → 自动发新消息
- ✅ 失败兜底：任何阶段失败提供「返回原会话」
- ✅ 旧历史（本功能上线前产生的、无 webMsgId）→ 温柔拒绝并提示（选项 A）
- ❌ 不做：文本匹配重建映射（易误判）、DOM 编辑按钮驱动（易碎）

## 核心难点与解法

### 难点：harness user 消息 ≠ 网页 USER 消息

框架自身也往网页发消息（系统提示词、JS汇总工具回传、看门狗、重试提示…），**每条在网页上都是独立 USER 消息**（`chat-input.ts:107` SYSTEM_MSG_TAGS 全走 `sendToChat`）。

所以"从 harness 第 K 条 user 截断"**无法直接对应**网页某条 message_id。

### 解法：用 assistant 对齐

- harness 的 assistant 回复 ↔ 网页的 ASSISTANT 消息 **1:1**
- 底层 `observer.ts:351` 的 `onInterceptedResponse` meta **已含** `msgIds`（`{requestMessageId, responseMessageId}`），但 `harness-bridge.ts:82` 只接 text、丢弃了 meta
- "截断到第 K 条 user" = "保留到第 K-1 条 assistant 的 responseMessageId"

因此只需：harness-bridge 透传 meta → harness 每条 assistant 记录 `webMsgId` → 截断时按它定位。

## 设计

### 分层（严格遵守依赖铁律）

- `harness.html`（UI 层）：只发 IPC「截断到 webMsgId=X」，**不做** IDB/网络
- `app/ipc/harness.ts`（主进程）：转发 AI 页面 + pending 状态机
- `bridge/`（AI 页面 preload）：读 IDB + 调 share API（浏览器上下文）
- 复用 `session/compaction.ts` 的 `getMessagesFromIndexedDB` / `createShare`

### 流程（5 段异步接力）

```
1. harness 点截断 → 算目标 webMsgId → IPC harness-truncate
2. 主进程 → AI 页面 'cuckoo-truncate-share' {reqId, webMsgId, oldSessionId}
3. AI 页面：读 IDB → 回溯主链 → 截到 webMsgId → createShare → 回执 shareId
4. 主进程：记录 prevSessionId → 导航 AI 页面到 /share/<shareId>
5. 新会话 session-changed → harness 用「pending 迁移的 history」覆盖 → 发新消息
```

### 状态迁移（照抄 checkPendingInit 模式）

- 跳转前：把截断后的 harness history 写入新 share_id 的 localStorage key（pending 迁移）
- 到新会话：命中 pending → 直接用该 history，不读 localStorage

### 失败兜底

| 阶段 | 失败处理 |
|---|---|
| 计算 webMsgId（无记录） | 提示"此会话不支持精确截断"，不改状态 |
| share API 失败 | 提示 + 保留现场，不导航 |
| 导航失败 | 监听 did-fail-load → 提示 + 返回原会话 |
| 跳转后发送失败 | 自动导航回 `sessionUrlBase + prevSessionId` |

**关键**：原会话在 web 端天然不受影响（share 只是复制），最坏是"视图丢去向"，数据不丢。

## 关键假设（已实测）

| # | 假设 | 状态 |
|---|---|---|
| 1 | harness assistant ↔ web ASSISTANT 1:1 | ✅ 已核实 |
| 2 | meta.msgIds.responseMessageId 即网页该条 AI 回复的 message_id | ✅ 已核实 |
| 3 | 沿 parent_id 回溯能精确命中 webMsgId | ✅ 已核实 |
| 4 | 跳到 share 新会话后自动发消息可成功 | ✅ 已核实 |

## 实现状态（2026-10-12）

### 已完成

**阶段1（基础 + 单测）**
- `bridge/harness-bridge.ts`：`onInterceptedResponse` 透传 `meta.msgIds`（+3 测试）
- `ui/harness.html`：assistant 条目记录 `webMsgId`
- `session/compaction.ts`：新增 `sliceChainUpTo`（沿主链精确截取，含成对校验）+ `shareUpTo`（+7 测试）

**阶段2（核心链路）**
- `bridge/entry.ts`：`cuckoo-truncate-share` 监听 → `shareUpTo`
- `app/ipc/harness.ts`：`harness-truncate` handler + `requestTruncateShare`（reqId 往返）+ `activateShareSession`（等加载 → 发消息激活 → 重试）
- `app/harness-preload.ts`：`truncate` API
- `ui/harness.html`：`doTruncate` 改写（走真截断）、`resolveTruncateWebMsgId`、`pendingTruncate` 状态 + 落地 localStorage

**阶段3（兜底）**
- 截断超时（30s）→ 清理 + 提示，绝不滞留
- 分享会话激活失败 → 自动回退原会话（`sessionUrlBase + prevSid`）
- pendingTruncate 落地 localStorage → 页面重载不丢

### 真机验证（2026-10-12 全部通过 ✅）

- [x] 截断成功闭环（AI 回复带 `webMsgId` → 点截断 → 新会话 → 历史迁移正确 → 发新消息）
- [x] 分享页发送失败 → 回退原会话
- [x] 截断中途切会话 → pendingTruncate 不错误消费
- [x] 截断中途重载 harness → pendingTruncate 恢复
- [x] **假设 #2 核实**：`responseMessageId` 数值 == IDB `message_id`

### 真机 Bug 修复：读 IDB 前必须刷新（2026-10-12）

**现象**：新开对话点截断 → 报「IndexedDB 无该会话消息」。

**根因**（架构性缺陷）：`shareUpTo` 直接在**未刷新**的当前页读 IDB，但 `compaction.ts` 文件头实测已证明——
**同会话内 AI 回复后 IDB 不更新，只有刷新页面才会让 DeepSeek 写回完整历史**。新会话从未刷新 → IDB 无该 sessionId 记录 → `getMessagesFromIndexedDB` 抛错。

**修复**（复用压缩流程已验证的两段式，方案 A）：
- 截断拆为两段：段1「清 IDB + URL 加 `cuckoo-truncate` flag + 刷新」（`prepareTruncate`，由 bridge/entry 监听 `cuckoo-truncate-prepare` 触发）；
  段2「刷新后等 `cuckoo-idb-history-written` → 读 IDB → `sliceChainUpTo` → `createShare` → 回执 shareUrl」（`checkPendingTruncate`，由 overlay/events 驱动）。
- hook 的 IDB 写入拦截 flag 增加 `cuckoo-truncate`（原仅 `cuckoo-compact`）。
- `app/ipc/harness.ts`：`requestTruncateReady`（单飞 pending，因刷新无法跨 reqId）替代 `requestTruncateShare`；回执经 `cuckoo-truncate-share-ready`。
- harness 侧超时 30s → 90s（须 > 主进程 60s）。
- **删除** TS 侧死代码 `shareUpTo`（逻辑移入 `checkPendingTruncate`）；压缩流程零改动。

**改动文件**：`providers/hooks/deepseek.ts`、`session/compaction.ts`、`overlay/events.ts`、`bridge/entry.ts`、`app/ipc/harness.ts`、`ui/harness.html`。

### 审计修正（子代理 code-reviewer）

| 问题 | 处置 |
|---|---|
| pendingTruncate 无超时兜底 | ✅ 加 30s 超时 |
| pendingTruncate 纯内存（重载丢失） | ✅ 落地 localStorage |
| sliceChainUpTo 缺成对校验 | ✅ 加链尾 ASSISTANT 校验 |
| 2500ms 魔法延迟 | ✅ 改事件驱动（等加载 + 轮询 URL + 重试） |
| prevSid 死代码 / 无回退 | ✅ 实现回退导航 |
| resolveTruncatePoint TS 死代码 | ✅ 删除（UI 侧单一实现） |

## 相关

- 复用：`session/compaction.ts`（IDB 读 / createShare / 回溯）、`app/ipc/window-groups.ts`（reqId 往返协议）、`compaction.ts checkPendingInit`（跨页状态迁移）
- 参照：`docs/requirements/021-window-groups.md`
