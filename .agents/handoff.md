# 最新接续状态 (2026-10-17)

## v0.10.0 全量安全加固（本会话，分支 fix/security-bug-sweep，**未 tag / 未 push / 未发版**）

对全项目做只读安全审计（5 路分片 + 独立复核，产物在 `docs/audit/`，commit 8160a54 在 master），确认 **59 条 bug（P0×4 / P1×15 / P2×17 / P3×23）全部修复或逐条给出不改结论**，并复核 17 条推测项。新增约 166 个回归测试（100 文件/1012 → 126 文件/1178 全过）；typecheck 0、lint 0 error、compile 0、生成物无漂移。修复按 bug ID 小步 commit（master..HEAD，见 `git log`）。

### 新增安全地基（已冻结，下游在用）
- `src/infra/`：`atomic-json.ts`（cuckooHomeDir + writeJsonAtomicSync/readJsonRobust）、`host-allowlist.ts`（isOwnWindowUrl/isProviderHost/checkSenderUrl）、`workspace-trust.ts`（信任记录 ~/.cuckoo/trusted-workspaces.json，CUCKOO_HOME 可覆盖）、`run-captured.ts`（runCaptured + killProcessTree 树杀）；`dangerous-commands.ts`（isDangerous 硬拒绝 + findDeliverySignature 投递特征）。
- `src/app/`：`execution-policy.ts`（smart/workspace/strict + decideToolGate）、`ipc-guard.ts`（classifySender/guardExecutionCall/planToolGate/planJsGate，确认默认聚焦取消、无 dialog 保守拒绝）、`workspace-trust-prompt.ts`（ensureWorkspaceTrust 默认聚焦"不信任"）、`ipc/security.ts`（4 个 IPC 通道，仅 own-window）。
- `src/overlay/sanitizer.ts`：零依赖白名单 sanitizer，构建产物 `src/ui/vendor/cuckoo-sanitize.js`（`scripts/build-sanitizer.mjs`，已在 compile 串）；harness 在 marked 后、KaTeX 前 sanitize；shell shared.ts re-export 真源。
- `src/tools/runtime/`：JsRunner 改为 `child_process.fork` 独立 worker（`js-sandbox-worker.mjs`，纯 ESM 零 src 依赖）+ `bootstrap-build.ts`（主进程拼 bootstrap 随 run 下发）；`scripts/copy-sandbox-worker.mjs` 拷 .mjs 到 out（已在 compile 串）。工具仍在主进程执行（worker IPC 桥接，seq 匹配）；看门狗 500ms unref，无活动到点 SIGKILL。

### 三大产品决策（用户拍板，勿改）
1. **X-001 三层防线**：主进程 host 白名单 + sender 校验；高危投递特征任何模式都弹确认；设置页三档策略（默认 smart 保持自动，**绝不做每条命令都问**）。
2. **D-002+D-004 工作区信任门**：选项目发现 .agents/mcp.json、rules、skills 时弹一次；不信任则项目级 MCP 不 spawn、规则技能不注入（数据层 scanner 兜底，覆盖 JsRunner/cuckoo-host/harness 等所有入口）；用户级不受影响。
3. **D-001 插件**：安装前确认（默认聚焦取消）+ 安装后默认禁用（`setCuckooPluginEnabled(id,false)`）+ 包名白名单（isValidNpmPackageSpec）。

### 不改 / 未彻底处理（如实记录，别再"修"）
- **A-008 DNS rebinding 未彻底修**：需 undici pinned dispatcher（非直接依赖）；现缓解=逐跳复检+fail-closed，残余窗口写在 ssrf-guard.ts 头注释。
- **A-009 审计结论不成立**：memory 增删全同步、IPC 无 await 间隙，无 RMW。
- **C-010/C-011 复核无缺陷**；C-S-002 execute-command 是用户手动通道逐条确认，不额外改。
- **D-009 远程 PWA 静态资源不鉴权**（无敏感数据，数据走 /api、/ws token 鉴权）。
- 推测项回源排除 9 条：A-S2/S3、B-S1~S4、C-S002、E start.js 调试端口（env 等价本机权限）、E chat-input（引用捕获正确不串台）。

### 真机待验（沙箱起不了真机，交付前没跑）
- 信任门 / 执行策略 dialog UX、设置页两个新卡片的实际点选与持久化。
- hook 在真实 DeepSeek/Claude 页的断流、XHR 看门狗、host 白名单（B-001/B-010 等）。
- D-001 安装确认框、D-005 真手机浏览器 Sec-WebSocket-Protocol 握手（Node ws 已过，ws 8.22 默认回选首个 subprotocol）、D-008 Electron net.request 逐跳重定向（仅 Node fetch 路径已改）。
- CSP 在 file:// 下对 vendor 相对脚本、Monaco worker（worker-src blob:）、插件 unsafe-eval 的放行。
- **A-005 Electron 打包环境 fork .mjs 主模块加载、长任务（runAgent/bash 大 timeout）跨进程桥接与看门狗暂停语义**（plain Node 已硬验死循环硬杀，见 test/tools/JsRunner.Process.test.js）。
- utilityProcess.fork ESM 路径未采用（选了 child_process.fork 更确定）。

### PoC 复跑结论（`.agents/audit-poc/`，12 个，保留不删）
- poc-1/2/3/4、poc-harness-marked-xss、poc-overlay-mcp-name-xss、poc-non-atomic 是**旧源码逐字静态拷贝/裸 marked 演示**，复跑仍显示旧行为（设计如此）；权威验证是 `test/` 下 import 真实模块的回归（dangerous-commands / ssrf-guard / protected-paths / run-captured / mcp-escape / window-escape / sanitizer / atomic-json）。
- poc-parser-boundaries.test.js 导入真实 js-detector：PoC-1 攻击断言已**翻转失败**（未闭合块不再提取），其余 8 项正确行为通过。
- 防御型 poc-d007 zipslip 10/10 继续拦；poc-d004 token 为静态风险报告（真实修复见 test/remote/ws-auth.test.js）；poc-d001 证明"已启用插件"仍可 require（架构本质），一键"安装即 RCE"链已被默认禁用+确认+包名白名单打断。

### 独立复核结果（已完成，PASS）
- 报告：`docs/audit/2026-10-17-修复独立复核-0.10.0.md`（commit 699aff3）。亲手复跑 typecheck/lint/test/compile 全绿、自写探针证实死循环硬杀、PoC 全复跑；测试无弱化/跳过/硬编码。
- 复核发现 1 项「重要」+ 1 项「建议」，**均已补修并复测**：
  1. 项目级子代理 `.cuckoo/agents/*.md` 原绕过信任门（D-004 漏网）→ 已按 skills/rules 数据层模式补齐（agents/scanner 挂 isWorkspaceTrusted、scanWorkspaceArtifacts 两段独立探测 `.agents` 与 `.cuckoo/agents`、prompt-builder 过滤、信任弹窗展示），新增 6 例（commit 2c1d4d9）。
  2. harness 渲染在 sanitizer 缺失时 fail-open → 改 fail-closed 降级纯文本（commit d85d57e）。
- 复核「建议但不阻断」中**有意保留**：① 两段式 `powershell -File x.ps1` 不命中投递特征（黑名单固有局限；裸 `-File` 跑本地脚本是正常开发行为，加了会误伤、违反"智能档不逐条问"；`-ExecutionPolicy Bypass` 已拦）；② overlay→session 历史反向依赖（本次未引入，后续可拆）；③ 生产死循环 60s 无活动 deadline（主循环不饿死前提下的产品取舍）。

### 收尾状态
- 版本已升 0.10.0（package.json + package-lock.json）；CHANGELOG 0.10.0 按 Keep a Changelog 覆盖全部 59 + 17 推测 + 复核加固；README 安全机制/插件/MCP 旧行为已改。
- 最终验证：typecheck 0、vitest **127 文件 / 1184 用例**、lint 0 error、compile 0 无漂移。
- 待办：**合并/发版由用户决定**（当前不 tag/push/发版）。真机待验项见上（尤其 A-005 打包环境 fork、D-005 手机浏览器握手、CSP file:// 放行、D-008 Electron net.request）。

## v0.10.1：修复 v0.10.0 打包阻塞 bug（已发）

**根因**：A-005 的 worker 打进 app.asar，`child_process.fork` 是原生进程，OS 不认 asar 路径 → 打包版 AI 执行 JS 代码块 100% MODULE_NOT_FOUND。
**修复**：`asarUnpack` 加 `**/js-sandbox-worker.mjs` + `JsRunner.resolveWorkerPath()` 把 `app.asar/` 映射到 `app.asar.unpacked/`。6 例回归测试锁定。
**铁证**：unpacked 路径 fork 成功存活，asar 内路径 exists=false 崩溃。
**另补**：打包排除 .archify/.codegraph/.cuckoo/wyp/templates/examples/release-notes/eslint-rules + src/**/*.ts（asar 352→343 MB）。

## v0.10.0 后续 UI 功能线（同一分支，未 tag / 未 push）

在 0.10.0 安全修复基础上追加以下功能（独立审计见 `.agents/快捷键新对话与设置即时生效-审计.md`，裁决 PASS）：

- **Ctrl+N / Ctrl+Shift+N** 新开对话 / 选目录新开对话（菜单 + harness/AI 页 before-input-event 双拦截）
- **左上角项目选择器**改为"选目录 → 新开对话"（新 IPC `pick-dir-and-new-conversation` + assertSenderOk）
- **设置页即时保存**（去掉保存按钮；并发保护 + reset 期间屏蔽）
- **默认纯净模式 + 默认 dark 主题**（runtime/proxy/harness 三处对齐）
- **打包排除** `scripts/.agents/test/docs/.github/.githooks/vitest.config.mjs/eslint.config.js`（安装包瘦身，源码不进包）
- 新增 IPC 来源校验（new-conversation-for-project / pick-dir-and-new-conversation）
- session.ts 同 URL 导航短路 + onLoadFired 防重入（修"点项目选择器后不初始化/遮罩滞留"）

## 核心进展
- **最新版本 v0.9.24**（修复图片模式停止按钮不可见 + 停止按钮改红，typecheck/lint(0)/test(1012)/compile 全绿）。
- **v0.9.23**：提示词增强加「停止」按钮（增强中 ✨ 变停止图标，可取消在途请求）；未聚焦输入框加柔和抬升阴影美化。
- **v0.9.22**：**修复**——v0.9.21 遗漏 ui-prefs 的 backgroundStyle/backgroundImage 字段，导致图片模式选完关弹窗又回网格。
- **v0.9.21**：**增强中「炫酷图片」背景模式**——增强时输入框整块显示科技图（内置 9 张，自带文案），可切「科技网格/炫酷图片」；图片放 src/ui/enhance-images/（3200x800 无损压缩）。
- **v0.9.20**：**纯净模式提示词增强**（需求 078）——✨ 按钮调独立 API 改写草稿、回填不发送、可撤销、全局配置跨窗口同步；**底部「最近」胶囊全局化**（localStorage → 主进程全局存储）；输入框自适应增高 + 拖拽手柄；科技流光/粒子动效；发丝边框。另含**发送队列等待期切会话仍发旧消息**的收尾修复（manualSendToken）。
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
- [x] **队列"立即发送"回填风险**（v0.9.18 已修）：改为等旧任务真正停止（事件静默期 + ai-state + 超时兜底）再发。v0.9.20 补：等待期间切会话的作废（manualSendToken）。
- [x] **提示词增强·图片背景模式**（v0.9.21 已完成）：9 张图压缩到 src/ui/enhance-images/，增强设置可切「科技网格/炫酷图片」。
- [ ] 旧会话 UUID 标题迁移（069 只对新压缩会话生效，历史数据仍显示 UUID）。**优先级低**：影响仅"远古未命名会话在列表显示 UUID"，且存储里无对话正文可作补标题的数据源。
- [x] 打包版真机验证：更新确认框/系统通知浮窗/窗口组切换通知 —— **用户已测过，通过**。

## 关键上下文
- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 构建/验证: `npm run typecheck` / `npm test`（v0.10.0：127 文件 / 1184 用例）/ `npm run lint`（0 error）/ `npm run compile`
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
