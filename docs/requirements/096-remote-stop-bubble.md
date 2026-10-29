---
id: 096
type: fix
title: 手机端「已停止生成」气泡在正常任务结束时误报
status: done
branch: fix/096-remote-stop-bubble
created: 2026-10-29
updated: 2026-10-29
---

# 需求 096：手机端「已停止生成」气泡在正常任务结束时误报

## 1. 背景
用户反馈：手机远程端在**执行任务期间**偶尔弹出「已停止生成」气泡通知，但电脑端主对话其实还在正常跑任务。

需求 095 已修复「子代理窗口泄漏」这一条来源。本需求修另一条更常见的来源。

## 2. 根因定位（已取证）

### 2.1 触发链路
```
manager.ts:339  busyWatchdogTick()  每 3 秒扫一次
                  ↓ 网页 isGenerating=false 且 s.active=true 且静默 > 8 秒
manager.ts:354  onAiStop(pid)
                  ↓
manager.ts:327  broadcast({ type: 'ai-stop', profileId })
                  ↓
pwa/app.js:567  case 'ai-stop': showStopNotice() → addSystem('已停止生成')
```

### 2.2 为什么正常任务结束会被 watchdog 判定为「需要兜底」
关键在 `s.active` 这个标志位：

- 置 `true`：`onAiStream` 首次收到流式帧时（`manager.ts:201-208`）
- 清 `false`：只有 `onAiReply` / `onAiStop` / `onAiError` 三个函数

而 **`onTaskDone` 明确不清流式状态**（`manager.ts:384` 注释：「这里不改流式状态（可能还有收尾帧要 flush），只做通知用途的广播」）。

于是当一轮任务**最后一轮只输出工具代码块、没有正文**时：
1. AI 输出纯 `cuckoo` 工具块 → `remote-bridge.ts:96-97` 的 `stripBlocks()` 把它剥成空串 → `if (!clean) return` → **不发 `ai-reply`**
2. `s.active` 停留在 `true`（没有 `onAiReply` 来清）
3. `onTaskIdle` → `task-done` 广播了，但 `onTaskDone` 不清状态
4. 8 秒后 watchdog 判定「网页已停但没收到终态」→ `onAiStop(pid)` → 手机弹「已停止生成」

**用户什么都没停止，只是任务正常做完了。**

这也解释了为什么现象是「有时候」——取决于任务最后一步有没有输出正文。

### 2.3 同类触发
- 工具阶段 `tool-end` 事件丢失：`s.toolCount > 0` 且超过 300 秒无工具活动 → 同样走 watchdog 收尾
- 任何导致终态事件（`ai-reply`/`ai-stop`/`ai-error`）丢失的网络/异常情况

这些情况下 **状态收尾本身是必要的**（否则手机端永久卡「正在生成」），问题只在于**复用了「已停止生成」这个面向用户的文案**。

## 3. 方案（只改气泡显示，不动状态流转）

给 `ai-stop` 事件加一个 `reason` 字段区分来源：

- `'user'`（默认）：用户主动停止（手机端点停止、网页端点停止）
- `'watchdog'`：电脑端兜底收尾（网页已停、静默超阈值，可能只是 finished 帧丢失）

手机端对 `reason === 'watchdog'` 只做状态复位，**不弹气泡**。

### 3.1 src/remote/manager.ts
```diff
-function onAiStop(profileId: string): void {
+function onAiStop(profileId: string, reason: 'user' | 'watchdog' = 'user'): void {
   ...
-  remoteServer.broadcast({ type: 'ai-stop', profileId: pid });
+  remoteServer.broadcast({ type: 'ai-stop', profileId: pid, reason });
 }

 // busyWatchdogTick 内
-    onAiStop(pid);
+    onAiStop(pid, 'watchdog');
```

### 3.2 src/remote/pwa/app.js
```diff
   case 'ai-stop':
     if (!isMyProfile(msg.profileId)) break;
     finishStreaming(streamingText);
-    showExecBrief('已停止生成', 1500);
     setExecuting(false);
+    if (msg.reason === 'watchdog') break;
+    showExecBrief('已停止生成', 1500);
     showStopNotice();
     break;
```

### 3.3 手机端必须补 hideExec()
最初实现里 watchdog 分支直接 `break`，漏了隐藏执行状态条。该场景下 `onToolEvent('end')` 已把执行条置为「正在生成回复…」且 `execVisible=true`，不显式隐藏就会永久残留（`finishStreaming` 不碰 `execStatus`，`setExecuting` 只切按钮）。已修正为：

```js
if (msg.reason === 'watchdog') { hideExec(); break; }
```

### 3.4 为什么不动状态流转
`onAiStop` 的状态清理（flush 尾帧、清 `s.active`/`toolCount`/`busy`）是 watchdog 存在的意义，**必须保留**，否则手机端会永久卡「正在生成回复」。本需求只剥离面向用户的文案。

### 3.4 透传验证
`remote/server.ts:442-444` 的 `broadcast` 是 `JSON.stringify(payload)` 原样转发，无字段白名单，`reason` 完整到达客户端。上行消息的类型过滤（`server.ts:275-311`）只作用于客户端→服务端方向，不影响下行广播。

## 4. 涉及文件
- `src/remote/manager.ts`
- `src/remote/pwa/app.js`

## 5. 验收标准
- [x] typecheck / test（1304 用例）/ lint（0 error）/ compile 全绿
- [ ] 任务最后一轮只调工具（无正文）时，手机端**不再**弹「已停止生成」，且状态正常复位（不卡「正在生成」）
- [ ] 手机端主动点停止，仍正常弹「已停止生成」
- [ ] 网页端点停止，仍正常弹「已停止生成」

## 6. 遗留
- `onTaskDone` 不清流式状态，导致 watchdog 每轮都要等满 8 秒才收尾。更彻底的修法是让 `onTaskDone` 也清状态（与 `onAiReply` 一致），但会改动状态流转，本需求刻意不做。
- ChatGPT 平台把断流（`AbortError` / `XHR status===0`）判为用户停止（`providers/hooks/chatgpt.ts:117`），弱网时会误报「已停止生成」。DeepSeek 无此问题。未修。
