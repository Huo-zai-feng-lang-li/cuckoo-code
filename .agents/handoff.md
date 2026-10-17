# 最新接续状态 (2026-10-18)

## 核心进展
- **修复纯净模式截断状态卡死**：点历史消息"从此处截断重发"后，状态栏一直停在"截断中…"不恢复。根因是 `src/ui/harness.html` 的 `onSessionChanged` 消费 `pendingTruncate` 的两个分支（回退原会话/到达新会话）只清了 pending 和 timer，没复位 status；90s 兜底定时器首行 `if (!pendingTruncate) return` 因 pending 已清空而失效。修复：两个分支各加 `setStatus('就绪','ready')`。四件套全绿（typecheck/test 128文件1190用例/lint 0 error/compile）。已提交推送。
- 上一版本 **v0.10.16**：修复“纯净模式点停止/发消息时底层进程不中断”的严重 Bug，明确精确的进程中止边界。GitHub CI 全绿。

## 核心动机与背景 (Motivation & Background)
- **假停止问题**：用户在 Harness 点击停止或发送新消息时，之前的 UI 只改了状态，并没有杀主进程 spawn 出来的工具子进程（如 `rg.exe`、`cmd.exe`），导致工具卡片一直卡在“运行中”，且后台资源被白白占用。
- **边界定义（极其重要，曾踩坑）**：中止操作必须只强杀**阻塞当前对话**的前台进程（bash/grep/JS 沙箱）。**绝对不能**杀有独立生命周期的后台任务（如 AI 拉起的 `npm run dev`）以及 MCP 长连接服务，否则会把用户的开发环境弄崩。

## 关键设计与实现 (Implementation & Decisions)
- **进程追踪基建**：新增 `src/infra/process-tracker.ts`，全局追踪主进程 spawn 的进程，支持按 `windowId` 强杀。
- **底层接入**：`runCaptured`（bash/pwsh）和 `runRipgrep`（grep）全部接入 `trackProcess`；并给 grep 增加了 60s 兜底超时。
- **统一中止入口**：在 `src/app/ipc/harness.ts` 中封装了 `abortWindowWork(ctx)`，只杀属于该窗口的前台进程和 `JsRunner` 沙箱。
- **触发时机**：在 `harness-stop`（停止）和 `harness-send`（发新消息前）均会调用 `abortWindowWork`。
- **UI 兜底**：`src/ui/harness.html` 的 `stop()` 里增加了遍历 `.tool-badge.run`，把卡死的卡片标记为“已停止”。
- **版本纠错**：v0.10.15 曾错误加入 `stopBySource('ai')` 导致误杀 dev server，已紧急撤销，并彻底删除了远程错误的 v0.10.15 tag，重新发布了正确的 v0.10.16。

## 待办事项 (Next Steps)
- [ ] 用户下载 v0.10.16 安装包，真机验证：
  1. 点停止/发新消息，前台卡住的 bash/grep 是否能瞬间消失且不卡。
  2. 后台运行的 dev server（任务页里的）是否依然存活，不被误杀。
- [ ] 如果后续还有其他页面（如 Git、文件、任务）在极端情况下的性能或卡顿问题，继续按同样的思路排查。

## 关键上下文
- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 主要文件:
  - `src/infra/process-tracker.ts`（新增的前台进程追踪器）
  - `src/app/ipc/harness.ts`（abortWindowWork 及 IPC 拦截）
  - `src/tools/runtime/JsRunner.ts`（沙箱 abortAll 实现）
  - `src/tools/impl/grep.ts`（接入追踪与超时）
  - `src/infra/run-captured.ts`（bash/pwsh 底层执行）
  - `src/ui/harness.html`（UI 卡片状态清理）
- **构建/验证**: `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile`。
- **发版注意**：发布前必须跑四件套且亲自 grep 确认关键修改落地，绝不能盲信 edit 返回值（此前曾因此发过空版本和坏版本）。
- **外网代理**: `http://127.0.0.1:51081`
