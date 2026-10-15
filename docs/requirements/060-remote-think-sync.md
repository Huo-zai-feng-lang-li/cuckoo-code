---
id: 060
type: fix
title: 手机远程修复：思考同步 + 自动折叠 + 重连状态同步 + remote-mode 广播
status: done
branch: fix/060-remote-think-sync
created: 2026-10-16
updated: 2026-10-16
---

## 背景

用户反馈手机远程操控 4 类问题：
1. **思考信息完全没显示**，正文同步也不及时
2. 需要**展示思考**，且**思考完毕自动折叠**
3. **连接成功但消息推送失败**
4. **切后台再切回必须重连**（重连后丢消息）

## 根因（证据链）

### ① 思考从不发送
`src/bridge/remote-bridge.ts:66`：`if (!enabled || !ev || !ev.text || ev.finished) return;`
—— 只处理 `ev.text`，**丢弃 `ev.think`**。manager 与 server 协议也只有 `text`，无 think 通道。

### ② PWA 无思考 UI
`src/remote/pwa/app.js` 的 `handleServerMessage` 无 think 分支，无 think 气泡。

### ③ 连接成功但推送失败
`src/remote/manager.ts:259 initRemote()` 启动服务后**从不广播 `remote-mode`**。若 AI 页面 preload 在服务启动之前查询 `remote-is-enabled`（异步竞态），得到 `enabled=false`，此后**无任何事件复位**（`remote-mode` 只在 save-config/reset-token/restart 时发）→ `remote-bridge.ts` 的所有 `onStream` 被门控丢弃。

### ④ 重连丢消息
`src/remote/server.ts:178 onWsConnection` 只发 `ready`（含 profiles 列表），**不同步当前流式状态**。重连后 `manager` 的 `s.sent` 基线保持旧值 → 下次 `flushStream` 只发"断线点之后的增量" → 手机端缺断线期间的文本。

### ⑤ 同步不及时
双层节流（bridge 100ms + manager 100ms）= 200ms 端到端延迟；think 完全缺失加重体感。

## 修复

### A. 协议升级（`ai-stream` 增加 think 通道）
- bridge → manager → server → PWA 全链路：`ai-stream` 从 `{ delta, reset }` 升级为 `{ thinkDelta, textDelta, reset }`
- `reset=true`：手机端清空 think 与 text，从头累积

### B. bridge 上报 think
`remote-bridge.ts` 的 `onStream`：同时累积 `pendingThink` 与 `pendingText`，节流后一起上报。

### C. manager 独立累积 think + 新客户端状态同步
- `StreamState` 增 `think` / `thinkSent` 字段，独立算 delta
- 新增 `onNewClient` 回调：新客户端连入时，对每个活跃流式状态**立即广播全量 `reset=true`**（让手机同步当前进度）
- `initRemote` 成功后广播 `remote-mode(true)`

### D. server 新增 onNewClient
`onWsConnection` 里调用 `deps.onNewClient?.()`。

### E. PWA 思考气泡 + 自动折叠
- `ai-start` / `ai-stream(reset)`：创建 think 气泡（在正文气泡上方）
- 流式期间：有 think 无 text → think 展开；有 text → think 自动折叠
- 用户手动点过 think 标题 → `userToggled` 标记，尊重用户选择
- 收尾：think 折叠 + 显示"已思考 (N 字)"

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机：手机上能实时看到思考过程、正文逐字出现、思考完自动折叠；断网重连后不丢消息

## 风险

- 协议变更：老手机端连新电脑端会显示不出 think（但 `ai-reply` 带全量 text，最终结果正确）。可接受。
- 双层节流不变（性能已优化过）；不追求极限低延迟。

## 审计意见处理（子代理审计，6 项全修）

- **🔴 #1（flushStream reset 未发全量）**：真 bug（本次引入）。`reset=true` 时未把全量填入 delta，手机端清空后无内容补入 → 丢正文/丢 think。改为：任一前缀不匹配 → 直接广播全量 + reset=true。
- **🔴 #2（ai-start 清掉历史 think）**：`resetThink()` 会 remove DOM，误删上一轮历史思考块。改为：ai-start / ai-stream.reset 只重置引用，不动历史 DOM；`resetView`/清屏 才真删。
- **🟡 #3（补发后未更新基线）**：`pushActiveStreamsToNewClient` 补发后未同步 `sent/thinkSent` → 下一轮 flush 重复发尾巴。已补基线更新。
- **🟡 #4（think/text 交替抖动）**：新增 `sawText` 标记，正文出现后 think 不再自动展开。
- **🟡 #5（broadcastRemoteMode 重复实现）**：删除 ipc/remote.ts 的副本，统一用 manager 导出。
- **🔵 #6/#7（协议兼容 / 新窗口门控竞态）**：可接受（老端最终结果正确；新窗口有 remote-is-enabled 兜底）。

## 第二轮审计意见处理

- **🔴 #1（reset 时正文为空则不重发）**：驳回。reset 分支已清空手机端容器，textDelta='' 时跳过 append，最终状态一致，属正确行为。
- **🟡 #2（resetThink 未重置 sawText）**：采纳，补一行 `sawText = false`。
- **🟡 #3（onAiStop/onAiError flush 只判 text，think 尾帧丢）**：真 bug，采纳，条件纳入 think。
- **🟡 #4（appendStreaming reset 参数死代码）**：采纳，删除参数与分支。
- **🔵 #5（reset 帧展开→折叠闪烁）**：不改（无实害）。
- **🔵 #6（切窗口前缀丢失）**：固有设计，不改。
