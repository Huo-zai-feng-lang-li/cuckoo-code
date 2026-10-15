---
id: 063
type: fix
title: 手机远程卡"正在生成回复"—— 缺少权威生成状态兜底
status: done
branch: fix/063-remote-busy-stuck
created: 2026-10-16
updated: 2026-10-16
---

## 现象

手机远程端一直显示"正在生成回复"，与电脑端不同步（电脑端已结束）。

## 根因（证据链）

手机端清"生成中"只依赖三个终态事件：`ai-reply` / `ai-stop` / `ai-error`（`pwa/app.js` 的 `case` 分支）。任一丢失即永久卡住：
- `src/bridge/remote-bridge.ts:89` `if (!clean) return;` —— 回复含工具块被 `stripBlocks` 剥空时不发 `ai-reply`；若该轮无后续纯文本回复，手机端收不到终态。
- 无权威生成状态心跳兜底（对比 Harness：有 `ai-state` 每 2s 心跳 + 静默兜底）。

而**权威状态其实存在**：`src/bridge/harness-bridge.ts` 每 2s 上报 `ai-state` → `src/app/ipc/harness.ts:290` 写入 `windowState.setGenerating(profileId, generating)`。`windowState.isGenerating(pid)` 是可靠信号，只是 manager 没把它同步给手机。

## 修复

manager 加 **watchdog**（每 3s）：
对每个 `streamStates` 里 `active` 的 profile，若同时满足：
- `toolCount === 0`（无工具在跑，任务未处于工具执行阶段）
- `!windowState.isGenerating(pid)`（网页确实已停止生成）
- 静默 >8s（防抖，避免误伤刚要开始的生成）

则调用 `onAiStop(pid)` 主动收尾（清 busy、清流式状态、广播 `ai-stop`）。

配套：
- `StreamState` 加 `toolCount` / `lastAt` 字段。
- `onAiStream` 更新 `lastAt`。
- `onTool` 增减 `toolCount` + 更新 `lastAt`。
- `initRemote` 启动 watchdog；`stopRemote` 停止。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机：手机端发消息 → 正常收尾；模拟终态丢失 → 8s 内自动收尾

## 风险

- `isGenerating` 依赖 harness-bridge 心跳；若 bridge 未初始化（极端），watchdog 可能误收尾。缓解：8s 静默窗口 + 仅对 active 且无工具的状态生效。
  - 补充取证：`bridge/entry.ts` 的 `initHarnessBridge()` 与 `initRemoteBridge()` 同处一个 `init()`，无条件执行。故"无 ai-state = 无 streamStates = watchdog 空转"，自洽，无空转误伤。

## 审计意见处理（子代理审计，7 项）

- **🔴 #1（toolCount 无超时兜底）**：真缺陷，采纳。新增 `toolLastAt`；工具阶段无活动超 5 分钟视为 `tool-end` 丢失，强制收尾。否则 stuck 场景下 watchdog 永久跳过，修复失效。
- **🔴 #2（子代理污染 isGenerating）**：主代理核实成立（子代理与父窗口共用 profileId，`harness.ts:291` 写入会互相覆盖）。修复：只接受主窗口（`!ctx.isSubagent`）的 ai-state 写入。此修复同时惠及窗口组切换的忙闲判断。
- **🟡 #3（isGenerating 自身卡 true 时无兜底）**：残余盲区，未改（依赖 059 已修的 finished 帧复位；再加绝对上限属过度设计）。记录为已知边界。
- **🟡 #4（finished 帧不更新 lastAt）**：低概率（间隙达 8s），未改。
- **🟡 #5（watchdog 复用 onAiStop 语义）**：语义耦合，非功能错误，未改。
- **🔵 #6（onTool name 恒空）**：既有问题，非本次回归。
- **🔵 #7（错位注释）**：采纳，修正。
