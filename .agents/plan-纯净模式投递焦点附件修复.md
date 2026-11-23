# 纯净模式：初始化投递 / 焦点隔离 / 附件双发 修复计划

## 目标（来自用户三个现象）
1. 初始化会话时提示词填进输入框却迟迟不发出。
2. 纯净模式上传附件偶发不成功，且原版网页输入区出现两份。
3. 纯净模式输入框打字，文字偶发跑进原版网页输入框。

## 已定位根因（含真机日志证据）
- R1 `overlay/chat-input.ts:377` `waitMs = tag === 'harness' ? 4000 : 0`：系统提示词的输入框等待窗口为 0，
  靠外层 500ms×30 硬重试；volcengine 日志 03:31:55→03:32:01 空转 5.37s（4 次「找不到输入框」）。
- R2 `session/project-context.ts:252` 在「投递到渲染进程」时就发 `framework-send('系统提示词')`，
  harness 立即显示「已发送，等待 AI 响应」，与事实不符（真正的投递信号是 bridge `onMessageDelivered`）。
- R3 `app/ipc/renderer.ts:120` `chat-insert-text` 注入前 `sender.focus()`；纯净模式下 AI 视图只是移到屏幕外
  （`entry.ts:540` 明确保持 setVisible(true)），所以仍可被聚焦 → 键盘焦点被抢走。
- R4 `app/ipc/harness.ts:300` 停止后 `wc.focus()`；`session/project-context.ts:143` 选目录后
  `view.webContents.focus()`：纯净模式下同样抢焦点。
- R5 `app/ipc/cdp-attach.ts` 文件已注入但「就绪判定」失败时仍返回 `success:false`，
  `harness.ts:579` 无条件走 `attachFn` 兜底再注入一次 → 同一文件两份。
- R6 `ui/harness.html:5200` 附件等待硬编码 15s，而单文件 CDP 兜底链路可达 ~19.5s（3 轮×2.5s + 12s 就绪），
  超时后提示失败但后台其实已注入 → 用户重试再得一份。

## 改动项
1. `overlay/chat-input.ts`
   - 系统提示词在冷启动首次尝试给 10s 输入框轮询；其余框架消息保持 0ms（靠外层重试），harness 4s。
   - 重试时若输入框内容已等于目标文本，跳过多万字重复灌注。
   - 页面无键盘焦点（纯净模式）时跳过 `insertTextToChat` 原生通道；停止无谓的 `input.focus()`；
     contenteditable 清空改用 Range 精确定位，避免 `selectAll` 选中整页。
   - INITIAL_PROMPT_MAX_ATTEMPTS 30 → 8（单次等待变长后不再需要 30 次）。
2. `app/ipc/renderer.ts`
   - `chat-insert-text` / `chat-send-enter`：窗口处于纯净模式时直接返回 false（让页面侧走 DOM 填充/点击），
     绝不 `sender.focus()`。
3. `app/ipc/harness.ts`
   - 停止：纯净模式不 `wc.focus()`，结束后把焦点还给 harness；Escape 兜底改页面内合成事件。
   - attach：`cdpAttach` 返回 `injected` 时不再走 `attachFn` 兜底（只在未注入时兜底）。
4. `app/ipc/cdp-attach.ts`
   - `AttachResult` 增加 `injected`；两条「已注入」返回路径带上该标志。
   - 就绪判定追加「file input 已被站点清空」这一通用信号，减少误判。
5. `session/project-context.ts`
   - 提前那条 `framework-send` 改为 `framework-preparing`（文案「正在准备…」，仍置 busy 防插话）。
   - 选目录后的焦点恢复优先给 harness。
6. `ui/harness.html`
   - 处理 `framework-preparing`（复用 onFrameworkSend 的文案分支，不建空气泡）。
   - 附件等待超时按文件数放大（20s + 18s×N），避免「假失败」诱导用户重复添加。

## 完成标准
- `npm run typecheck`（tsc）通过。
- 现有测试全绿（含新增回归用例）。
- 三个现象对应的代码路径逐一自检：初始化不再空转、纯净模式零主动抢焦点、附件单次注入。
- changelog 记录版本与修复点。

## 实施结果（2026-11-22）
版本 0.10.231，分支 `feat/126-volcengine-web-integration`。

改动 7 个文件：
- `src/overlay/chat-input.ts`：`initialPromptColdWaitUsed` 冷启动 10s 窗口、`pageFocused` 决定是否走原生注入、`alreadyFilled` 幂等、重试上限 8、Range 精确清空、`cancelInitialPrompt` 复位标志。
- `src/app/ipc/renderer.ts`：新增 `isHarnessActive()`，`chat-send-enter` / `chat-insert-text` 在纯净模式直接返回 false。
- `src/app/ipc/harness.ts`：`stopGeneration` 纯净模式不聚焦 + 页面内合成 Escape；`attachFn` 同名附件幂等守卫（跳过可编辑元素，避免正文误判）；`harness-attach` 对 `injected` 记成功并 `continue`。
- `src/app/ipc/cdp-attach.ts`：`AttachResult.injected` 契约、file input 打标记 + 「已被站点清空」就绪信号、两条注入路径回传 `injected:true`。
- `src/session/project-context.ts`：提前事件改 `framework-preparing`、选目录后焦点优先给 harness、日志文案改「已下发（等待页面输入框就绪）」。
- `src/ui/harness.html`：`framework-preparing` 准备态（不建空气泡）、附件等待 `20000 + 18000 * files.length`。
- `test/overlay/chat-input.test.js`：新增 3 条回归用例（纯净模式跳过原生注入且不 focus、网页模式仍走原生注入、目标内容已就位时跳过重复灌注）。

验证证据：
- `npm run typecheck` 0 错误。
- `npm test` 151 文件 / 1538 用例全绿（49.2s）。
- 中途一次回归已修：把非系统提示词统一提到 1200ms 导致 `test/bridge/intercept/observer.test.js` 超时，回退为 0ms 后该文件 8.4s 通过。
- 真机附件链路需手动验（`cdpAttach` 依赖 `webContents.debugger`，单测无法覆盖）。

未覆盖风险：
- `chat-insert-text` 依赖 `win.__ckHarnessVisible`，若纯净模式开关与窗口状态不同步，会退回原生通道（日志可查 `isHarnessActive` 分支）。
- `attachFn` 的 `injected` 直接信任 CDP 结果，若站点随后静默丢弃文件（无缩略图且清空 input 属误判），会得到一份未就绪附件；`waitComposerReady` 的 12s 与 UI 20s 之间仍有窗口。

## 自审记录（对项目审计 checklist）
1. 未弱化测试：仅新增 3 条断言真实行为的用例，未有跳过/硬编码；`observer.test.js` 超时问题靠回退实现解决，未改断言。
2. 改动最小化：`AttachResult` 只加可选字段（不破坏契约）；`chat-send-enter` / `chat-insert-text` 行为变化仅在纯净模式；`onFrameworkSend` 加可选参数。
3. 边界与异常：`isHarnessActive` / `document.hasFocus` / `ctx.win` 均有 try-catch 或兜底；`alreadyFilled` 不匹配时退回正常填充。
4. 并发：初始提示词仍由 `initialPromptRun` 串行化，冷启动标志只在 `cancelInitialPrompt` 复位。
5. 安全：新增注入脚本全部为常量字符串，无文件名/用户内容拼进 JS。
6. 命名与注释：`isHarnessActive`、`AttachResult.injected` 带 JSDoc；关键判断均有「为什么」注释。
7. 性能：10s 冷等待仅一次；其余标签维持 0ms；幂等守卫最多上溯 12 层。
8. 焦点主链路未受影响：发送优先走 `simulateMouse`（视图内坐标 `sendInputEvent`），与视图是否离屏无关；键盘仅作兜底。


