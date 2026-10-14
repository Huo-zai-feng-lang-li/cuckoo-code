# 最新接续状态 (2026-10-14 19:30)

## 核心进展
- **最新 tag v0.8.79**（待提交/打 tag）。
- v0.8.79 主题：**F12 开发者工具改为独立窗口（detach）**。
- 上一批 v0.8.78 主题：**修复工具窗口无法登录 Google/Gemini**（需求 050）。
- v0.8.78 主题：**修复工具窗口无法登录 Google/Gemini**（需求 050）。
- 上一批 v0.8.65~77 主题：UI 体验打磨 + 性能优化 + 窗口组切换闭环（全部 `typecheck / test 980 / lint 0 error / compile` 全绿 + 真机验证）。

## v0.8.79 详细
- **问题**：F12 开发者工具被原生视图覆盖 / 布局错乱。
- **根因**：4 处 F12（壳页面 entry.ts:411、AI 页面 entry.ts:605、harness 视图 entry.ts:298、工具窗口 browser-window-manager.ts:67）全用 `toggleDevTools()`（默认 docked）。本应用是「壳页面 + 多个原生 WebContentsView 叠加」架构：docked DevTools 渲染在壳页面区域内会被上层原生视图盖住，且与 `layoutView()` 的 setBounds 强制重排冲突。
- **修复**：统一改为 `openDevTools({ mode: 'detach' })`（判断 `isDevToolsOpened()` → 已开则 close，未开则 detach 打开，保留"再按一次关闭"手感）。「查看」菜单的 `role: 'toggleDevTools'` 也改为自定义 detach 逻辑。共 5 处。
- **验证**：真机（开发版 + windows-computer-use 发真实 F12）——AI 页面、壳页面 F12 均弹出独立 DevTools 窗口（`Developer Tools - <url>`）；`typecheck / test 980 / lint 0 error / compile` 全绿。
- **踩坑**：CDP `Input.dispatchKeyEvent` 注入的合成键盘事件不触发主进程 `before-input-event`，验证 F12 必须用真实按键（windows-computer-use MCP `key`）。

## v0.8.78 详细（需求 050）
- **问题**：`openBrowserWindow` 工具窗口打开 Gemini/Google 登录页报「此浏览器或应用可能不安全」。
- **根因**：工具窗口只调 `setUserAgent`（去 Electron 标识），缺两项 Google OAuth 必需修正：
  1. `navigator.userAgentData.brands` 缺 "Google Chrome" 品牌
  2. `sec-ch-ua*` 请求头未改写
  主窗口 AI 视图（`entry.ts` + `bridge/entry.ts`）三样齐全，所以能过。
- **修复**：
  - 新增 `src/app/browser-preload.ts`（工具窗口专用 preload，主世界注入 `buildUserAgentDataFix()`）
  - `src/tools/impl/browser-window-manager.ts`：`openWindow` 指定该 preload（`sandbox:false` 必须，否则 ESM preload 加载失败）+ `ensureClientHints()` 补齐 `sec-ch-ua*` 请求头
- **验证**：真机独立 Electron 窗口打开 gemini.google.com —— 修复前 brands 缺 Google Chrome 且跳登录页；修复后 brands 含 "Google Chrome"、正常进入 Gemini 应用页。`typecheck / test 980 / lint 0 error / compile` 全绿。
- **踩坑**：ESM preload 在 Electron 默认 sandbox=true 下无法加载（报 `Cannot use import statement outside a module`），必须显式 `sandbox:false`。
- **后续（Gemini provider）**：工具窗口登录问题已解决；但要让 Cuckoo 真正支持 Gemini 对话（Agent 循环），仍需新增 `src/providers/gemini.ts` + `src/providers/hooks/gemini.ts`（P0）。当前验证仅到"能登录、能打开 Gemini 页面"。

## 核心动机与背景 (Motivation & Background)

### 本会话解决的问题（按版本序）
1. **git 徽标不及时更新**（v0.8.65）：`git.ts` 的 `onGitChanged` 里 `if (!isGitPanelActive()) return` 把徽标更新也门控了 → 非 git 页时数字不刷新。
2. **深色对比度差**（v0.8.65）：背景偏亮、文字发灰。调整 base.css + harness.html 的 `--ck-*` 变量。
3. **提交详情看不懂**（v0.8.63/64/69/70）：原展示 `git show` 原始输出噪点多 → 结构化渲染（摘要卡+文件列表+行号+降噪）+ 左色条 + 回到顶部按钮。
4. **回归审查**（v0.8.66）：子代理发现 v0.8.59 引入的 2 个 🔴（layoutView 覆盖 modal-guard、git-diff-modal 命中 modal-guard）+ 3 个 🟡。
5. **`npm run dev`**（v0.8.67）：开发实例启动脚本（独立 userData cuckoo-dev-verify + 端口 9444），与打包版隔离。
6. **窗口组切换丢上下文**（v0.8.70）：切换后 harness 历史/待发队列丢失（跨窗口渲染进程内存不共享）→ 主进程中转迁移。
7. **限流自动切换突兀**（v0.8.70/74）：加倒计时弹框（可取消），3s→6s。
8. **限流探测发垃圾消息 + 退避 350s**（v0.8.71）：方案 A 限流冷却缓存（跳过冷却窗口）。
9. **切换时序缺陷**（v0.8.72）：复查发现 3 个（session-changed 丢失、限流双触发、监听残留）。
10. **活动栏拖拽排序后底部三项不沉底**（v0.8.73）：`applyActivitybarOrder` 强制 `_spacer` 到末尾 → 关于/飞书/设置不再沉底。加 `normalizeSpacer` 三段式归一。
11. **性能优化**（v0.8.74）：① 全部暂存改批量 `git add -A`（原逐个文件）；② git 刷新加 in-flight 合并（`loadGitCoalesced`）；③ 文件树事件委托（原上万监听器）；④ 文件树异步化（原 `readdirSync` 同步递归阻塞主进程）；⑤ git watcher 噪声目录补全；⑥ 限流倒计时 3s→6s。
12. **复查修正**（v0.8.75）：unstage-all 回退正则补 `Failed to resolve`；倒计时注释 3s→6s。
13. **活动栏拖拽图标跑到底部**（v0.8.76）：`moveDrag` 只遍历 `.ck-ab-item`（不含 spacer），拖到底部越过分隔线 → 限制在主区 + 底部固定区不可拖。
14. **活动栏溢出菜单**（v0.8.77）：主区超 14 个 → 显示 13 个 + 「⋯」hover 弹框。顺带修：新挂载图标落底部区、MutationObserver 自激死循环（卡死渲染进程）。

## 关键设计与实现 (Implementation & Decisions)

### 窗口组切换（v0.8.70~72，核心）
- 切换 = 源窗口全量分享 → **目标窗口导航到 share URL** → initProject（`entry.ts` runSwitchForGroup）。
- 目标窗口是**另一个渲染进程**，看不见源窗口内存/localStorage → 状态必须**经主进程中转**。
- harness 视图**懒加载**（`ensureHarnessView`），partition 按 profile 隔离；历史存 localStorage `cuckoo-harness-history-v1:<sid>`。
- **导出**：`requestHarnessExport(windowId)` 发 `harness-export-state-req`，页面回 `harness-export-state-reply`（5s 超时降级 null）。
- **导入**：`stageHarnessImport` 暂存 → `harness-ready` 触发 `pushHarnessImport`；harness 侧 `importHarnessState` 在 session 未确定时暂存到 `_pendingImportState`，由 `onSessionChanged` 应用。
- **纯净模式继承**：记录源 `__ckHarnessVisible`，目标加载后 `__ckToggleHarness(true)`。

### 限流冷却缓存（v0.8.71，方案 A）
- `window-groups.json` 结构 `{ groups, rateLimits }`；`markRateLimit/getRateLimitAt/isRateLimited/clearRateLimit`，冷却 5 分钟。
- 探测循环 `isRateLimited(pid)` 跳过冷却窗口；**仅 `pr === 'limited'`** 写缓存。
- **关源窗口前置校验**：`Promise.race([targetReady, 60s])` → ready 才关，否则保留源窗口。

### 活动栏（v0.8.73/76/77）
- **三段式归一**（`normalizeSpacer`）：`[主区项] + [_spacer] + [底部固定项 about/feishu/settings]`。
- **拖拽**只限 `_spacer` 之前；底部固定区不可拖。
- **溢出**：主区 > `MAX_MAIN(14)` → 显示 13 + 「⋯」（`activitybar-overflow.ts`），hover 弹框；**不改 DOM 结构**（隐藏项仍原位，仅 `display:none`），克隆 + 转发 click 切 tab。
- ⚠️ **两处 observer 必须合并**：drag 的 observer 串行调 `refreshActivitybarOverflow`，overflow 不另建 observer；`refresh` 内「disconnect→改→observe」防自激死循环（曾卡死渲染进程）。

### 性能边界（已评估，有界）
- 历史：`saveHist` 400 条上限 + 单字段 6000 字截断。
- `rateLimits`：键 = 限流过的窗口数，删窗口时清理。
- diff 渲染有 512KB 上限保护；git maxBuffer 8MB 够用。
- `renderList` 的 innerHTML 拼接是 O(n) 单次；`parseDiff` 的 `+=` 是 rope 拼接，均摊 O(n)。

### 发版教训（v0.8.65~71）
- **批量 tag 推送被 GitHub 忽略** → **分步执行 + 每步 `git ls-remote` 验证 + tag 单独推送**（这是本会话踩过的坑，务必遵守）。
- v0.8.65~72 的 tag 曾缺失，后补全；Release 只做了 v0.8.72（含全部改动）。

## 待办事项 (Next Steps)
- [ ] **用户真机验证 v0.8.77**（用 `npm run dev` 或已装打包版）：
  - 活动栏：**加插件图标超过 14 个**时是否出现「⋯」、hover 弹框能否切 tab；拖拽是否还会跑到底部
  - 窗口组**手动切换**：历史+队列迁移、纯净模式继承、toast
  - 窗口组**限流自动切换**：6s 倒计时、取消生效（较难测，需真实 429）
  - git 全部暂存（几百文件项目）、文件树展开/折叠/搜索（大项目）
  - diff 配色（左色条+回到顶部）、git 徽标实时、深色对比度
- [ ] **未做的遗留项**（用户只读报告提出，方案 B/C 暂缓）：
  - **方案 B 并行探测**：收益有限且放大垃圾消息，不做
  - **方案 C 账号池调度**：架构级，待需要时做
  - **跨平台分享**：`shareUrl` 硬编码 DeepSeek（`entry.ts`），Claude/ChatGPT 切换编排未实现
  - 探测本身仍会发「你好」垃圾对话（A 只减少了重复探测，未改探测方式）
- [ ] **活动栏智能排序**：用户问过「智能排序 vs 溢出菜单 vs 分组弹框」，已选**溢出菜单**（v0.8.77），未做智能排序（会破坏肌肉记忆，不建议）。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 主要文件:
  - `src/app/entry.ts` — runSwitchForGroup（切换编排）、rate-limit-hit（6s 倒计时）、layoutView
  - `src/app/window-groups.ts` — 组管理 + 限流缓存
  - `src/app/ipc/window-groups.ts` — requestHarnessExport/stageHarnessImport/onHarnessReady
  - `src/app/ipc/git.ts` — git IPC（含批量 stage-all/unstage-all、isNoisePath）
  - `src/app/ipc/session.ts` — buildFileTree（异步化）
  - `src/ui/harness.html` — export/importHarnessState、倒计时 UI、流式节流
  - `src/ui/shell/scripts/activitybar-drag.ts` — 拖拽排序（主区限定 + 三段归一）
  - `src/ui/shell/scripts/activitybar-overflow.ts` — 溢出菜单（新增）
  - `src/ui/shell/scripts/pages/git.ts` — 徽标、diff 渲染、doBulk
  - `src/ui/shell/scripts/pages/files.ts` — 文件树（事件委托）
  - `src/ui/shell/styles/base.css` + `pages.css` — 主题变量 + diff 配色
  - `start.js` — `--dev` 支持（npm run dev）
- 真机测试: `npm run dev`（独立 userData cuckoo-dev-verify + 端口 9444）；CDP 注入读 DOM
- 快照: snap-1791965000000-o0a9xb（活动栏溢出前）
- 发版流程: 改 CHANGELOG + package.json 版本 + handoff → commit → push → **单独** tag → push tag → 每步 `git ls-remote` 验证
