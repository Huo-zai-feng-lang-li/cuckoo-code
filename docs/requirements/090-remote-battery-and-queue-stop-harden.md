# 需求 090：远程应用电量优化弹窗单次提醒与任务队列先停后发防串台加固

## 1. 核心目标
1. **远程 Android App 电量优化弹窗优化**：修复远程 Android PWA/Capacitor 应用每次进入都重复唤起系统电量优化详情页的问题，通过本地持久化标记确保仅在冷启动首次引导，后续进入不再重复骚扰。
2. **任务队列发送先停后发与防串台**：加固队列单条发送（立即发送/自动排空），严格执行“先彻底停止当前任务、清空输入框与暂存附件、等待停止稳定、再回显队列文字发送”，杜绝残留草稿或旧任务结果交叉污染回显。
3. **多端任务停止与状态闭环**：手机端与纯净模式可靠中止任务，清理运行中的工具卡片与忙态，杜绝死锁与未捕获异常。

## 2. 问题分析与根因定位
1. **Android 电量优化重复跳转**：
   - 原 `startNativeKeepAlive` 每次进入应用都会调用原生 `checkBatteryOptimization`。若用户未在系统设置中手动勾选“无限制”，原生接口始终返回 `isIgnoring: false`，导致应用每轮启动都无条件触发系统跳转 Intent，影响体验。
   - 解决方案：引入 `localStorage['cuckoo-battery-opt-req']` 单次引导标记位。首次冷启动请求一次豁免；若已请求过且用户未开启无限制，后续冷启动静默跳过；仅当检测到已获得无限制白名单时才清除标记，保障逻辑稳健且不重复打扰。
2. **队列发送残留与任务结果回显**：
   - 用户在任务运行中点击队列“立即发送”时，原逻辑如果旧任务未彻底停稳，残留的流式帧、工具回传或框架指令会与即将发出的新队列消息交织，造成输入框将上一轮任务结果误回显或串台。
   - 解决方案：
     - `sendQueueItemNow` 严格顺序：`stop()` -> 清空输入框与暂存附件 -> `waitForAiIdleThenSend`（等待持续 500ms 静默期或超时） -> 回显当前项内容 -> `send()`。
     - `doSendQueueItem` 发送后保持输入框清空，杜绝旧草稿恢复污染。
     - `maybeFlushQueue` 后台自动排空时妥善保护并恢复用户正在输入的草稿（`savedInput`），并触发 `autoGrowInput()` 重新计算高度。
     - 流式帧（`onStream`）与框架投递（`onFrameworkSend`）严密拦截 `aborted()` 中止抑制，静默期内迟到的残余帧直接丢弃。
3. **手机端与纯净模式停止闭环**：
   - 手机端 `onPhoneStop` 调用 `stopGeneration`，兼容各种停止结果并及时清理 `busyProfiles`，广播系统反馈。
   - 手机端 PWA 点击停止时同步调用 `finishStreaming(streamingText)`，及时将流式占位收尾为最终 Markdown 气泡。
   - `harness-stop-signal` 接收时安全异步清空底层输入框，拦截未捕获 Promise rejection。

## 3. 改动清单
- `android/app/src/main/assets/public/app.js` & `src/remote/pwa/app.js`：
  - 增加 `BATTERY_REQ_KEY = 'cuckoo-battery-opt-req'` 标记，单次提醒电量优化。
  - 手机端停止按钮点击时触发 `finishStreaming` 流式收尾。
- `src/ui/harness.html`：
  - 加固 `doSendQueueItem`、`waitForAiIdleThenSend` 与 `sendQueueItemNow`，严格先停后发。
  - `maybeFlushQueue` 恢复 `savedInput` 并在之后调用 `autoGrowInput()`。
  - `onStream` 与 `onFrameworkSend` 追加 `aborted()` 校验。
- `src/overlay/chat-input.ts`：
  - 导出 `clearInputArea` 异步清空底层页面输入框。
  - `cancelPendingSend` 针对系统内部标签清理输入框，Promise 增加错误捕获。
- `src/bridge/harness-bridge.ts`：
  - `harness-stop-signal` 增加 `clearInputArea().catch(...)` 异步清空。
- `src/bridge/intercept/observer.ts`：
  - 停止后 `cuckoo-ai-stream` 忽略残余帧，防止已中止的任务在页面上继续吐字。
- `src/app/ipc/harness.ts`：
  - `stopGeneration` 优化返回值判定，处理 `not-generating` 与 `escape` 停止方式。
- `src/remote/manager.ts`：
  - `onPhoneStop` 稳定收尾忙态，广播清晰停止反馈。
- `src/infra/user-agent.ts`：
  - 精确闭合 `buildUserAgentDataFix` 的大括号结构，消灭 `SyntaxError: Unexpected token 'catch'`。

## 4. 验证与审计
- **全量流水线**：
  - `npm run compile` 成功
  - `npm run typecheck` 成功（零错误）
  - `npm run lint` 成功（零错误）
  - `npm test` 129 套件、1250 用例 100% 全绿
- **双代理独立代码审查（invoke_subagent）**：
  - 子代理独立审计指出 `waitForAiIdleThenSend` 令牌重置、`clearInputArea` 异步捕获、`autoGrowInput` 高度修正等问题。
  - 主代理已全量复核并逐一闭环落地。
