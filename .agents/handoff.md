# 最新接续状态 (2026-10-14 15:02)

## 核心进展
- **最新 tag v0.8.77**（准备发布）。本会话完成：git 徽标修复、深色对比度、diff 结构化渲染与配色、`npm run dev` 脚本、回归审查修复、窗口组切换状态迁移、限流冷却缓存、活动栏 spacer 归位、git/文件树性能优化。
- 全部改动 `typecheck / test 980 / lint 0 error / compile` 全绿；真机冒烟通过。

## 核心动机与背景 (Motivation & Background)

### 本会话解决的问题（按时间序）
1. **git 徽标不及时更新**（v0.8.65）：`git.ts` 的 `onGitChanged` 里 `if (!isGitPanelActive()) return` 把徽标更新也门控了 → 非 git 页时数字不刷新。
2. **深色对比度差**（v0.8.65）：背景偏亮、文字发灰。
3. **提交详情看不懂**（v0.8.63~64、v0.8.69）：原展示 `git show` 原始输出噪点多；后逐步做结构化渲染（摘要卡+文件列表+行号+降噪）+ 配色（左色条）。
4. **回归审查**（v0.8.66）：子代理发现 v0.8.59 引入的 2 个 🔴（layoutView 覆盖 modal-guard、git-diff-modal 命中 modal-guard）+ 3 个 🟡。
5. **`npm run dev`**（v0.8.67）：开发实例启动脚本（独立 userData + 端口 9444）。
6. **窗口组切换丢上下文**（v0.8.70）：切换后 harness 历史/待发队列丢失（跨窗口渲染进程内存不共享）。
7. **限流自动切换突兀**（v0.8.70）：加 3s 倒计时弹框（可取消）。
8. **限流探测发垃圾消息 + 退避 350s**（v0.8.71）：方案 A 限流冷却缓存。
9. **切换时序缺陷**（v0.8.72）：复查发现 3 个（session-changed 丢失、限流双触发、监听残留）。
10. **活动栏拖拽后底部三项不沉底**（v0.8.73）：`applyActivitybarOrder` 强制 `_spacer` 到末尾 → 关于/飞书/设置不再沉底。已修 + `normalizeSpacer` 迁移旧数据。
11. **性能优化**（v0.8.74）：① 全部暂存改批量 `git add -A`（原逐个文件）；② git 刷新加 in-flight 合并；③ 文件树事件委托（原上万监听器）；④ 文件树异步化（原同步递归阻塞主进程）；⑤ git watcher 噪声目录补全。⑥ 限流倒计时 3s→6s。

### v0.8.74 性能审查要点（子代理确认有界）
- `renderList` 的 innerHTML 拼接是 O(n) 单次，不卡（真正风险在重复触发，已修）
- `parseDiff`/`renderDiffHtml` 的 `+=` 是 rope 拼接，均摊 O(n)
- diff 渲染有 512KB 上限保护；git maxBuffer 8MB 够用

### 发版教训（v0.8.65~71）
- **批量 tag 推送被 GitHub 忽略** → 分步执行 + 每步 `git ls-remote` 验证 + tag 单独推送。
- v0.8.65~72 tag 已补全；Release 只做了 v0.8.72（含全部改动）。

### 窗口组切换的架构事实（重要）
- 切换 = 源窗口全量分享 → **目标窗口导航到 share URL** → initProject（`entry.ts` runSwitchForGroup）。
- 目标窗口是**另一个渲染进程**，看不见源窗口内存/localStorage → 状态必须**经主进程中转**。
- harness 视图**懒加载**（`ensureHarnessView`），partition 按 profile 隔离。
- harness 历史存 localStorage `cuckoo-harness-history-v1:<sid>`（按窗口隔离）。

## 关键设计与实现 (Implementation & Decisions)

### v0.8.70 窗口组状态迁移（核心）
- **导出**：`requestHarnessExport(windowId)` 向源 harness 发 `harness-export-state-req`，页面回 `harness-export-state-reply`（5s 超时，harness 未创建返回 null 降级）。
- **导入**：`stageHarnessImport(windowId, state)` 暂存 → `harness-ready` 信号触发 `pushHarnessImport`（避免页面未加载完 push 丢失）。
- **应用**：harness 的 `importHarnessState` 在 `currentSessionId` 未确定时暂存到 `_pendingImportState`，由 `onSessionChanged` 应用（否则历史存空 key 被覆盖）。
- **纯净模式继承**：记录源 `__ckHarnessVisible`，目标加载后 `__ckToggleHarness(true)`。
- 文件：`window-groups.ts`(IPC) / `entry.ts`(编排) / `harness-preload.ts`(通道) / `harness.html`(导出导入) / `ipc/index.ts`(注册)。

### v0.8.70 限流倒计时
- `countdownBeforeAutoSwitch(ctx, 3)` + `pendingAutoSwitch` Map + `harness-cancel-switch` handler。
- **仅自动切换**（限流触发）加倒计时；手动切换（wg-switch）不加。

### v0.8.71 限流冷却缓存（方案 A）
- `window-groups.json` 结构改为 `{ groups, rateLimits }`（`readData`/`writeData`）。
- `markRateLimit/getRateLimitAt/isRateLimited/clearRateLimit`，冷却 **5 分钟**（`RATE_LIMIT_COOLDOWN_MS`）。
- 探测循环：`isRateLimited(pid)` 跳过冷却窗口；**仅 `pr === 'limited'`** 写缓存（超时/错误不写，避免误伤慢窗口）。
- **关源窗口前置校验**：`Promise.race([targetReady, 60s])` → ready 才关，否则保留源窗口。

### v0.8.72 复查修复
1. `harness-ready` 时**补发 session-changed**（view 导航时页面未加载完 → 事件丢失 → 导入卡 pending）。
2. `switchingProfiles` Set 守卫（429 连续触发 → 并发倒计时/双切换）。
3. `loadURL` 失败时 `twc.off('did-finish-load', onLoad)`（防监听残留误跑 initProject）。
4. `exportHarnessState` 去掉冗余深拷贝（IPC 本会结构化克隆）。

### 性能边界（已评估，有界）
- 历史：`saveHist` 有 400 条上限 + 单字段 6000 字截断。
- `rateLimits`：键 = 限流过的窗口数，删窗口时清理。
- `pendingExport`/`stagedImport`：均有超时/清理。
- `switchingProfiles`：成功/失败/取消三分支都 delete。

## 待办事项 (Next Steps)
- [ ] **用户真机验证**（v0.8.72 已就绪，用 `npm run dev`）：
  - 窗口组**手动切换**（wg-switch）：历史+队列迁移、纯净模式继承、toast
  - 窗口组**限流自动切换**：3s 倒计时、取消生效（较难测，需真实 429）
  - diff 配色（左色条+更暗背景）、git 徽标实时、深色对比度
  - **回归**：正常对话/切会话/新对话无异常
- [ ] **未做的遗留项**（用户只读报告提出，方案 B/C 暂缓）：
  - **方案 B 并行探测**：收益有限且放大垃圾消息，不做
  - **方案 C 账号池调度**：架构级，待需要时做
  - **跨平台分享**：`shareUrl` 硬编码 DeepSeek（`entry.ts`），Claude/ChatGPT 切换编排未实现
  - 探测本身仍会发「你好」垃圾对话（A 只减少了重复探测，未改探测方式）

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 主要文件:
  - `src/app/entry.ts` — runSwitchForGroup（切换编排）、rate-limit-hit（倒计时）、layoutView
  - `src/app/window-groups.ts` — 组管理 + 限流缓存（markRateLimit/isRateLimited）
  - `src/app/ipc/window-groups.ts` — requestHarnessExport/stageHarnessImport/onHarnessReady
  - `src/ui/harness.html` — exportHarnessState/importHarnessState、倒计时 UI、流式节流
  - `src/ui/shell/scripts/pages/git.ts` — 徽标、diff 渲染（parseDiff/renderDiffHtml）
  - `src/ui/shell/styles/pages.css` + `base.css` — diff 配色（--ck-diff-bg/--ck-diff-code）
  - `start.js` — `--dev` 支持（npm run dev）
- 真机测试: `npm run dev`（独立 userData cuckoo-dev-verify + 端口 9444）；CDP 注入读 DOM
- 快照: snap-1791955761852-lw9flp（方案 A 前）
- 发版流程: 改 CHANGELOG + package.json 版本 + handoff → commit → tag → push origin master + tag