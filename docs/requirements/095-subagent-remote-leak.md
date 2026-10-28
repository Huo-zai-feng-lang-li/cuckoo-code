---
id: 095
type: fix
title: 子代理窗口泄漏远程事件导致手机误报「已停止生成」
status: done
branch: fix/095-subagent-remote-leak
created: 2026-10-29
updated: 2026-10-29
---

# 需求 095：子代理窗口泄漏远程事件导致手机误报「已停止生成」

## 1. 背景
用户反馈：手机远程端在**主对话执行任务期间**会莫名弹出「已停止生成」，但电脑端主对话其实还在正常跑。

## 2. 根因定位（已取证）

### 2.1 事件链路
手机端只有收到 `ai-stop` 才显示「已停止生成」（`src/remote/pwa/app.js:567`）。
主进程广播 `ai-stop` 的入口之一是 bridge 上报，而 bridge 侧由 `onUserStop` 触发：

```
bridge/intercept/observer.ts:66  requestAbort()  →  emitUserStop()
                                                        ↓
bridge/remote-bridge.ts:111      onUserStop(() => report({ type: 'ai-stop' }))
                                                        ↓
app/ipc/remote.ts:151            else if (type === 'ai-stop') onAiStop(profileId)
                                                        ↓
remote/manager.ts:322            broadcast({ type: 'ai-stop', profileId })
                                                        ↓
pwa/app.js:567                   case 'ai-stop': showExecBrief('已停止生成', 1500)
```

### 2.2 泄漏点
- `src/bridge/entry.ts:304` 的 `initRemoteBridge()` 是**无条件执行**的——子代理窗口也会初始化一份 remote bridge。
  （同一段代码里 `initPlugins` 已经用 `if (!subCfg)` 挡掉了子代理，remote bridge 漏了同样的门控。）
- 子代理窗口复用父窗口的 `profileId`（`src/app/profile.ts:153` `id: parent.id`，设计如此，为了共用账本/token/设置）。
- 子代理达到 `maxTurns` 或结束时调 `requestAbort()`（`src/bridge/subagent.ts:126`）→ `emitUserStop()` → **子代理窗口的 remote-bridge 把 `ai-stop` 上报给主进程**。
- 主进程 `remote-report` 从 `event.sender` 反查 ctx 拿到的是**父 profileId**（因为复用），于是按父 profileId 广播 `ai-stop` → 手机弹出「已停止生成」。
- 用户根本没有停主对话，只是子代理自己收工。

### 2.3 同类泄漏（同一根因，一并修复）
不只是 `ai-stop`。子代理窗口的 `ai-stream` / `ai-reply` / `tool` / `ai-error` 同样会带父 profileId 上报，造成：
- 子代理的流式文本混进主对话气泡
- 子代理的工具 start/end 干扰主对话的 `toolCount`（影响 watchdog 判定）
- 子代理的错误被当成主对话失败

### 2.4 设计层面的佐证
生成状态（`ai-state`）在主进程**已经按 isSubagent 分开存储**（`src/app/window.ts:41-42`，注释明确写「子代理在跑不代表主对话未结束」）。
说明「子代理不应污染主对话状态」本就是设计意图，只是 remote 上报这条路径漏了同样的区分。

## 3. 方案（双保险，最小改动）

### 3.1 源头：子代理窗口不初始化 remote bridge（`src/bridge/entry.ts`）
```diff
-    initRemoteBridge();
+    if (!subCfg) initRemoteBridge();
```
与同文件里 `initPlugins` 的门控方式一致。

### 3.2 边界兜底：主进程忽略子代理窗口的上报（`src/app/ipc/remote.ts`）
```diff
     const ctx = windowState.getContextByWebContents(event.sender);
+    // 子代理窗口复用父 profileId，它的事件（尤其收工时的 ai-stop）若被转播，
+    // 手机会在父对话仍在生成时误显示「已停止生成」。子代理属内部过程，一律不上报。
+    if (ctx && (ctx as any).isSubagent) return { success: true };
     const profileId = (ctx && ctx.profileId) || '';
```
即使未来有其它路径（插件 / 新增 bridge）在子代理窗口触发上报，这里也能兜住。

### 3.3 相邻泄漏路径：lastActiveWindowId 被子代理顶替
审查时发现同源的第二条路径：
- `addWindow` 无条件执行 `lastActiveWindowId = win.id`，子代理窗口创建时会把"主窗口"指针抢走。
- 于是 `getMainContext()` 在子代理运行期间返回子代理 ctx，而它有 12 处调用方（手机远程 stop、会话导出、project-context、plugin IPC 等）。
- 手机端若未选窗口（`targetProfileId` 为空），`onPhoneStop` 会定位到子代理窗口，随后按父 profileId 广播 `ai-stop` —— 与报告症状同源。

修复（`src/app/window.ts`）：
- 新增 `pickMainWindowId()`：优先返回 lastActiveWindowId（非子代理时），否则取最后一个非子代理窗口。
- `addWindow`：`isSubagent` 为真时不更新 lastActiveWindowId。
- `removeWindow` 与窗口 `closed` 回调的回退改用 `pickMainWindowId()`。
- `getMainContext`：lastActiveWindowId 指向子代理时回退到 `pickMainWindowId()`。
- `getMainWindow`：改为走 `getMainContext()`，与主窗口语义保持一致。
- `setMainWindow`：传入子代理窗口时直接忽略。

正常单/多窗口场景下行为与改动前完全一致，只影响子代理窗口。

## 4. 涉及文件
- `src/bridge/entry.ts`（1 行门控 + 注释）
- `src/app/ipc/remote.ts`（3 行拦截 + 注释）
- `src/app/window.ts`（主窗口选举排除子代理）
- `test/main/window.test.js`（5 个回归用例）

## 5. 验收标准
- [ ] 跑子代理（`runAgent`）期间，主对话仍在生成时手机**不再**出现「已停止生成」
- [ ] 子代理的流式文本不再混进主对话气泡
- [ ] 手机端主动点停止仍能正常显示「已停止生成」（`onPhoneStop` → `onAiStop` 路径未受影响）
- [ ] 主对话自身的正常停止仍正常
- [x] `npm run typecheck` ✅ / `npm test` ✅ 131 文件 1304 用例 / `npm run lint` ✅ 0 error / `npm run compile` ✅

## 6. 遗留 / 未修的同类问题
本次只修「子代理窗口泄漏」。调查中另外发现两条**文案误导**（不是 bug，是语义复用导致）：

1. **watchdog 兜底收尾复用 `ai-stop`**（`src/remote/manager.ts:334`）：网页已不在生成、静默超 8 秒后主动调 `onAiStop`，手机显示「已停止生成」。
   实际可能只是「finished 帧丢失、流已正常结束」。语义上应区分「用户停止」与「本轮已结束」，需要新增独立事件类型，改动面比本需求大。
2. **ChatGPT 平台把断流判为 stopped**（`src/providers/hooks/chatgpt.ts:117`，`aborted = AbortError || XHR status===0`）：弱网/切后台导致连接中断时，会被当作「用户主动停止」上报。
   DeepSeek hook 的 `stopped` 只认拦截到的 `stop_stream` 请求，不会这样误判。

两者均待用户确认是否为实际痛点后再单独立项。
