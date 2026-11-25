# 04 运行时数据流

> 理解"一切是怎么跑起来的"。

## 1. 窗口结构

每个 profile 一个 `BrowserWindow`，内部两部分：

```
BrowserWindow
├── webContents（窗口自身）= 地址栏壳页面 src/ui/shell.html
│     preload: src/app/shell-preload.ts → window.shellAPI
│     占顶部 44px（TOOLBAR_HEIGHT）
│
└── WebContentsView（子视图）= AI 网页
      preload: src/bridge/entry.ts → window.electronAPI
      占地址栏下方全部区域（随窗口 resize）
```

**为什么这样分**：地址栏需要独立于 AI 网页（不随页面导航、不被页面 CSS 影响），而 AI 网页要占满剩余空间。

**关键推论**：`win.webContents` 是**壳页面**，不是 AI 页面。凡是要操作 AI 页面（loadURL、executeJavaScript、send），必须拿 `ctx.view.webContents`。

## 2. 启动流程

```
src/app/entry.ts
  ├── app.setPath('userData', ...)      # 数据目录
  ├── registerIpcHandlers()             # 注册所有 IPC
  ├── app.requestSingleInstanceLock()   # 单实例锁
  └── app.whenReady()
        └── createWindow(profile)
              ├── new BrowserWindow(...)          # 壳
              ├── new WebContentsView(...)        # AI 页面
              ├── addChildView + layoutView       # 布局
              ├── windowState.addWindow(win, ..., view)
              ├── 加载 shell.html
              └── 加载 AI 页面（provider.homeUrl 或平台选择页）
```

**平台未定**时，view 加载 `ui/platform-select.html`；用户选择后触发 `select-platform` IPC → 更新 profile → 销毁旧窗 → 用新 partition 重建。

## 3. AI 回复捕获（网络拦截模式）

```
① preload 注入 hook（主世界）
   bridge/entry.ts → webFrame.executeJavaScript(provider.getHookSource())
   hook 猴补丁 window.fetch / XMLHttpRequest

② AI 网页发起 completion 请求
   hook 拦截响应，读 SSE 流，解析成完整回复

③ hook 派发事件（主世界 window）
   window.dispatchEvent(new CustomEvent('cuckoo-ai-response', { detail }))
   detail = { text, finished, status, tokenUsage, msgIds, ... }
   失败/中断 → 'cuckoo-ai-error'

④ preload 的 observer 监听（隔离世界）
   bridge/intercept/observer.ts
     - status=stopped → 忽略（用户主动停）
     - finished → 通知监听器 + processInterceptedResponse(text)
     - error → 通知重试引擎

⑤ 处理回复
   processInterceptedResponse(text)
     ├── extractJsToolBlocks(text) 有 cuckoo 块 → 执行工具
     ├── looksLikeJsonToolCall(text) → 发提示让 AI 改用 cuckoo 块
     ├── XML 格式 → 发提示
     └── 纯文本 → 视为任务完成，退出工具循环
```

**hook 与 preload 的关系**：hook 在**主世界**（能改 window.fetch），preload 在**隔离世界**（能用 electronAPI）。两者靠 `window.dispatchEvent / addEventListener` 通信。

## 3A. API 模式（`api-key`）

API 模式不加载 AI 网页，也不注入 AI 页面的 bridge/preload hook；harness 页面仍由 `harness-preload.ts` 驱动。

```
profile.providerId === 'api-key'
  ↓
entry.ts 跳过代理/指纹注入
  ↓
AI 视图加载 about:blank#cuckoo-api 占位，harness 视图强制可见
  ↓
用户发送 → app/ipc/harness.ts
  ↓
api-transport/runtime.ts → sendApiMessage(ctx, text, files)
  ↓
api-transport/client.ts → POST {baseUrl}/chat/completions
  Authorization: Bearer <key>
  SSE choices[].delta；native 模式支持原生 tool_calls；cuckoo-js 模式只收普通正文
  ↓
native：有工具调用 → api-transport/tool-loop.ts → ToolRegistry 权限闸
cuckoo-js：正文含 ```cuckoo 块 → api-transport/cuckoo-js-loop.ts → guard + JsRunner
  ↓
native：tool 结果写回 messages；cuckoo-js：结果作为 internal user 消息写回 → 继续下一轮请求
```

- **会话隔离**：`session-store.ts` 按 profile + session 保存历史、计划、目标；旧版单快照会自动迁移。
- **编辑旧消息必须截断主进程上下文**：API 没有网页消息 id，harness 不能只改 DOM/localStorage；`doTruncate()` / `doSubmitLatest()` 调 `harness-api-history-truncate`，`runtime.truncateApiHistory()` 按“从末尾第 N 条 user”删除目标及其后的 assistant/tool，再发送新内容，避免编辑变追加。
- **项目目录持久化**：API 会话快照与索引都保存 `projectDir`。窗口启动优先恢复 active 会话目录，老会话没有目录时回退全局 `last-project-dir.json`（目录必须仍存在）；新建会话继承当前目录，切换/删除会话同步恢复，避免每次进入 API 窗口都回到“首次对话需选择项目目录”。
- **左侧会话菜单**：只在 API 模式显示（`body:not(.ck-api-mode)` 时隐藏）；网页模式使用壳层「对话」页面，两套入口不共用。
- **协议边界**：当前只兼容 OpenAI 风格 `/chat/completions` + Bearer + SSE + `tool_calls`；Anthropic 原生、Gemini 原生等协议需要新增 adapter，不能只填 Base URL。
- **API 窗口不能直接吃网页额度**：API 窗口只发 HTTP `/chat/completions`，不会读取网页登录 Cookie，也不能把网页会员/积分当 API Key。网页额度只有两条入口：Cuckoo 网页 Provider（如 DeepSeek）或站点专用网关（如 AWS Quick + `cuko-api-quick`）。只给 Cuckoo 网页窗口用优先 Provider；要复用到 API 窗口/Codex/dsh 才做网关。
- **工具范围**：复用 `tool-loop.ts`，但排除 `attachFile`、`runAgent`、`runAgents` 等网页自动化专用工具。
- **可选 cuckoo-js 模式**：API 设置里 `toolMode=cuckoo-js` 时，请求不发送 `tools`、不产生 `tool` role；`buildCuckooApiSystemPrompt` 注入 `quick.md`（`bash/pwsh/read/readLines/write/edit/glob/grep/todoWrite` + `mcpListServers/mcpGetTools/mcpCall` 的 TS 声明，并注入全局规则、技能索引、记忆摘要、MCP 章节），模型写以三个反引号开头的 `cuckoo` 代码块，由 `cuckoo-js-exec.ts` 走 `guardExecutionCall` + `JsRunner` 本地执行，结果作为 `internal:true` 的 user 消息回传，循环到模型不再写代码块。`conversationId='cuckoo-js:'+sessionId` 走网关 body `conversation_id`，让 3000 复用网页会话；网关侧映射默认 24h 持久化，重启后可继续同一条 Quick 线程。
- **模式隔离**：`toolMode` 存会话快照；发送前当前设置与会话模式不一致且会话有可见历史时返回 `mode_mismatch`，空会话直接跟随当前设置；切换模式 UI 自动新建对话，避免旧历史混用两种协议。
- **图片附件**：API 模式仍由 `saveIncomingAttachments` 落盘、`materializeMessages` 转 OpenAI `image_url`；cuckoo-js 走网关时，网关从最后一条 user 的 `image_url` data URL 提取文件并调用 Quick 附件通道，不再只发“图片暂不支持”的文本占位。
- **停止 cuckoo-js 回合**：`stopApiSession` 在 abort 本地 fetch 前先调用 `cancelChatTurn`，向网关 `POST /openai/v1/chat/completions/stop` 发送 `conversation_id`；网关据此直接点网页“停止生成”。不能只依赖 HTTP 断连，Electron 主进程的中断不保证及时传到网关。

## 4. 工具调用循环（核心）

```
AI 输出 cuckoo 代码块
  ↓（步骤 3 捕获）
observer 提取代码块
  ↓
executor.handleJsToolScript(code)
  ↓ electronAPI.executeJs(code, callId)   ← contextBridge
  ↓ IPC 'execute-js'
主进程 ipc/tool.ts
  ↓ jsRunner.run(code, projectDir, windowId, settings)
JsRunner：vm 沙箱执行
  ├── 注入工具函数（bootstrap.generated.ts）
  ├── 沙箱内 await read(...) 等 → __hostBridge → registry.execute
  └── 返回 { success, output }
  ↓
executor 渲染结果到面板
  ↓
chatInput.sendCombinedJsResultsToChat(results)
  ↓ 填回输入框 + 触发发送
AI 看到结果 → 继续下一步（回到顶部）
```

**沙箱安全**：`vm.createContext` + 禁用代码生成 + `__hostBridge` 唯一桥接 + 超时（同步 30s / 整体 60s）。详见 `src/tools/runtime/JsRunner.ts`。

## 5. 上下文压缩（compaction）

```
用户点"压缩" → runCompaction(projectDir)
  1. 发摘要指令给 AI（"请把以上对话总结成..."）
  2. waitForResponse 等 AI 回复（走 observer 的 onInterceptedResponse）
  3. 从 URL 取 chat_session_id
  4. 从 IndexedDB 读全量 message_ids
  5. 用缓存的真实请求头 fetch /api/v0/share/create
  6. 得分享链接 → 存标记 → window.location.href 跳转
  7. 新页面加载 → checkPendingInit 自动初始化项目
```

依赖 hook 把真实请求头缓存到 `localStorage['cuckoo-ds-headers']`。

## 6. 两个保护机制

### 看门狗（watchdog）—— AI 卡住

- **进入**：检测到工具调用 → 进入工具循环
- **计时**：在工具循环中"发出消息"时开始计时
- **触发**：超时（默认 300s）→ 发"请继续"
- **退出**：收到任意终态回复 / 回复无工具调用（纯文本）
- 配置：`cuckoo-xhr-idle-timeout` / `cuckoo-watchdog-prompt` / `cuckoo-watchdog-count`

### 重试引擎（retry）—— 请求失败/中断

- **订阅**：`cuckoo-ai-error` 事件
- **触发**：失败 / 服务端截断 → 按退避间隔重发提示词（默认 4~10s）
- **429**：单独配置（默认 60s）
- 成功回复重置计数；压缩期间暂停
- 配置：`cuckoo-retry-*`

## 7. MCP

- 主进程 `mcp/client.ts` 维护与各 server 的连接（stdio / http）
- 工具 `mcpListServers` / `mcpGetTools` / `mcpCall` 通过 `__hostBridge` 调用
- 提示词组装时（`prompt-builder.ts`）注入已启用 server 列表
- 配置面板在 `overlay/panels/mcp-manager.ts`

## 8. 会话与项目

- `session/store.ts`：URL 变化 → 提取 sessionId → 查映射表 → 恢复项目目录；通过 `view.webContents.send` 通知渲染进程
- `session/project-context.ts`：`initProject` 选目录 → 保存映射 → 调 `prompt-builder` 组装 → 发送
- 每个 profile 独立的 sessionStore（独立 partition + 独立 json 文件）

## 9. 地址栏

- 壳页面 `shell.html` 通过 `window.shellAPI` 调 IPC
- `ipc/shell.ts`：navigate/back/forward/reload/home → 操作 `ctx.view`
- 页面导航时（`did-navigate`）→ `pushUrlState(view)` → `win.webContents.send('shell-url-updated', ...)` → 壳页面更新地址栏

## 10. 后台任务（任务页）

**真相源**：`src/infra/task-manager.ts`（infra 层，只依赖 node），进程表 + 进程树杀。

- **统一管理**：手动命令 / package.json scripts / AI 后台命令（`bash` 的 `background` 参数），三者同一张进程表。
- **启动**：Windows 用 `spawn(command, {shell:true})`；Unix 用 `sh -c` + `detached:true`（自成进程组）。
- **输出**：环形缓冲（单任务上限 256KB，超出丢头部）；解码用 `decodeOutput`（GBK 兼容 + 剥离 ANSI 控制码，见需求 040）。
- **停止**（精准杀进程树）：Windows `taskkill /pid <pid> /T /F`；Unix `process.kill(-pid, SIGTERM)`，宽限后 SIGKILL。⚠️ **stop 里不能同时 `child.kill()`**——抢先杀父进程会让 `taskkill /T` 找不到子进程树 → 子进程残留。
- **停止态**：`TaskInfo.stopping` 由主进程驱动，进程真退出（`finish()`）清 `stopping=false` 并补 `exitCode ?? null`（见需求 039/042）。
- **IPC**：`src/app/ipc/task.ts`（`task-start/stop/list/output/remove/clear-exited/read-scripts`）。
- **变更通知**：`taskManager.setChangeListener(broadcastChange)` → `broadcastChange()` 遍历窗口推 `shell-tasks-changed` 给壳页面。
  ⚠️ **易错点**：`!ctx.win.isDestroyed` 漏括号会让条件恒 false → 通知永不推送（需求 044 踩过）。
- **壳页面**：`src/ui/shell/scripts/pages/tasks.ts`，订阅 `onTasksChanged` 自动刷新；运行后 `scrollToTask(id)` 定位到新任务卡片（需求 041）。

## 11. 自动更新与并发保护

- **模块**：`src/updater/index.ts`（electron-updater + generic provider / GitHub Releases）。
- **流程**：启动延迟 5s 检查 → 发现新版本弹窗询问 → 「立即更新」自动下载 → 下载完 `quitAndInstall(true, true)`（`/S` 跳过 NSIS 向导 + 装完自动重启）。
- **并发保护**（需求 039/042）：静默安装期间应用退出、文件被替换，若用户再双击旧图标会与安装程序争用文件锁。用标记文件 `<userData>/update-pending.json` 做门禁：
  - 安装前 `markUpdatePending()` 写 `{fromVersion, targetVersion, at}`（原子写）。
  - 启动时 `isUpdatePending()`：**过期 / 版本已变 / 已达目标 / 数据不完整** → 放行并清理；否则命中 → `entry.ts` 提示「更新进行中」+ `app.quit()`。
- ⚠️ **仅打包版生效**：`app.isPackaged` 为假时跳过自动检查，开发版测不了此逻辑。
