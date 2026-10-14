# 最新接续状态 (2026-10-13 22:00)

## 核心进展

**v0.8.67**：加 `npm run dev` 开发实例启动 + harness 文字对比度微调。已提交、打 tag、推送 origin。最新 tag **v0.8.67**。

### v0.8.67 改动
1. `npm run dev`：start.js 支持 --dev（独立 userData cuckoo-dev-verify + 调试端口 9444），与打包版隔离可同时运行。
2. harness 文字：助手正文改 --text-2（稍暗不刺眼）；工具卡文字提亮（名/参数/输出）。

### v0.8.67 验证
- typecheck / test 980 / lint 0 error / compile 全绿
- 真机：npm run dev 成功启动（CDP 9444 正常）；助手正文色 rgb(192,198,210) ✅

### 仍未处理（待用户确认）
- 窗口组切换后 harness 队列/导航丢失（设计局限，已分析，待用户决定方案 A/B/C）

### v0.8.66（同轮）
回归审查修复（v0.8.59 引入的视图隐藏与 modal-guard 冲突等）。

### v0.8.66 改动（回归修复）
🔴1. layoutView 的 setVisible 覆盖 modal-guard 隐藏 → 新增 __ckAiHidden 标志统一三方来源
🔴2. git-diff-modal 带 ck-modal-mask 命中 modal-guard → 纯净模式关弹框会抢显盖 harness。modal-guard 排除该弹框
🟡3. parseDiff hunk 内误判 ---/+++ → 限定 !hunk 才按文件头处理
🟡4. harness cancelStreamRender 未复位 pending + 无条件 scrollBottom → 切会话多余滚动
🟡5. __ckWebviewHidden 残留 → did-finish-load 复位

### v0.8.66 验证
- typecheck / test 980 / lint 0 error / compile 全绿
- 真机冒烟：diff 弹框正常打开、结构化渲染正常；R2 排除逻辑确认
- ⚠️ 视图显隐仍无法 CDP 像素级验证（setVisible 不改 visibilityState），建议用户手动验普通模态框+resize

### v0.8.65（同轮）
修 git 徽标不及时更新 + 深色主题对比度提升。

### v0.8.65 改动
1. **git 徽标不及时**（src/ui/shell/scripts/pages/git.ts）：`onGitChanged` 原 `if (!isGitPanelActive()) return` 把徽标也门控了 → 非 git 页时数字不刷新。改为未激活时也拉 gitStatus 只更新徽标。
2. **深色对比度**（base.css + harness.html）：背景加深（#0e1014/#14161b），文字提亮（#eef1f6/#c0c6d2/#8a90a0），harness 与壳页面同步。

### v0.8.65 验证
- typecheck / test 980 / lint 0 error / compile 全绿
- 真机：非 git 页新建文件 → 徽标 5→6 自动更新 ✅；shell/harness 背景 rgb(14,16,20)、文字 rgb(238,241,246) ✅

### ⚠️ 待处理（用户反馈，未修）
- **窗口组切换后 harness 待发队列丢失**：sendQueue 是窗口内存变量，切会话时清空
- **窗口组切换后右侧对话导航丢失**：onSessionChanged 里 history 为空时提前 return，未建导航

### v0.8.64（同轮）
提交详情 diff 配色调整（文字更醒目 + 背景更暗）。

### v0.8.64 改动
diff 正文底色改用专用深色 --ck-diff-bg（浅色 #f0f1f4 / 深色 #0d0f13）；增删行背景透明度 16%→22%；增删文字调亮（绿 #56d364 / 红 #ff7b83）。

### v0.8.63（同轮）
提交详情 diff 结构化渲染（摘要卡 + 文件列表 + 双列行号 + 降噪，需求 049）。

### v0.8.63 改动
提交详情由 `git show` 原始输出着色 → 结构化渲染：摘要卡 + 文件列表（可跳转）+ 双列行号正文，丢弃 commit/index/---/+++ 噪音；修正对比度（正文用主文字色、行号去 opacity、增删背景加深）。

### v0.8.63 验证
- typecheck / test 980 / lint 0 error / compile 全绿
- 真机：摘要卡/文件列表/行号正常，codeColor=主文字色、lnOpacity=1

### v0.8.62（同轮）
修复 installer 测试间歇性失败（断言只查本次残留，不受历史残留影响）。

### v0.8.62 改动
test/plugins/installer.test.js 的 `不残留临时目录` 断言扫描整个 os.tmpdir()，被历史中断遗留的 `cuckoo-plugin-stage-*` 目录误伤。改为基线对比，只断言本次安装不新增残留（installer.ts 的 finally 本就正常清理）。

### 仍未修的性能项（评估后暂缓）
- 文件树构建全同步 IO（session.ts buildFileTree）：有 5000 节点/12 层上限，低频调用，异步化改造风险>收益，暂缓
- 全窗口广播：token 上报每轮一次（低频），窗口数少，影响可忽略

### v0.8.61（同轮）
harness 流式渲染节流（rAF 合并，消除 O(n²)，需求 048）。

### v0.8.61 改动（性能）
harness 流式渲染 O(n²)（src/ui/harness.html）：onStream 每帧对全量正文跑 renderMarkdown（marked+KaTeX 全解析）+ innerHTML 重建。改为非 finished 帧用 rAF 合并（同帧多次只渲最后一次），finished 帧立即渲染。

### v0.8.61 验证
- typecheck / test 980 / lint 0 error 全绿
- 真机：注入 3 帧非 finished + 1 帧 finished，最终正文完整、收尾光标正确消失 ✅
- code-reviewer 审查：无必须修复项，采纳 2 条建议（cancel 清 text / clearTransientState 调 cancel）

### v0.8.60（同轮）
深度性能排查修复两处确凿热点（token 统计 IO 放大 + stripToolBlocks O(n²)）。

### v0.8.60 改动（性能）
1. **token 统计同步 IO 放大**（src/app/token-stats.ts）：每次 token 上报触发 1 写 + 8 读整个 token-stats.json（全同步阻塞主进程）。加内存缓存 _cache（读命中不读盘、写同步缓存）；写盘失败使缓存失效。保持原同步并发语义。
2. **流式 stripToolBlocks O(n²)**（src/bridge/harness-bridge.ts、feishu-bridge.ts）：onStream 每帧对全量正文跑 3 个正则。加无围栏快速路径（indexOf('```')===-1 跳过，严格等价）；删一处冗余 trim。

### v0.8.60 验证
- typecheck / test 980 / lint 0 error / compile 全绿
- 真机：连续 token 上报 80000→95000→111111，磁盘与壳页面读值始终一致（缓存无 stale 覆盖）✅
- code-reviewer 审查：改动 2 严格等价（9/10）；改动 1 采纳其「写盘失败回退」建议

### 仍未修的性能项（待排期）
- 文件树构建全同步 IO（src/app/ipc/session.ts buildFileTree）
- 全窗口广播（broadcastSystemTotal/broadcastWindowUsage 遍历所有窗口）

### v0.8.59（同轮）
提交详情 UI 三项改进（提交历史默认展开 / 弹框放大为全窗口浮层 + 打开时隐藏原生视图 / 复制不弹二次框）。

### v0.8.59 改动
- 提交历史默认展开（进入 git 页即加载展示）
- 提交详情弹框改全窗口浮层（max 1100px×85vh）；打开时临时隐藏 AI/harness 原生视图（setVisible+setBounds 双保险）——原生 WebContentsView 永远盖在壳页面之上，不隐藏则浮层右侧被遮挡
- 复制 diff 改按钮文字短暂反馈，不弹二次框

### v0.8.58（同轮）
修复提交详情对 merge commit 不显示 diff（`git show -m --first-parent`）。

### v0.8.58 改动
- `git-show-commit-diff` 命令加 `-m --first-parent`：merge commit 也能显示完整 diff（原默认只给 stat）。普通 commit 行为不变。

### v0.8.57（同轮）
源代码管理页「提交详情」支持查看完整 diff（需求 046）：新增 IPC `git-show-commit-diff`、专用弹框、diff 着色渲染、复制 diff。

### v0.8.57 改动
- 新增 IPC `git-show-commit-diff`（`git show --patch`，超 512KB 截断）
- 新增提交详情弹框（modals.html）+ diff 着色渲染 + CSS（`.ck-git-diff-*`）
- `showCommit` 由 ckAlert 纯文本改为弹框着色展示，支持复制 diff

### v0.8.57 验证
- typecheck ✅ / test 98 文件 980 用例 ✅ / lint 0 errors ✅ / compile ✅ / docs:index ✅
- ⚠️ 未做真机验证：改动为 UI 展示 + 新增 IPC；如需可装打包版点提交历史查看

### v0.8.56（上一版）
内存/性能深度修复（3 处）：任务表无界增长、规则注入 Map 无界、输出裁剪 O(n²)。已提交、打 tag、推送。

### v0.8.56 改动（内存/性能）

1. **任务表无界增长**（src/infra/task-manager.ts）：tasks Map 退出后不自动清理 → 新增 pruneExited()（保留最近 50 条已退出），在 finish / stop 兜底 / dispose 三处自动修剪。
2. **规则注入 Map 无界增长**（src/rules/injection.ts）：injected Map 按会话累积、clearSession 从未调用 → 加会话数上限 100，超限淘汰最早条目（语义无损，最坏重注入一次）。
3. **输出裁剪 O(n²) → O(n)**（task-manager.appendOutput）：逐字符 slice+byteLength 改单次遍历累加，按 UTF-16 码点边界前进（不切坏代理对）；修正截断前缀未计入 outputBytes。

### v0.8.56 验证
- typecheck ✅ / test 98 文件 980 用例全绿（新增 test/infra/task-manager.test.js 4 用例）✅ / lint 0 errors ✅ / compile ✅
- code-reviewer 审查：无必须修复项；采纳其建议（截断前缀同步 outputBytes + 补裁剪测试）
- ⚠️ 未做真机验证：改动为纯内存管理逻辑（无 UI/IPC 行为变化），静态 + 单测已充分覆盖；如需可在「任务」页观察历史任务上限

### 上一轮（v0.8.46 → v0.8.55，10 个版本）

任务页系列修复 + 更新机制加固 + UI 交互打磨。已全部提交、打 tag、推送 origin。

三大块：**任务页系列修复**（停止态/通知刷新/滚动定位）+ **更新机制加固**（并发保护/ANSI 输出/子代理审查修复）+ **UI 交互打磨**（规则页保存提示/hover 抖动与参数）。

## 版本清单（本轮）

- **v0.8.46**：任务停止态修复（stopping 纳入 TaskInfo + 渲染签名）+ 运行后滚动 + 更新安装并发保护（标记文件 + 版本拦截）
- **v0.8.47**：任务输出剥离 ANSI 控制码（decode-output 新增 stripAnsi，处理 CSI/OSC/单字符；UTF-8 与 GBK 分支都走）
- **v0.8.48**：运行任务后滚动定位到「刚运行的任务卡片」（原滚到面板底部，任务多时看到最旧的）
- **v0.8.49**：子代理审查修复——更新门禁锁死（installAndRestart 无参→target 空→新版被拦 10 分钟）+ 任务停止兜底 exitCode + expanded 裁剪
- **v0.8.50**：规则页保存提示撑坏布局（改 textContent 摧毁 icon-only 按钮 SVG）→ 改为按钮行末尾插临时 span
- **v0.8.51**：任务状态变更不自动刷新——`broadcastChange()` 里 `!ctx.win.isDestroyed` **漏括号**（方法未调用恒 falsy）→ 通知从未推送，补括号
- **v0.8.52**：列表卡片 hover 抖动（display 瞬切 → max-height/opacity/margin 对称过渡）+ tooltip 延迟放慢
- **v0.8.53**：hover 过渡 0.6s
- **v0.8.54**：hover 过渡 1s + 展开延迟 0.4s（⚠️ 误提交 tmp-cdp.mjs）
- **v0.8.55**：hover 展开延迟 0.3s + 清理误提交临时文件

## 核心动机与背景（Bug 根因剖析）

本轮以 **Bug 修复** 为主，关键根因：

1. **任务停止卡「停止中…」**（v0.8.46）：渲染层手动改按钮 DOM，但 `renderTasks` 按签名去重，进程真退出前签名不变 → 不重建 DOM，按钮停在手动态。改为 `stopping` 纳入 `TaskInfo` + 渲染签名，状态单一来源。
2. **任务状态完全不自动刷新**（v0.8.51）：`src/app/ipc/task.ts` 的 `broadcastChange()` 条件写成 `!ctx.win.isDestroyed`（漏括号），`isDestroyed` 是方法、未调用恒为 falsy → 整个条件永远 false → `shell-tasks-changed` **从未推送**（自 v0.8.42 任务页上线即存在）。启动能显示是因手动调了 `loadTasks()`，掩盖了问题。
3. **更新门禁锁死新版本**（v0.8.49，子代理审查发现）：`checkForUpdates` 的"已下载完成"分支 `installAndRestart()` 无参 → `targetVersion` 空 → 更新成功后新版首次启动被 `isUpdatePending` 判"未完成"拦截，**锁死最长 10 分钟**（v0.8.46 引入的回归）。
4. **hover 抖动**（v0.8.52）：卡片详情用 `display:none` 瞬切（展开有动画、收起瞬间跳变），快速划过反复"平滑展开→瞬间收起"= 抖动。
5. **规则页保存提示撑坏布局**（v0.8.50）：保存按钮是 icon-only（固定 30px），改 `textContent` 摧毁 SVG 且长文本竖排换行撑坏按钮行。

## 关键设计与实现（Implementation & Decisions）

- **任务停止态**：`TaskInfo` 增 `stopping?: boolean`；`stop()` 置位 + `notifyChange()`；`finish()`（进程退出）清 `stopping=false` 并补 `exitCode ?? null`；渲染层据 `running && stopping` 渲染「停止中…」(disabled)，handler 不再手改 DOM。
- **运行后滚动定位**：`scrollToTask(id)` → `item.scrollIntoView({behavior:'smooth', block:'start'})` 定位**新任务卡片**（列表新任务在顶部，不能滚到底）。
- **更新并发保护**：`updater/index.ts` 标记文件 `<userData>/update-pending.json`（记录 `fromVersion` + `targetVersion` + 时间戳，原子写）。`isUpdatePending()` 放行条件：过期 / 版本已变 / 已达目标 / 数据不完整 → 放行；命中则 `entry.ts` 启动时提示 + `app.quit()`。`update-downloaded` 记 `downloadedVersion`，三处 `quitAndInstall` 归一为 `installAndRestart(version)`。
- **ANSI 剥离**：`decode-output.ts` 新增 `stripAnsi()`（CSI/OSC/单字符三类），`decodeOutput` 统一调用（UTF-8 与 GBK 分支都走）。
- **hover 平滑**：`components.css` 用 `max-height/opacity/margin-top` 对称过渡（**1s**）+ `transition-delay: .3s`；负 margin 抵消父容器 gap，折叠零占位。涉及 6 类卡片：技能 / 子代理 / MCP / 窗口 / 提示词 / 快照。
- **任务通知修复**：`broadcastChange()` 补括号 `!ctx.win.isDestroyed()` + 加 `!ctx.win.webContents.isDestroyed()`。

## 子代理审查结论（v0.8.49）

用 code-reviewer 审查 v0.8.46~48，发现 1 必须修复 + 4 建议 + 4 参考，已处理：
- 🔴 #1 更新门禁锁死（已修，7 分支用例验证）
- 🟡 #2 停止兜底 exitCode / #3/#4 注释+原子写 / #5 expanded 裁剪（已修）
- 🔵 #6/#7/#9 已处理；⏭️ #8（isUpdatePending 单测）不做——`src/updater/**` 被 vitest 排除，深 mock electron 违反「只写真实集成测试」规则。

## 待办事项 (Next Steps)

- [ ] **排查规则注入丢失 bug**（见「待排查」）
- [ ] 真机验证更新并发保护（跨版本：装 v0.8.55 后等下个版本发布验证）
- [ ] 真机复核 v0.8.47（任务输出无 ANSI）、v0.8.51（任务状态自动刷新）、v0.8.52~55（hover 参数）——需装打包版
- [ ] 确认 CI（tag v0.8.46~v0.8.55）Win+Mac 构建成功
- [ ] 排查预存在失败 `test/plugins/installer.test.js`

## ⚠️ 待排查（重要，未修）

**全局规则第 4 条未注入**：`~/.cuckoo/rules/global-override.md` 有「4. 修改后使用子代理检查，主代理审计」（第 25 行）及「> 派出子代理检查，你在审计」（第 46 行），但系统提示词注入的 global-override 里这两行丢失/措辞不同。**已确认规则文件本身完整**（读原文件验证），问题在**注入环节**（疑似截断/缓存）。

## ⚠️ 遗留事项

- **预存在测试失败**：`test/plugins/installer.test.js > installPlugin: 不残留临时目录`——clean master 上同样失败（已 stash 验证），与本轮无关，待排查。
- **v0.8.54 瑕疵**：误把临时调试脚本 `tmp-cdp.mjs` 提交进仓库；已于 v0.8.55 删除清理。如求"干净"版本以 v0.8.55 为准。

## 真机测试实例（已登录，常驻）

- **启动命令**：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& npx electron . --remote-debugging-port=9444`（后台起）
- **数据目录**：`C:\Users\Administrator\AppData\Roaming\cuckoo-dev-verify`（独立，不碰打包版）
- **CDP 端口**：9444（`http://127.0.0.1:9444/json/list` 列页面；Node 内置 WebSocket 直连 `webSocketDebuggerUrl` 注入 JS）
- **登录态**：已登录 DeepSeek（2026-10-13），会话持久化在 userData，重启开发版仍有效
- **测试专用会话**：`941b49ac-ab35-47d3-80d1-5b083b4d7946`（标题「打招呼」）已绑定 cuckoo-code。测试前把 AI 页面导航到 `https://chat.deepseek.com/a/chat/s/941b49ac-ab35-47d3-80d1-5b083b4d7946`，任务页 cwd/脚本列表即正常（免每次初始化）。不污染任何真实对话。
- **用途**：真机验证 UI/交互/运行时逻辑（CDP 注入 JS 读 DOM、模拟操作）
- **注意**：开发版 ≠ 打包版；`app.isPackaged` 才生效的逻辑（autoUpdater 自动更新/静默安装）开发版测不了，需真机打包版
- **与打包版隔离**：打包版（`D:\cuckoo-code\Cuckoo-Code.exe`，用户在用）占单实例锁；开发版靠独立 userData 绕开，互不影响

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`（Win+Mac）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 发版流程：写 CHANGELOG → 改 package.json version → commit → `git tag -a vX` → push master + push tag
- **教训**：`git add -A` 前先确认无临时调试文件（v0.8.54 曾误提交 `tmp-cdp.mjs`）
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push master）
- **用户偏好**：改完代码主动 commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
- **真机验证注意**：本机常驻打包版 Cuckoo-Code.exe，占单实例锁 → 开发版 `npx electron .` 拿不到锁会静默退出。验证开发版需 `CUCKOO_SESSION_DIR=cuckoo-dev-verify npx electron . --remote-debugging-port=9444` + Node CDP 直连。
