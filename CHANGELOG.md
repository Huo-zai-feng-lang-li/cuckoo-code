# Changelog

## [Unreleased]

## [0.10.20] - 2026-10-18

### Fixed

- **停止生成「假成功」**（严重，`src/app/ipc/harness.ts`）：`stopGeneration` 原实现只要定位到按钮坐标就返回 `success: true`，不校验是否真的停住。手机端据此显示「已停止」，实际 AI 仍在跑。修复：点击后等 400ms 重新定位校验，失败重试一次，仍失败返回 `still-generating`，手机端走「停止未生效」提示。
- **空闲时点停止会误发消息**（严重，`src/providers/deepseek.ts`）：DeepSeek 输入区主按钮是同一个元素——生成中显示方块图标（可停止），空闲时显示箭头图标（= 发送按钮）。原通用定位逻辑按类名选中就点，空闲时等于**替用户把输入框内容发了出去**。修复：新增 `getStopFn()`，按 SVG path 区分（方块 `M2 4.88` / 箭头 `M8.3125`），空闲态直接返回 `generating: false` 不点击。
- **CDP 点击停不住 DeepSeek 的流**（`src/app/ipc/harness.ts`）：真机取证发现 `Input.dispatchMouseEvent` 点击后按钮图标变回箭头，但 AI 流仍在继续（8 秒 +59 帧）。改用**页面内合成 PointerEvent 序列**（实测 8 秒仅 +4 帧）才真正停流。
- **通用停止定位回退路径被误判失败**（`src/app/ipc/harness.ts`）：`attachStopFn` 返回值不含 `generating` 字段，最初校验条件 `again.generating === false` 永远为假，会把其它能正常停止的平台误判为 `still-generating`。已按定位函数是否具备 generating 语义分流校验。
- **移除 `attachStopFn` 的页面内合成点击**：同一次停止被点两下会干扰按钮状态判断，改为只返回坐标。

### Changed

- **新对话初始化提速**（`src/app/ipc/shell.ts`）：原实现 `did-finish-load` 后固定等 400ms 再走 `initProject`（等首屏渲染稳定）。但 DeepSeek 首页输入框通常在 100~300ms 内就出现，白等 100-300ms。改为轮询检测 `textarea`（每 100ms，最多 1.5 秒），出现即走初始化。实测本地代码耗时从 ~450ms 降到 ~51ms。
- **截断重发激活提速**（`src/app/ipc/harness.ts`）：`activateShareSession` 原实现首轮就 `await 800ms`（分享页可能早已就绪），且轮询粒度 800ms 太粗（变活平均等 2-3 秒）。改为首轮立即检查 + 之后 300ms 一轮，上限从 15 轮提到 40 轮（总时长仍约 12 秒）。
- **IDB 重建轮询提速**（`src/session/compaction.ts`）：`waitForIdbMessages` 轮询间隔 200ms → 150ms。
- **压缩后初始化提速**（`src/session/compaction.ts`）：`checkPendingInit` 原实现固定等 3 秒（等分享页渲染稳定），但实测分享页渲染通常 <1 秒。改为轮询检测输入框就绪（每 200ms，最多 3 秒）。实测省 2.4 秒。
- **压缩摘要被过度截断**（`src/session/compaction.ts`）：`MAX_SUMMARY_LEN` 从 3000 提到 5000。
  - **历史误判纠正**：曾因"44246 长度提示词被 DeepSeek 拒绝"把上限压到 3000，但真机复查发现那次拒绝是**高频请求限流**（3 秒内连发 3 次），与长度无关——47175 长度（含 3000 摘要）多次成功发送，32432 长度在限流时同样报错。
  - 3000 的代价：实测长会话生成 5757 字摘要被砍到 3002（**丢 47.9% 信息**），导致续接会话丢失前情。改为 5000 后，常态摘要（实测 3540 字）完整保留，仅极端长会话（5757）才裁掉 757 字。
  - 安全性：基础提示词 44100 + 5000 摘要 = 49100，仅超实测成功线（47175）2000，风险可控（8000 会到 52100，超 5000 且未验证，故不采用）。
- **新增压缩摘要总长度动态保护**（`src/session/compaction.ts`）：`checkPendingInit` 里若 `基础提示词估算(44100) + 摘要长度 > 49500`，自动按剩余空间缩减摘要（至少保留 2000 字），防止未来项目文件膨胀导致总长超限。

## [0.10.19] - 2026-10-18

### Fixed

- **截断重发时同一消息被重复发送 3~4 次**（严重）：`activateShareSession` 每 800ms 一轮、最多 6 轮，每轮只要分享页 textarea 就绪就发 `harness-user-message`。分享页克隆成活会话需 2~3 秒，循环在变活前已发送 3~4 次 → 用户导航栏出现多个相同消息。修复：加 `sent` 标志只发一次；轮次上限 6→15，之后仅轮询 URL 等变活。
- **AI 生成中切到其他窗口再切回，不自动滚到底部**（严重）：`stream` 的 `scroll` 事件无条件 `pinBottom = isNearBottom()`。流式输出使 `scrollHeight` 持续增长 → 浏览器派发 scroll 事件（`scrollTop` 未变）→ 距底变远 → `pinBottom` 被自己踩成 false → 切回时 `if (pinBottom)` 不成立、不滚底。修复：记录 `_lastScrollTop`，仅当 `scrollTop` 变小（用户真的上滚）才置 false；内容增长导致的被动 scroll 保留原状态。
- **点右侧导航条目跳转失效**：`settleScrollBottom` 的后续 `step()` 会把 `scrollTop` 又拉回底部，覆盖 `fastScrollTo`。修复：`fastScrollTo` 开头先中止 settle（`_settleGen++` + 清 timer/listener + `resetExpectVars()`）。
- **点导航完全无反应（隐藏页面）**：`document.hidden` 时 rAF 被浏览器挂起，`fastScrollTo` 动画永不执行。修复：`hidden` 时直接 `scrollTop = target`。
- **删除 / 保存修改后不滚到底部**：补 `pinBottom = true; settleScrollBottom(true);`。
- **隐藏页面下 `scrollBottom` 死锁**（严重）：`_scrollRaf` 是"本帧已排"的合并标记，页面 `document.hidden` 时 rAF 被浏览器挂起、永不回调 → `_scrollRaf` 永不为 null → 后续所有 `scrollBottom` 调用全部 return，流式滚底彻底失效。修复：`hidden` 时直接同步写 `scrollTop`，跳过合并/动画。
- **隐藏页面下 `resize` 的 `suppressPin` 永久卡住**（严重）：同样因 rAF 挂起，`suppressPin = true` 后永不复位 → 之后所有 `scroll` 事件被短路、`pinBottom` 再也不更新。修复：`hidden` 时同步完成，不设 `suppressPin`。
- **隐藏页面下导航 active 高亮不更新**：`scheduleConvNavActive` 用 rAF 节流，`hidden` 时不触发。修复：`hidden` 时降级到 `setTimeout`（100ms）。
- **`_lastScrollTop` 声明位置修正**：原声明在 scroll 事件监听处（`:4851`），但 `scrollBottom`（`:2733`）内部也引用它，若在初始化期间先调用 `scrollBottom` 会读到 `undefined` 导致比较异常。已提到 `pinBottom` 声明旁（`:2747` 附近）。

### Changed

- **移除「仅保存 / 保存修改」按钮**：该按钮只改 DOM + localStorage，**AI 服务端上下文完全不变**——用户改了 AI 也不知道，下次引用历史仍是原文，无实际意义。移除后历史消息编辑只保留「取消 / 填入输入框 / 从此处截断重发」；最后一条已完成消息保留「取消 / 从此处截断重发」；待发送消息保留「取消 / 重新发送」。`Ctrl+Enter` 在历史消息上改为触发截断重发（原为 `doSaveOnly`）。

### Added

- **hover 右侧对话导航自动滚到底部**：`mouseover` 检测到进入 `.conv-nav` 区域即 `settleScrollBottom(true)`，展示最新消息。导航面板是 fixed 定位，不随内容滚动，hover 滚底不影响后续点选历史锚点。

## [0.10.18] - 2026-10-18

### Fixed

- **截断重发后资源管理器显示"未选择"**：截断会激活出**新 sid**，但流程没把当前项目目录绑到新会话 → `handleUrlChange` 里 `getProjectDirBySessionId(newSid)` 返回空 → `selectedProjectDir = null`。修复：`harness-truncate` 记住当前目录（内存局部变量），`activateShareSession` 检测到变活后显式 `saveSessionDirMapping(newSid, projectDir)` 并广播 `shell-project-dir` 事件。
  - 踩坑记录：曾尝试用 `state.pendingProjectDir` 兜底，但截断流程中途会**刷新页面重建 IDB**，刷新后 URL 仍是原会话 → `pendingProjectDir` 被消费并绑到**旧 sid**，等变活成新 sid 时已空。必须显式绑定。
- **最后一轮已完成的消息编辑缺少"从此处截断重发"**：原 `isLatestUserMessage` 只判断"后面有无更晚的 user"，导致最后一轮已完成（有 assistant 回复）的消息也只能"仅保存/重新发送"。语义上改这一轮等价于"改历史分支"，应允许截断重开。
  - 修复：`editUserMessage` 增加 `hasRepliedAfter` 判定（最后一条 user 后面是否已有 assistant），三态区分：
    - 历史中间消息（有更晚 user）→ 取消 / 填入输入框 / 从此处截断重发 / 保存修改
    - 最后一轮已完成（有 assistant 回复）→ 取消 / 仅保存 / 从此处截断重发
    - 真正待发送（刚发出未回复）→ 取消 / 仅保存 / 重新发送

### Added

- 新增测试：历史消息编辑三态按钮组（中间/已完成末轮/待发送）

## [0.10.17] - 2026-10-18

### Fixed

- **会话切换后纯净模式历史不加载**（严重）：`notifyHarnessSession` 与 `harness-ready` 补发时仅用 `ctx.providerId` 取 provider，该字段未设置时 `sid` 恒为空，导致 harness 永远拿不到当前会话、历史一片空白。已补 `getProviderByUrl(url)` 兜底。
- **子代理 maxTurns 达到后不真正停止**：原实现只上报 `partial` 而不阻断后续流程，实测 `maxTurns=1` 仍跑 3 轮才结束。现加 `stopped` 标志 + `cancelPendingSend` + `requestAbort`，日志验证触发后立即中止。
- **纯净模式滚底 `suppressPin` 永久卡住**：页面 `document.hidden` 时 rAF 被浏览器挂起，`settleScrollBottom` 的多帧循环永不推进，`suppressPin` 长置 true。改为 `hidden` 时一次性完成（`scrollTop = scrollHeight`），不进入多帧循环。
- **右侧对话导航 hover 强制滚底**（反 UX）：原实现 hover 右侧导航立刻 `scrollBottom(true)`，用户根本点不到想跳的历史消息。已移除该行为，hover 保持原位置。
- **压缩丢 `projectDir`**：`triggerCompaction` 取 overlay 内存 `state.currentProjectDir`，刷新/导航后为空 → 压缩段3 `initProject` 拿不到目录。改为主进程 `sessionStore.state.selectedProjectDir` 直传给 bridge，再由 bridge 传给 `triggerCompaction`。
- **压缩摘要超长被服务端拒**：`MAX_SUMMARY_LEN` 8000 → 3000。基础提示词约 40.5k 字符，加上 8000 字摘要即触碰 DeepSeek 拒绝边界。
- **压缩段3 过早清 localStorage**：`checkPendingInit` 读到 pending 立即 removeItem，若 `initProject` 失败则摘要/目录永久丢失无法重试。改为 initProject 成功回执后再清。
- **截断重发迟到回执被丢弃**：长历史下快路径可能 >60s 超时，此时回执到达因 `truncatePending` 已空被静默丢弃。已加 `truncateLateHandler`，超时后仍能完成导航+激活；同时超时 60s → 120s。
- **截断重发慢**：`activateShareSession` 原用 `waitForLoad(15000)`，但 `loadURL` 已 await 完成，did-finish-load 事件早已过去 → 白等 15 秒。改为 6 次 × 800ms 轮询检查 textarea 就绪，激活成功耗时从 17s 降至 ~5s。
- **历史消息"保存修改"缺失**：历史消息编辑栏只有"取消/填入输入框/从此处截断重发"，用户只想改错别字保存无从下手。新增"保存修改"按钮（`doSaveOnly`），更新 DOM + `histItem.text` + `saveHistory`。
- **截断重发本地降级**：无 `webMsgId`（纯净模式首条 / 无网页记录）时原实现直接 `cancel()` 丢弃用户输入。改为回退本地物理截断：`truncateUserMessage` 清历史 → 新文本入输入框 → `send()`。
- **目标迭代始终显示 0**：`round` 语义为"自动续跑次数"，AI 靠工具循环跑完不触发 nudge → 恒定 0。改为"当前第 N 轮"语义，起始 1，`renderGoalMeta` 兜底 `Math.max(1, ...)`。
- **空白气泡/空 pre 残留**：流式渲染剥离工具块后 `renderMarkdown('')` 产生 `<pre><code></code></pre>`，深色主题下呈空黑框。新增 `removeEmptyPres` 在流式/收尾/历史恢复三处清理；无正文时隐藏 body 容器。
- **删除工作区 localStorage 缓存残留**：删除工作区只清主进程账本，harness 的 history/goal/plan 缓存永久驻留。`deleteProjectWorkspace` 现返回被删 sessionId 列表，UI 侧逐个清理三 key。
- **会话标题更新后侧栏不刷新**：`set-session-title` 处理完未广播 `shell-sessions-changed`，跨视图联动存在盲区。

### Added

- **子代理 partial 上报**：达 `maxTurns` 截断时主对话收到 `[子代理达到轮次上限，以下为部分结果]` 前缀，避免把半截当完整结论。
- **远程 PWA 同步过渡态**：连接建立但历史尚未到达时显示"正在同步对话…"，8 秒兜底解除，避免用户误以为卡在首页。
- **远程空 history 回执**：harness 未创建 / 导出超时 / 无可用窗口时也回一条空 `history`，客户端立即解除同步态。
- **远程用户消息入历史**：`case 'user'` 原仅 `addUser` 渲染 DOM 未 `pushHist`，手机重连补发历史时看不到自己发过的话。已补 `pushHist` 并传 `histItem` 供删除/编辑引用。
- **工作区信任门**：新建对话到含 `.agents` 工件的目录时弹三按钮确认框（信任并启用 / 仅本次会话 / 不信任）；`harness-ready` 路径对已信任目录短路不弹。未信任时项目级 MCP / 规则 / 技能 / 子代理均不注入。
- **目录信息增强**：`getDirInfo` 现返回 `createdAt` + `source`（session/dir），优先取该目录下最早会话的 `createdAt`，老数据回落磁盘 `birthtime`。
- **工具计数泄漏自愈**：`scheduleGoalNudge` 遇忙不再直接丢弃，改为指数退避重试（上限 12 次）；`onTaskIdle` 遇 `toolRunningCount > 0` 也调度续跑兜底。
- **历史恢复未收尾工具落终态**：`success === null` 的工具卡片渲染为"上次会话中断，工具未执行完成"，不再是永久"运行中"。
- **自动滚底（081）**：切回窗口时若在底部附近且内容变高则平滑滚底；离开时在翻历史则不动。新增 `src/bridge/scroll-follow.ts`（含 `shouldFollowToBottom` 纯函数便于单测）。

## [0.10.16] - 2026-10-18

### Fixed

- **纠正 v0.10.15 的严重误杀**：v0.10.15 中错误地加入了 `stopBySource('ai')`，导致用户点停止时，会把正在运行的 `npm run dev` 后台任务也杀掉。本版本已彻底移除该逻辑，明确边界：**只杀阻塞当前对话的前台进程，保留有独立生命周期的后台任务。**

## [0.10.15] - 2026-10-18

### Changed

- **停止/发消息时，彻底清理所有相关后台任务**：
  - `abortWindowWork` 中增加了 `stopBySource('ai')`。这意味着，当你点击停止或发送新消息时，AI 之前通过 `bash background:true` 拉起的后台长驻任务（如 dev server、watch 等）也会被全部强制终止。

## [0.10.14] - 2026-10-18

### Fixed

- **纠正 v0.10.13 的遗漏**：v0.10.13 虽然实现了 `process-tracker`，但在给 `harness-send`（发送新消息）添加前置强杀逻辑时，因正则匹配失败导致代码未落地。本版本已补全：发送新消息时会调用 `abortWindowWork(ctx)` 强杀上一轮的 bash/pwsh/grep 等残留进程。

## [0.10.13] - 2026-10-18

### Fixed

- **彻底修复“停止”和“发新消息”时工具进程未中断**：
  - 新增 `src/infra/process-tracker.ts` 全局追踪主进程 spawn 出来的系统进程（bash/cmd、pwsh、rg）。
  - `harness-stop` 时调用 `abortWindowWork`，强杀属于该窗口的 bash/pwsh/grep 等进程树，同时杀 JS worker。
  - **发送新消息时**，也会先触发 `abortWindowWork`，强制结束上一轮还在后台跑的残余任务，防止并行冲突。
  - 统一了 Unix 下的进程组强杀逻辑（复用 `killProcessTree`，防止孙进程孤儿化）；修复了窗口销毁时的全局误杀问题。
  - `grep.ts` 增加 abort 标志，避免超时被强杀后重复抛出无用错误。

## [0.10.12] - 2026-10-18

### Fixed

- **纠正 v0.10.11 的回归**：v0.10.11 在 `killWorker` 和 `child.on('exit')` 中误清了 `activeWorkerPid`，破坏了 `JsRunner.Process.test.js` 的探活断言（`activeWorkerPid` 的语义是"最近一次 run 的 pid"，用于测试和诊断，不应在结束时清空）。本版本恢复该字段的保留语义。

### Note

- v0.10.11 已推送但测试未通过（1 例失败），请使用 v0.10.12。

## [0.10.11] - 2026-10-18

### Fixed

- **点击停止后工具仍在后台执行**：
  - `JsRunner` 新增 `abortAll(windowId)`：在 Windows 下通过异步 `taskkill /T /F` 强杀 worker 进程树（解决 `require` 未定义、`execSync` 阻塞主进程、并发互相覆盖、全局误杀等问题）。
  - `harness.ts` 的 `stopGeneration` 中主动调用 `abortAll`，并在顶部静态 import 消除 ESM 混用隐患。
  - `grep.ts` 的 `runRipgrep` 增加 60 秒兜底超时，防止 rg 卡死导致主进程假死。
  - `harness.ts` 补全 `loadURL` 的 `.catch`，避免未捕获的 Promise 拒绝。

## [0.10.10] - 2026-10-18

### Fixed

- **点击停止后工具卡片卡在“运行中”**（`src/ui/harness.html`）：`stop()` 函数此前只重置了 `toolRunningCount` 和清理了助手气泡，但没处理已经渲染在 DOM 里的工具卡片。导致点击停止后卡片永远显示“运行中”。
- 修复：`stop()` 中增加遍历 `.tool-badge.run`，将其改为“已停止”并显示“（用户手动中止）”，卡片自动折叠。

## [0.10.9] - 2026-10-18

### Fixed

- **思考字数统计不准**（`src/ui/harness.html`）：原使用 `think.length` 统计，英文按字母算、符号和空白也计数，导致纯英文的 15 个单词显示成 78 字。新增 `countThinkChars()`：中文按汉字数、英文/数字按单词数统计，忽略标点和空白。

## [0.10.8] - 2026-10-17

### Added

- **右侧对话导航新增悬停交互**（`src/ui/harness.html`）：鼠标悬停在右侧导航区域时，自动强制滚动到对话最底部，方便快速查看最新消息。使用 `mouseover` 事件代理，避免导航内部移动时重复触发。

## [0.10.7] - 2026-10-17

### Performance

- **修复"任务页切 tab 卡顿"**（`src/ui/shell/scripts/pages/tasks.ts`）：原每次切回都会重走 `taskList` + `taskReadScripts`（读 package.json 解析）+ 全量重建脚本按钮 DOM 并逐个 addEventListener。现新增 `loadTasks({ force })` + `tasksLoaded` 标志，切 tab 直接跳过；任务变更事件 / 启动 / 停止 / 移除 / 刷新 / 清空走 `force: true`。

### Fixed

- **Git 页缓存判断缺陷**（`src/ui/shell/scripts/pages/git.ts`）：原用 `lastItems.length > 0` 判断缓存，项目无改动时 `lastItems` 为空，会漏掉缓存直接重走 IPC。改用独立 `gitLoaded` 标志位，覆盖"无改动"场景。

### Verified

- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移

## [0.10.6] - 2026-10-17

### Fixed

- **修复 CI 的 Coverage 工作流失败**：
  - `.github/workflows/coverage.yml`：在跑测试前增加 `npm run compile`。原流程直接跑测试，导致 `JsRunner.WorkerPath.test.js` 找不到 `out/` 编译产物（`ERR_MODULE_NOT_FOUND`）。
  - `src/remote/tunnel.ts`：`buildCloudflaredCandidates` 构造 Windows 路径改用 `path.win32.join`。原用 `path.join`，在 Linux CI 环境下拼接出混用正反斜杠的路径，导致 `cloudflared-path.test.js` 断言失败。

## [0.10.5] - 2026-10-17

### Performance

- **修复"Git / 对话列表"页切 tab 卡顿**（`src/ui/shell/scripts/pages/git.ts` + `conversations.ts`）：
  - **Git 页**：原每次切回都会重新走 `gitStatus` IPC 拉取改动并重建列表 DOM。现新增 `loadGit({ force })`，默认走缓存直接渲染（`lastItems`），只有 watcher 变更、项目切换、手动操作才 `force: true` 拉取。
  - **对话列表页**：原每次切回都会跨进程扫描 AI 网页 DOM 取会话列表。现新增 `force` 参数，非强制且已有列表节点时跳过 IPC，仅刷新禁用态。导航/新建/刷新仍强制拉取。

### Fixed

- **修正 v0.10.4 的发布记录**：v0.10.4 仅包含版本号与 CHANGELOG 的变更（实际修复未落地，脚本报错导致编辑丢失）。真正的修复在 v0.10.5 中。

### Verified

- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移

## [0.10.4] - 2026-10-17

> ⚠️ 本版本为空版本（仅版本号与 CHANGELOG 变更，Git / 对话页性能修复未落地）。请使用 v0.10.5。

## [0.10.3] - 2026-10-17

### Performance

- **修复"任务菜单切到源代码菜单卡顿"**（`src/ui/shell/scripts/pages/files.ts` + `preview.ts`）：
  - **切 tab 复用缓存**：原每次切回「文件」都重新走 IPC 扫描整个项目目录树；现缓存命中直接渲染，只有刷新按钮 / 增删改 / 项目切换才强制拉取（`loadFiles({ force: true })`）。
  - **目录展开/折叠不拉 IPC**：原每次点击目录都会重新扫描整棵树；现只重渲染缓存（展开状态本来就在内存里）。
  - **预览恢复不重读文件**：新增 `showPreviewLayout()`，切回「文件」只恢复显隐与宽度，文件内容一直在编辑器里（`restorePreview` 改调它）。
  - **大项目分帧渲染**：节点数 > 300 时先插入"加载中…"占位，`requestAnimationFrame` 再真正渲染，避免一次性重建数千 DOM 阻塞主线程。

### Changed

- **默认暗色首帧**（`src/ui/shell/index.html`）：新增 `<meta name="color-scheme" content="dark light">` 与 `<body data-ck-dark>`，首帧直接暗色渲染，避免"先白屏再变暗"的闪烁；原生控件（select 下拉、滚动条）跟随暗色。

### Verified

- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移

## [0.10.2] - 2026-10-17

### Changed

- **更新弹窗改回系统原生对话框**：需求 077 曾把更新确认从 `dialog.showMessageBox` 改为自绘浮窗（品牌头/版本跃迁/日志列表/实时进度条），但需求 068 已明确划定边界——**模态决策对话框保持系统原生，自绘仅用于被动通知**。本次回退到原生（屏幕中央、跟随父窗口），符合 068 原始设计：
  - `update-available`（发现新版本）、`update-downloaded`（更新已就绪）、`checkForUpdates`（已下载待安装）、`showUpdateErrorDialog`（更新失败重试）四处全部恢复原生对话框
  - 下载进度仍由**壳页面状态栏**实时展示，弹窗内不再渲染进度条
  - 新增 `showNativeDialog()` 统一封装（含 macOS 必须传 parent 的处理）

### Performance

- **安装包体积从 344.61 MB 降至 182.04 MB（-47%，省 162.57 MB）**：
  - `!node_modules/monaco-editor/**`（97.09 MB）：monaco 只通过 `src/ui/vendor/monaco/vs`（AMD loader 加载）使用，npm 包本体从未被 `require`（grep `out/src` 零引用）。
  - `!out/src/ui/vendor/monaco/**`（54.89 MB）：**死代码**。无任何构建脚本生成、无任何代码/HTML 引用（`findstr` 全仓零命中），且与 `src/ui/vendor/monaco` 内容 hash 不同（旧残留）。`src/ui/vendor/monaco`（24.38 MB，139 个文件）完整保留，是 shell.html `vendor/monaco/vs/loader.js` 的实际来源。
  - `!out/**/*.map`（27.78 MB）+ `!node_modules/**/*.map`（6.13 MB）：sourcemap 仅调试用，运行时不需要。
  - `!node_modules/**/*.ts|mts|cts`（3.71 MB）：第三方包的 TypeScript 源码，运行时只用编译后的 .js。

### Removed

- **删除自绘确认框遗留三件套**（回退原生后无调用方）：`src/app/confirm-window.ts`、`src/app/confirm-preload.ts`、`src/ui/confirm-window.html`（约 32 KB）
- **删除 `src/updater/index.ts` 中 4 个死函数**：`escapeHtml`、`htmlToText`、`extractReleaseNotes`、`formatSize`（原本仅供自绘弹窗渲染版本号/更新日志/体积）

### Verified

- asar 关键运行时资源逐项核对：monaco loader/editor.main/editor.worker、marked.umd.js、cuckoo-sanitize.js、shell/harness.html、entry.js、js-sandbox-worker.mjs、prompt md、assets/icon.png、katex 62 个、notif-images 27 个、enhance-images 9 个、remote/pwa 6 个、resources/runtime 16 个 —— **全部保留**。
- 打包版实测启动：platform-select / shell / harness 页面均从 `app.asar` 正常加载，CDP 可访问。
- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移。

## [0.10.1] - 2026-10-17

### Fixed

- **打包版 AI 执行 JS 代码块 100% 失败（v0.10.0 阻塞级回归）**：A-005 把 JsRunner 迁到 `child_process.fork` 独立进程后，worker 脚本 `js-sandbox-worker.mjs` 被打进 `app.asar`。但 fork 启动的是**原生 OS 进程**，操作系统不认识 asar 虚拟路径（不透明映射仅 Electron 内建模块享有），实测直接 `MODULE_NOT_FOUND` 崩溃。修复：① `build.asarUnpack` 增补 `**/js-sandbox-worker.mjs`，打包时解到 `app.asar.unpacked/`；② `JsRunner` 新增 `resolveWorkerPath()`，fork 前把路径中的 `app.asar/` 映射到 `app.asar.unpacked/`；③ 新增 6 例回归测试锁定（Windows/POSIX 路径、开发态原样、幂等、空输入、非目录段不误伤）。实测：unpacked 路径 fork 成功存活，asar 内路径 `exists=false` 崩溃。
- **安装包瘦身（v0.10.0 遗漏）**：`build.files` 补排除 `.archify`/`.codegraph`/`.cuckoo`/`.cuckooCode`/`eslint-rules`/`examples`/`release-notes`/`templates`/`wyp` 与 `src/**/*.ts`（源码 + 代码图谱 DB 11 MB + 截图日志 12.7 MB 不再进包）。`app.asar` 从 352.49 MB 降到 343.28 MB。

## [0.10.0] - 2026-10-17

本版本是一次**全量安全加固**（分支 `fix/security-bug-sweep`）。对全项目做了只读安全审计（5 路分片 + 独立复核），确认 **59 条 bug（P0 致命 4 / P1 高危 15 / P2 中危 17 / P3 低危 23）全部修复或逐条给出不改结论**，并复核了 17 条置信度不足的推测项。审计证据见 `docs/audit/`。新增 150+ 条回归测试，全部 PoC 复跑确认。

### Security

- **X-001（P0，跨模块）修复"任意网页可零确认执行命令"**：AI 工具执行通道此前不校验调用来源。建立三层防线——① 主进程 IPC 对 `execute-tool` / `execute-js` / `execute-command` 等执行面做 **host 白名单 + sender 校验**（仅 registry 注册的 provider 域名与自有窗口可调用，`src/app/ipc-guard.ts`）；② 高危投递特征族（PowerShell `-enc`、`iex`、`curl|iex`、`certutil`、`bitsadmin`、写启动项、反弹 shell 等）在**任何执行模式下都于主进程弹确认**，确认框默认聚焦"取消"（`src/infra/dangerous-commands.ts`）；③ 设置页新增**三档执行策略**（智能 / 工作区信任 / 严格，见下）。
- **A-001（P0）webFetch SSRF 302 重定向往内网**：改为手动逐跳重定向，每一跳都重新过 SSRF 守卫，落到内网/回环/云元数据即 fail-closed，不再盲跟 `Location`（`src/tools/impl/WebFetchTool.ts`）。
- **A-002（P0）SSRF IPv6 / 进制写法绕过**：`http://[::ffff:7f00:1]`、`0x7f000001`、十进制整数、尾点等写法经 WHATWG URL 归一化后按解析结果判定，IPv4-mapped IPv6 十六进制不再直穿（`src/infra/ssrf-guard.ts`）。
- **A-003（P1）主机名大小写 / 尾点绕过**：host 判定统一小写归一化并处理尾点。
- **E-001（P0）MCP 面板 server 名 DOM XSS → executeJs → RCE**：项目 `.agents/mcp.json` 的 server 名未转义拼进 innerHTML，克隆恶意仓库即可植入。内容位与属性位统一转义（`src/overlay/panels/mcp-manager.ts`）。
- **E-002（P1）harness 渲染 AI 回复 marked 无消毒**：新增**零依赖单一真源白名单 sanitizer** `src/overlay/sanitizer.ts`，构建产物 `src/ui/vendor/cuckoo-sanitize.js`；harness 渲染管线在 `marked.parse` 之后、KaTeX 恢复之前做 sanitize（保留 class/aria-*/data-*），shell 与 overlay 共享同一真源。`<img onerror>`、`<script>`、`javascript:` 链接等一律清除。
- **E-003（P1）窗口管理面板 profile 名 / 平台名 / id 注入**：内容位与属性位统一转义。
- **E-009（P3）自有窗口补 CSP**：harness / shell / alert / confirm / notification / platform-select 加 CSP meta（`object-src/base-uri/frame-src` 收紧；shell 因插件 `new Function` 与 Monaco worker 额外放行 `unsafe-eval`、`worker-src blob:`）。
- **D-001（P1）插件市场点"安装"即主进程 RCE**：① 安装前在主进程弹第三方代码风险确认框（默认聚焦"取消"）；② **安装后默认禁用**（`setCuckooPluginEnabled(id,false)`），需用户手动启用；③ 新增 npm 包名规范白名单（拒绝 URL / git / file: / tarball / 参数 / 路径穿越），触达 npm 前拦截。
- **D-002 + D-004（P1）新增"工作区信任门"**：选择项目目录后，若发现 `.agents/mcp.json`、`.agents/rules`、`.agents/skills` 或 `.cuckoo/agents` 等工件，弹一次信任确认（默认聚焦"不信任"）。**不信任时项目级 MCP server 不 spawn、项目级规则 / 技能 / 子代理不注入系统提示词、`runAgent` 无法实例化项目级代理**；信任记录以原子写存于 `~/.cuckoo/trusted-workspaces.json`（支持本次会话 / 持久 / 撤销）；用户级 MCP / 规则 / 技能 / 代理不受影响。数据层扫描兜底，覆盖所有注入入口（含 JsRunner 按路径注入、cuckoo-host、harness 列举、project list/refresh、runAgent）。
- **D-003（P1）MCP HTTP server SSRF**：建立 `StreamableHTTPClientTransport` 前先 `assertUrlAllowed`，项目级内网 MCP URL 同样受约束；stdio 不受影响。
- **D-005（P2）远程服务 WS token 经 URL query 泄漏**：WebSocket 改走 `Sec-WebSocket-Protocol: cuckoo.<token>` 握手，手机端 PWA 预检/重连改用 `Authorization` 头（query 保留过渡兼容）。
- **D-006（P2）token 比较改常量时间**：`crypto.timingSafeEqual`（等长前置判断）。
- **D-007（P2）插件市场镜像源投毒**：curated 源结构化标注 provenance（官方 raw 优先；jsdelivr/ghproxy 等第三方镜像显式标注），缓存记录服务来源。
- **D-008（P2）下载重定向跟随**：Gitee 抓取改手动逐跳重定向（≤5 跳），每跳 Location 必须在 github/raw/codeload/objects/gitee 白名单。
- **D-010（P3）zip 解压路径穿越**：`safeEntryFilter` 增补 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名）逐段校验；符号链接/硬链接/绝对路径/`../` 穿越继续拦截。
- **E-008（P3）运行时下载无完整性校验**：`fetch-runtime` 下载 Node/uv 资产后做 sha256 校验（hash 取自官方 nodejs.org 与 astral-sh 校验文件），不匹配即删除并 fail-closed。
- **C-001/C-002/C-003（P1）存储非原子写可致数据静默丢失**：会话映射、profile、窗口分组等 8 处直接 `writeFileSync` 统一切到原子写（临时文件 + rename）+ 损坏时回退（`src/infra/atomic-json.ts`）。
- **A-006（P2）命令超时只杀 shell、孙进程孤儿化**：新增 `runCaptured` + 进程树回收（`taskkill /T /F` 树杀），并加 pid 探活；`bash`/`pwsh` 工具超时后连带杀死孙进程。
- **A-012（P3）命令里的密码明文进日志**：连接串 / `-p` 密码等做打码。
- **A-015（P3）todo 列表跨项目串桶**：按项目目录分桶存储。
- **A-S-1 / C-S-001 等推测项加固**：Node vm 沙箱隔离（见 A-005）、执行面 sender 系统性校验（见 X-001）。

### Added

- **设置页新增"安全·执行策略"与"受信任的工作区"两个卡片**：三档策略——**智能（默认，保持自动体验，仅高危投递特征弹确认）/ 工作区信任（按项目信任放行自动执行）/ 严格（每次执行都问）**；受信任工作区可查看与一键撤销。
- **A-005（P1）JsRunner 迁出主进程到独立 OS 进程**：AI 脚本改用 `child_process.fork` 在独立 worker（`src/tools/runtime/js-sandbox-worker.mjs`）的 vm 中执行，**异步微任务死循环不再饿死主进程**——主进程看门狗到点直接 `SIGKILL` worker 进程（PoC 实测：异步死循环 ~2.4s 返回超时、worker pid 探活 ESRCH 真死、主事件循环全程响应；同步死循环由 vm timeout 处理）。工具仍在主进程执行（worker 经 IPC 桥接），`currentWindowId`/项目目录/设置/长任务看门狗暂停语义全部保留；对外 `run()` 签名不变。
- **webFetch 内网守卫默认更严**：重定向、IPv6、进制写法全部归一化判定（见 A-001~A-003）。
- **Ctrl+N / Ctrl+Shift+N 快捷键新开对话**：Ctrl+N 新开对话，Ctrl+Shift+N 弹目录框选项目后新开对话。菜单 accelerator 在原生视图聚焦时不触发，故在 harness / AI 页面 `before-input-event` 双重拦截转给壳页面（`src/app/entry.ts`）。
- **左上角项目选择器改为"选目录 → 新开对话"**：不再在当前对话里改绑项目。新增 IPC `pick-dir-and-new-conversation`（带 `assertSenderOk` 来源校验），选目录期间显示 loading 遮罩，取消立即收起（`src/app/ipc/session.ts` / `src/ui/shell/scripts/toolbar.ts`）。
- **设置页去掉"保存设置"按钮，改即时保存**：任一表单项 change 即写入；带并发保护（保存期间再变更 → pending 补存），reset 期间屏蔽即时保存避免污染。设置项分组折叠（`src/ui/shell/scripts/pages/settings.ts`）。
- **默认启动进纯净模式 + 默认主题 dark**：平台已确定且非子代理窗口时创建后立即切 harness；主题默认值 runtime / proxy / harness 首帧三处对齐 dark（`src/app/entry.ts` / `src/plugins/runtime/theme-*.ts`）。

### Changed

- **插件安装后默认禁用**（原为安装即启用），需用户在面板手动启用；市场外手动包名安装额外弹确认。
- **项目级 MCP / 规则 / 技能默认不加载**，需先信任该工作区；用户级不受影响。
- **命令执行默认策略**：保持自动体验（智能档），仅高危投递特征强制确认——**不做"每条命令都问"**。
- **D-009**：远程 PWA 静态资源仍不鉴权（页面为无敏感数据的 UI 外壳，数据访问全走带 token 的 `/api` 与 `/ws`；加静态 token 会破坏分享链接流程）。
- **cloudflared 候选路径按可写性排序**（推测项 S-003）：`Program Files` / `LocalAppData` 优先，任意用户可写的 `C:\cloudflared` 根目录降为最后兜底。
- **插件自动更新防降级**（推测项 D-S-002）：依赖 `isNewer` 严格版本比较，补充回归测试。

### Fixed

- **A-004（P1）高危投递命令特征族**：扩充危险命令检测，覆盖 `-enc`/`iex`/`curl|iex`/`certutil`/`bitsadmin`/启动项/反弹 shell 等投递特征（中文描述命中即确认）。
- **A-007（P2）读取文件无大小上限**：读取加 200MB 上限，避免超大文件撑爆内存。
- **A-010（P3）非 UTF-8 输出致 fatal**：解码改为 fatal=false 容错并替换非法字节。
- **A-011（P3）引号外参数注入**：`Get-Content` 等命令参数正确加引号。
- **A-013（P3）grep 长输出未截断**：统一截断处理。
- **A-014（P3）glob 污染**：默认排除 node_modules 等依赖/产物目录并修 `--no-config`。
- **B-001（P1）失败重试倒计时切会话后污染新会话**：发送前复核会话，与 watchdog 对齐。
- **B-002（P1）Claude 流中断被误判为成功并执行截断代码**：正确识别错误终态并重试。
- **B-003（P2）DeepSeek 完成请求匹配无 host 白名单**：判定下沉纯函数并加 host 校验。
- **B-004（P2）流式截断的未闭合 cuckoo 块被 flush 后执行**：未闭合围栏不再提取为完整代码。
- **B-005（P2）XHR 观测路径无流静默看门狗**：补看门狗。
- **B-006（P2）残缺代码被重复执行 3 次**：语法错误不再重试，重试判定收紧。
- **B-007（P3）通知摘要正则写错吞掉字母 s**：`/\s+/g` 改正（误用为 `/s+/g`）。
- **B-008（P3）4 反引号围栏不识别**：围栏解析兼容。
- **B-009（P3）harness 流式剥离正则误伤普通代码块收尾围栏**：剥离规则修正。
- **B-010（P3）DeepSeek 发送按钮选择器宽泛且重复**：选择器收窄去重。
- **B-011（P3）executor 执行锁仅写不检**：加锁状态校验。
- **C-004（P1）上下文压缩配对错乱**：主链 walk 失败的回退分支过滤掉 branch 消息，严格 user→assistant 配对。
- **C-005（P2）get-dir-info 任意路径 stat**：收口到项目目录。
- **C-006（P2）文件 watcher 残留**：正确清理监听器。
- **C-007（P2）摘要未截断 / 插件注入主世界**：摘要长度截断。
- **C-008（P2）session 监听器轻微残留**：清理。
- **C-009（P3）compaction 健壮性**：边界处理。
- **C-012（P3）插件 debug 日志无上限**：1MB 轮转。
- **E-004（P2）确认对话框文案走 innerHTML**：动态文案改 `textContent` 承载。
- **E-005（P2）overlay escapeHtml 不转义引号**：补全 `"` `'`，属性位统一（含原推测项）。
- **E-006（P3）子代理窗口 token 写入共享 localStorage**：子代理窗口抑制每日 token 写入。
- **E-007（P3）设置页主题/活动栏名注入**：option value、文本、data 属性转义。
- **harness 渲染消毒器缺失时 fail-closed**（独立复核加固）：marked 与白名单 sanitizer 必须同时存在才渲染 HTML；消毒器加载失败时降级为纯文本转义并告警一次，绝不静默放行未消毒的 marked HTML。

### 复核加固（独立复核发现并补修）

- **项目级子代理（`.cuckoo/agents/*.md`）原本绕过工作区信任门**（D-004 补漏）：`scanAgents` 项目级未挂信任门、`scanWorkspaceArtifacts` 不探测 `.cuckoo/agents` 且 `.agents` 缺失即提前返回，导致恶意仓库的子代理（可在 frontmatter 授权 `tools: bash`）不触发信任弹窗即可被注入提示词、被 `runAgent` 实例化。已按 skills/rules 同模式在数据层门控 + 工件探测（两段独立扫描）+ prompt 过滤全部补齐，新增 6 例回归。
- **推测项 A-S-4**：MySQL 工具补 30s 语句超时（原仅 connectTimeout，慢查询会挂住连接）。
- **推测项 A-S-5**：`openBrowserWindow` 去掉 `...restOptions` 任意 BrowserWindow 选项透传。

### Audit notes（审计复核结论，不改 / 未彻底处理）

- **A-008（P2）DNS rebinding 未彻底修复**：彻底修复需引入 undici 的 pinned dispatcher（undici 非本项目直接依赖）。当前缓解为逐跳复检 + fail-closed，残余窗口与后续增强已在 `src/infra/ssrf-guard.ts` 头注释说明。
- **A-009（P3）审计结论不成立**：`addMemory`/`removeMemory` 全同步、IPC 无 await 间隙，不存在读改写竞态，不改。
- **C-010 / C-011（P3）复核无缺陷**：回源确认逻辑正确，不改。
- **推测项回源排除（9 条）**：A-S-2（`new Function` 仅编译不执行，无注入面）、A-S-3（多 file input 附错位置属 UX 非安全）；B-S-1（DeepSeek 会话提取 currentIndex）、B-S-2（ChatGPT 增量帧 `o` 缺失路径）、B-S-3（hook 异步注入时序）、B-S-4（custom provider 直接 require 路径）均回源无缺陷；C-S-002（`execute-command` 是用户手动通道，逐条确认，无额外注入面）；E 项 start.js `CUCKOO_DEBUG_PORT`（环境变量等价本机权限，非攻击面）、chat-input 延迟发送（引用捕获正确，切会话不串台）。

### 验证

- `npm run typecheck`：0 error；`npm test`（vitest）：**127 文件 / 1184 用例全过**（基线 100 文件 / 1012 用例，新增约 172 个）；`npm run lint`：0 error；`npm run compile`：0 且生成物无漂移。
- 已通过独立复核（`docs/audit/2026-10-17-修复独立复核-0.10.0.md`）：测试未弱化/跳过/硬编码、主进程闸/信任门/sanitizer/进程隔离/SSRF/WS 鉴权抽查成立，复核发现的 1 项重要缺口（项目级子代理信任门）与 1 项加固（sanitizer fail-closed）已补修并复测。
- 12 个攻击/防御 PoC 全部复跑：攻击型在真实模块回归中失效、防御型（zipslip 等）继续拦截；静态拷贝型 PoC 仅作历史留存，权威验证以 `test/` 下 import 真实模块的回归为准。

## [0.9.24] - 2026-10-17

### Fixed
- **增强停止按钮不可见（图片模式下）**：v0.9.23 图片模式把整个工具区（含停止按钮）淡出了 → 看不到也没法点。现只淡出输入区/附件/发送，保留增强(停止)按钮可见可点。

### Changed
- **增强停止按钮改红色醒目**：增强中按钮改实心红底 + 白图标 + 呼吸脉冲（原来是 accent 色，不够醒目）。

## [0.9.23] - 2026-10-17

### Added
- **增强「停止」按钮**：提示词增强中，✨ 按钮变为停止图标，可随时取消在途增强（前端作废令牌 + 主进程 abort 在途 fetch）。此前最长要等 30 秒。
- **未聚焦输入框美化**：默认态加一层柔和抬升（描边 + 极淡投影 + 顶部微高光），hover 加深；聚焦态明确焦点环（不再与 hover 阴影叠加）。

## [0.9.22] - 2026-10-17

### Fixed
- **增强「炫酷图片」背景样式选不中/不持久**：v0.9.21 遗漏给 ui-prefs 的 PromptEnhancerConfig 补 backgroundStyle/backgroundImage 字段——保存时写入了，但主进程 normEnhancer 读回时把这两字段丢弃，导致关弹窗再开又回到「科技网格」。现补齐字段定义 + 规整逻辑。

## [0.9.21] - 2026-10-17

### Added
- **增强中「炫酷图片」背景模式**：纯净模式提示词增强时，输入框可整块显示科技图（内置 9 张，自带「正在变强/火力增强」文案），文字/按钮淡出；增强设置可切「科技网格 / 炫酷图片」，图片模式支持指定某张或随机。图片以 3200x800 无损压缩存放（src/ui/enhance-images/，共约 3.5MB）。

## [0.9.20] - 2026-10-17

### Added
- **纯净模式提示词增强**：输入框旁新增 ✨ 按钮（Ctrl+E），调用独立 OpenAI 兼容 API 把草稿改写成更清晰、可执行的提示词，回填输入框（不自动发送）。可撤销、失败不动原输入、增强中禁用输入防覆盖；切会话/新对话自动取消在途增强（防串台）。支持携带最近 N 轮上下文 + 项目技术栈，两种力度（温和/激进）。
- **增强设置**：纯净模式顶栏「增强设置」入口，可配 API 地址/Key/模型/力度/上下文轮数/自定义提示词；改动即时生效并跨窗口同步，无需保存按钮。API Key 仅存本地 ui-prefs.json，不进仓库。
- **底部「最近」胶囊全局化**：最近使用（技能/MCP/子代理/提示词）由各窗口独立 localStorage 改为主进程全局存储（recent-tools.json），跨窗口同步。

### Changed
- **纯净模式输入框**：默认高度提升，自动增高到内容全显示（上限 70vh，超过才滚动）；顶部新增拖拽手柄可手动加大；发送后复位为默认并重新自适应。
- **输入框边框**：精简为单条发丝边框；聚焦时内部显示淡科技方格、边框微亮（去掉此前过重的阴影/发光/渐变边框）。
- **增强动效**：输入框科技流光边框（旋转扫描）+ 增强按钮能量环 + 启动粒子爆发（纯 CSS/SVG，无外部资源）。

### Fixed
- **发送队列「立即发送」等待期间切会话仍发出旧消息**：v0.9.18 引入的「等旧任务停止再发」（waitForAiIdleThenSend）在等待期间若用户切会话/开新对话，轮询到点仍会把旧消息发进新会话。现用 manualSendToken 令牌认领，切会话/新对话（clearTransientState）自增令牌使其作废、放弃发送。

## [0.9.19] - 2026-10-17

### Added
- **更新弹窗重设计**：「发现新版本」由通用确认框改为专属版式——品牌头 + 版本跃迁（`0.9.17 → 0.9.18 NEW`）+ 更新日志列表 + 体积提示，右下角浮窗定位不变（不打扰）。
- **下载进度实时展示**：用户点「立即更新」后弹窗保留，切换为下载态，实时显示百分比进度条（此前只推壳页面状态栏）。

### Changed
- **更新日志取自 GitHub Release 说明**：`electron-updater` 的 `releaseNotes`（HTML 格式）经 `htmlToText` 剥离标签/解码实体后展示，最多 5 条；兼容纯 Markdown 格式，无法获取时静默省略。

## [0.9.18] - 2026-10-17

### Fixed
- **发送队列「立即发送」旧任务尾巴回填新对话**：在 AI 生成中点队列某条的「立即发送」时，旧实现停任务后固定只等 80ms 就发出新消息。若网页侧收尾慢于 80ms，旧任务的尾部事件（流式帧 / 回复完成 / 工具结果回传）会在新任务开始后到达，被算进新对话（回填串台）。现改为**等旧任务真正停止再发**：以「自 stop（及最后一次事件）起持续 300ms 无事件到达」为主判据，叠加网页权威生成状态已停，并设 3000ms 超时兜底；等待期间若有事件到达则重新计静默期。「立即发送」在途时忽略后续点击，避免多条同时插队。

## [0.9.17] - 2026-10-16

### Fixed
- **窗口列表：点窗口名直接进入重命名**：此前点击卡片上的窗口名会弹出重命名框，与"点卡片=打开窗口"的直觉冲突。现窗口名改为普通文本（无 title 提示），点名字与点卡片其它区域一致 = 打开窗口；仅点铅笔图标（✎）才进入重命名。

## [0.9.16] - 2026-10-16

### Fixed
- **新建对话导航失败时监听器泄漏**：`new-conversation-for-project`（侧栏"用项目新建对话"）在 `loadURL` 失败时未移除 `did-finish-load` 监听器 → 残留累积，下次任意导航都会误触发 `initProject`（给非目标会话注入系统提示词）。现对齐 `web-new-conversation` 的处理（失败时显式移除）。
- **同 URL 导航时 loading 遮罩残留**：用户已在首页再点「+」时，Electron 可能不派发 `did-finish-load` → `onLoad` 不执行 → 遮罩残留到 15s 兜底。现检测"导航前后 URL 相同"时手动触发。
- **新建对话双击重复注入**：`new-conversation-for-project` 补上双击防护（清理上一次未完成的监听器/定时器），与 `web-new-conversation` 行为一致。
- **设置页图标列表漏插件图标**：插件图标异步挂载时若设置页已打开，列表不刷新。现插件挂载后派发事件，设置页订阅刷新。
- **首次提示抑制窗口偏宽**：点「+」后抑制「初始化项目」弹窗的时间窗 10s → 5s。

## [0.9.15] - 2026-10-16

### Added
- **新建对话 loading 遮罩**：点顶部「+」后，主进程要导航首页 + 注入系统提示词，期间页面停在空白首页无反馈。现显示居中「呼吸图标 + 流光进度条」遮罩（品牌图标柔和呼吸 + 细流光扫过），完成后自动隐藏，含 15s 安全兜底。

### Changed
- **tooltip 换回 DOM 方案**：v0.9.14 的独立透明窗口方案在 Windows 上闪烁、体验差，回退为 DOM 内渲染（跟手流畅）。删除独立窗口相关 4 个文件。保留"顶部工具栏不弹 tooltip"。
- **设置页活动栏图标可折叠**：默认收起，展开后竖排列表；改为动态读取活动栏 DOM（含插件图标）→ **Agent 模式等插件图标也可隐藏**。
- **新建对话耗时优化**：`did-finish-load` 后固定等待 2000ms → 400ms（省约 1.6s）。`initial-prompt` 监听器在 preload 顶层同步注册、输入框就绪由轮询保证，无需长等待。
- **通知摘要展示优化**：正文 2 行 → 3 行；卡片高 118 → 154；底部内边距加大，摘要不再被进度条压住。

### Fixed
- **点顶部「+」误弹「初始化项目」**：该弹窗本为"全新用户首次进首页"引导，被"开新对话"误触发。现点「+」后 10s 内不弹。
- **新建对话 loading 黑屏**：遮罩曾放在侧栏 `.ck-panel` 内，侧栏收起时 `display:none` → 遮罩不渲染但 modal-guard 仍隐藏 AI 视图 → 黑屏。现移至 body 顶层。

## [0.9.14] - 2026-10-16

### Added
- **tooltip 改为独立透明置顶窗口**：AI 页面是 WebContentsView（原生视图），永远压在壳页面 DOM 之上，CSS z-index 无效——壳页面内画的 tooltip 会被 AI 视图遮挡（真机实测顶部按钮 tooltip 与 AI 视图矩形重叠）。现 tooltip 由独立窗口渲染（屏幕坐标定位、鼠标穿透、不抢焦点、固定尺寸），永不被遮挡。新增 tooltip-window/preload/ipc + tooltip.html。

### Changed
- **Token 图标还原为文字「元」**（此前改为硬币 SVG，现还原）。
- **tooltip 交互节奏**：首次悬停延迟 700ms、连贯巡视 280ms；淡入动画 0.16s（延迟更从容、出现更干脆）。

### Fixed
- **Git 提交历史展开挤掉改动/暂存列表**：改动列表保最小高度 130px、历史展开保最小高度 150px，两者各占空间互不挤没。
- **Git 分组标题跟随滚动**：改为 `position: sticky`，滚动改动列表时「已暂存/更改」分组标题吸顶固定（对齐 VSCode 交互）。
- **纯净模式技能 chip 被吞**：`send()` 气泡文本原为互斥 if-else，有文字时技能/工具标签被丢弃。现文字与标签**分离存储**，标签渲染为气泡内 chip（文字 + chip 同时显示）；编辑取消、历史恢复均正确重现。

## [0.9.13] - 2026-10-16

### Fixed
- **通知浮窗图片显示不完整**：图片区固定 100px 高 + `object-fit:cover`，把 900×408（2.21:1）等宽幅图**裁切压扁**。现图片加载后按真实宽高比计算图片区高度（clamp 80~320px），完整显示不裁切。
- **通知浮窗进度条渐变单调**：改为 4 段渐变（实色 → 提亮 → 实色 → 淡出）+ 同色系外发光，倒计时缩短时右端先消隐，有"流光"走向。

## [0.9.12] - 2026-10-16

### Added
- **活动栏图标显隐设置**：设置页新增「活动栏图标」卡片，逐个开关控制左侧活动栏显示哪些图标，即时生效、持久化（localStorage）。设置项本身不可隐藏（防死锁）。用户隐藏的图标**不进**「⋯」溢出弹框。

### Changed
- **Token 图标统一为 SVG**：活动栏「Token（词元）」原用文字「元」，与其余 19 个线条图标不一致，现改为硬币造型 SVG（外圆 + 内圆 + 竖线）。

### Fixed
- **通知浮窗底部留白过大**：浮窗高度固定为「基础高 + 图片高」，但内容不足时（如单行标题 + 一行摘要）底部留白明显。现渲染完成后测量内容真实高度回传主进程，贴合窗口消除空白（clamp 48~400px）。

## [0.9.11] - 2026-10-16

### Fixed
- **思考阶段底栏输出速度（TPS）显示 `-- t/s`**：TPS 计算只取正文（`ev.text`），忽略思考内容（`ev.think`）。思考阶段正文为空，估算路径算不出速度；DeepSeek 服务端 `accumulated_token_usage` 在思考阶段通常也未下发，精确路径同样失效 → 显示 `-- t/s`。现把思考内容一并纳入估算（`text + think`），思考阶段也能实时显示速度。平台提供精确 token 时该参数被忽略，不受影响。

## [0.9.10] - 2026-10-16

### Added
- **纯净模式生成中禁用工作区"切换其他会话"**：AI 正在回复/跑工具时，点工作区列表切到其他会话会打断任务——纯文本生成时流被页面导航中断；**工具执行中切走更严重**：工具在后台跑完但结果回传上下文已随导航销毁，导致工具白跑、AI 卡住。现生成中非当前会话置灰禁用切换（重命名/归档/删除仍可用，当前会话不置灰），生成结束自动解除。复用既有 harness busy 链路，无需新增 IPC。

### Changed
- **任务页 package.json 脚本列表默认折叠**：此前默认展开占垂直空间，现改为默认折叠，点击标题展开。

## [0.9.9] - 2026-10-16

### Added
- **压缩续接会话自动继承/生成标题**：此前压缩产生的新会话 `title` 为 null，工作区列表回退显示一串 UUID（真机取证：所有显示 UUID 的会话均为 `kind: compaction` 且 title 为 null），用户难以辨认。现：
  - 压缩新会话从父会话**继承标题**作为兜底；