# 最新接续状态 (2026-10-17)

## 核心进展
- **最新版本 v0.9.19**（feat/077-update-popup-redesign，typecheck/lint(0)/test(988)/compile 全绿）。
- **v0.9.19**：**更新弹窗重设计**（需求 077）——「发现新版本」改专属版式（品牌头 + 版本跃迁 + 更新日志 + 体积），点「立即更新」保留窗口显示实时下载进度。
- **v0.9.18**（已发 tag）：**发送队列「立即发送」旧任务尾巴回填新对话修复**（详见下）。
- **v0.9.17**：窗口列表交互修复 —— 点击窗口名不再直接进入重命名（改为普通文本），点名字/卡片其它区域 = 打开窗口；仅点铅笔图标（✎）才重命名。
- 本会话从 v0.9.9 连续迭代到 v0.9.18，主线是**一批 UI/交互体验修复 + 两次自查修复**。

### v0.9.18 详情（发送队列立即发送回填）
- **问题**：AI 生成中点队列某条的「立即发送」，旧实现停任务后固定只等 80ms 就发新消息 → 网页收尾慢于 80ms 时，旧任务尾部事件（流式帧/回复完成/工具结果回传）在新任务开始后到达，被算进新对话（回填串台）。
- **修复**（`src/ui/harness.html`）：`sendQueueItemNow` 忙碌分支改为 `waitForAiIdleThenSend(it)` —— 主判据「自 max(stop 时刻, lastActivityAt) 起持续 `AI_STOP_QUIET_MS`(300ms) 无事件」，叠加 `!aiPageGenerating`（bridge ai-state 权威态），超时 `AI_STOP_WAIT_MAX_MS`(3000ms) 兜底；事件到达则重置静默期。`manualSendInFlight` 在途时忽略后续点击。
- **关键坑1**：`harness-stop-signal` 一到 bridge 就乐观置 `aiPageGenerating=false`，**不能单用它判停** → 必须叠加事件静默期（旧任务真在吐内容时事件不断）。
- **关键坑2**：harness 是 WebContentsView，页面内定时器被节流到 ~1s；验证"事件不断"须用 **Node 侧定时器**驱动 `fireActivity`，不能用页面 setInterval。
- **真机验证**（开发实例 9444 + CDP）：S1 无事件 ~500ms 发 / S2 事件不断 ~3.7s(超时)发 / S3 事件后静默 ~700ms 发，均符合设计。

### 版本足迹（本会话补充）
- **v0.9.17**：窗口列表"点名字误触发重命名"修复（windows.ts，去掉 name 的 title + 点击监听）。

### 版本足迹（本会话）
- **v0.9.16**：v0.9.15 审查修复 —— session.ts 监听器泄漏（真 bug）、同 URL 导航遮罩残留、session.ts 双击防护、设置页插件图标刷新、首次提示抑制窗 10s→5s。
- **v0.9.15**：新建对话 loading 遮罩（需求 076）+ 新建耗时优化（2000ms→400ms）+ **tooltip 回退 DOM 方案** + 设置页图标折叠/动态读取 + 通知摘要 3 行。
- **v0.9.14**：tooltip 独立窗口（**已回退**）+ Git sticky + 技能 chip 气泡内显示（需求 074/075）。
- **v0.9.13**：通知图片按真实比例 + 进度条渐变。
- **v0.9.12**：活动栏图标显隐设置 + Token 图标（后还原为文字"元"）+ 通知高度自适应。
- **v0.9.11**：思考阶段 TPS 修复（纳入 `ev.think` 估算）。
- **v0.9.10**：生成中禁用工作区"切换其他会话" + package.json 脚本默认折叠。
- **v0.9.9**：压缩续接会话继承/生成标题（需求 069）。

## 核心动机与背景 (Motivation & Background)

### tooltip 方案之争（重要教训）
- **问题**：壳页面内画的 tooltip 会被 AI 页面（WebContentsView 原生视图）遮挡（CSS z-index 无效，真机实测 overlap=true）。
- **尝试 v0.9.14**：改独立透明置顶窗口（`tooltip-window.ts`）。能解决遮挡，但 **Windows 上原生窗口显示切换必闪**（改固定尺寸、防抖都没根治）。
- **最终 v0.9.15 回退 DOM 方案**（`src/ui/shell/scripts/tooltip.ts` 恢复 DOM 渲染）：跟手不闪，代价是右侧可能被 AI 视图遮挡。**已删除** tooltip-window/preload/html/ipc 4 文件。
- 保留改进：**顶部工具栏不弹 tooltip**（`el.closest('.toolbar')` 直接 return）。

### 新建对话（点顶部「+」）
- **不弹「初始化项目」**：该弹窗是 overlay 的"首次使用提示"（首页 URL + 无项目目录即弹），被"开新对话"误触发。现点「+」写 localStorage `cuckoo-new-conv-ts` 标记，`overlay/panel.ts` 5s 内不弹。
- **显示 loading 遮罩**（`newconv-loading.ts` + `index.html` body 顶层）：呼吸图标 + 流光进度条，完成自动隐藏，15s 兜底。
  - ⚠️ **坑**：遮罩**不能放侧栏 `.ck-panel` 内**——侧栏收起时 `display:none` → 遮罩不渲染，但 modal-guard 仍隐藏 AI 视图 → **黑屏**。必须放 body 顶层（保留 `.ck-modal-mask` 类，modal-guard 才认）。
- **耗时优化**：`did-finish-load` 后固定等 2000ms → **400ms**（`shell.ts` + `session.ts`）。依据：`initial-prompt` 监听器在 preload 顶层同步注册（did-finish-load 时已就绪），输入框就绪由 chat-input 轮询保证。剩 ~2s 是 **DeepSeek 首页站点加载时间**，代码已到极限。

## 关键设计与实现 (Implementation & Decisions)

### 新建对话各分支（`src/app/ipc/shell.ts: web-new-conversation`）
- `notifyDone()` 必须**每个分支都调**（`!view` / `!url` / 成功 / 失败 / 无目录），否则 loading 残留到 15s 兜底。
- 同 URL 导航：`beforeUrl === url` 时手动触发 `onLoad`（Electron 可能不派发 did-finish-load）。
- **教训**：`session.ts: new-conversation-for-project` 曾有**监听器泄漏**（loadURL 失败没 `wc.off`）→ 下次任意导航误触发 initProject。已修，且补了双击防护（`__newConvOnLoad`/`__newConvTimer` 清理）。

### 设置页活动栏图标显隐（`pages/settings.ts`）
- **动态读活动栏 DOM**（含插件图标 `data-plugin-tab`）→ Agent 模式等插件图标**可隐藏**。
- 默认**折叠收起**，展开后竖排列表。
- 插件图标异步挂载 → `plugin-shell.ts` 挂载后派发 `cuckoo-activitybar-mounted` 事件，settings 订阅刷新。

### 通知浮窗（`notification-window.ts` + `.html`）
- 高度：`HEIGHT=154`，正文 `-webkit-line-clamp:3`，底部内边距 22px（摘要不再被进度条压住）。
- 图片：`applyPicRatio` 按真实比例设高度（clamp 80~320），不裁切。
- 渲染后 `measureAndResize` 回传真实高度 → 主进程 `onResize` relayout（clamp 48~400）。

### Git 面板
- 提交历史 `flex:1` 自适应；改动列表 min-height 130px、历史展开 min-height 150px，互不挤没。
- 分组标题 `position: sticky; top:0` 吸顶（仿 VSCode）。

### 技能 chip（harness 气泡）
- `send()` 中文字与标签**分离存储**（`histItem.hints`），标签渲染为气泡内 chip（`renderBubbleChips`）；编辑取消/历史恢复正确重现。

### 压缩续接标题（需求 069）
- `store.ts: setSessionLineage` 继承父标题；`compaction.ts` 摘要首行 `【标题】xxx` → 段3 经 IPC `set-pending-session-title`（`forceStage`）绑定。

## 待办事项 (Next Steps)
- [x] **队列"立即发送"回填风险**（v0.9.18 已修）：改为等旧任务真正停止（事件静默期 + ai-state + 超时兜底）再发。
- [ ] 旧会话 UUID 标题迁移（069 只对新压缩会话生效，历史数据仍显示 UUID）。**优先级低**：影响仅"远古未命名会话在列表显示 UUID"，且存储里无对话正文可作补标题的数据源。
- [x] 打包版真机验证：更新确认框/系统通知浮窗/窗口组切换通知 —— **用户已测过，通过**。

## 关键上下文
- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 构建/验证: `npm run typecheck` / `npm test`（988）/ `npm run lint`（0 error）/ `npm run compile`
- **生成物禁手改**：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + compile）
- **依赖铁律**：`infra ← providers ← tools ← bridge ← session ← app`；overlay 不依赖 bridge/session；tools 不依赖上层（注入）
- **窗口结构**：AI 页面在 `ctx.view.webContents`，不是 `ctx.win.webContents`
- 主进程模块用 `createRequire(import.meta.url)` 动态 require 'electron'
- **真机验证**：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& npx electron . --remote-debugging-port=9444`（后台起），CDP 连 `http://127.0.0.1:9444/json/list` 注入 JS 读 DOM。开发版与打包版隔离。
- 外网代理: `http://127.0.0.1:51081`
- 主要文件（本会话高频改动）：
  - `src/app/ipc/shell.ts`（新建对话 + loading）
  - `src/app/ipc/session.ts`（新建对话分支）
  - `src/overlay/panel.ts`（首次提示抑制）
  - `src/ui/shell/scripts/newconv-loading.ts`（新）
  - `src/ui/shell/scripts/tooltip.ts`（DOM 版）
  - `src/ui/shell/scripts/pages/settings.ts` + `partials/pages/settings.html`
  - `src/app/notification-window.ts` + `src/ui/notification-window.html`
