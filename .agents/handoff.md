# 最新接续状态 (2026-10-13 16:44)

## 核心进展

本轮（v0.8.39）新增**任务页**——命令 / package.json scripts / AI 后台命令统一管理。代码已完成、验证通过（typecheck/compile/lint/test 全绿 + 核心逻辑真机实测），待提交发版。分支 **feat/037-task-runner**。

## 核心动机与背景

用户跑 `npm run dev` 这类长驻命令时停不掉、看不到，只能关 exe。根因：现有 `bash` 工具与 `execute-command` IPC 都是"一次性阻塞命令"（exec + 30s timeout），**没有后台任务/进程表概念**。

## 关键设计与实现（需求档案：docs/requirements/037-task-runner.md）

- **infra/task-manager.ts**（新）：进程表 + `start/stop/list/getOutput/remove/clearExited/dispose/readPackageScripts`。分层：infra 层只依赖 node 内置；通知 UI 用回调注入 `setChangeListener`（不依赖上层）。输出环形缓冲上限 256KB；并发上限 20；停止宽限 3s。
- **进程树杀**（核心）：Windows `taskkill /pid X /T /F`（连带子进程树）；Unix `spawn detached:true` + `process.kill(-pid, SIGTERM/SIGKILL)`。
  - ⚠️ **踩坑并修复**：`stop` 原先在 taskkill 之外还抢先 `rec.child.kill()` → 父进程先死，异步 taskkill 找不到子进程树 → 子进程残留。**改为只走 taskkill /T /F**。实测：停止前子进程存活 true → 停止后 false。
- **tools/impl/bash.ts**：新增 `background` 参数（apiMetas + bootstrap + schema + execute 分支 + 提示词），长驻命令后台启动立即返回任务 ID。
- **app/ipc/task.ts**（新）：7 个 IPC（task-start/stop/list/output/remove/clear-exited/read-scripts）+ 变更广播 `shell-tasks-changed`（去抖 120ms 在 task-manager 内）。危险命令过 isDangerous；cwd 取当前窗口 selectedProjectDir。
- **壳页面**：活动栏加「任务」图标（badge 显示运行中数）；partials/pages/tasks.html + scripts/pages/tasks.ts；样式追加到 styles/pages.css。
- **防闪屏**：任务列表签名（id+status+exitCode+command）未变则只增量刷输出，不重建 DOM（对齐 Git 历史防闪做法）。
- **退出清理**：entry.ts `before-quit` 调 `taskManager.dispose()` 杀全部后台进程树，防孤儿。

## 验证结果

- typecheck ✅ / compile ✅ / lint 0 error ✅ / test 970 passed ✅
- 核心逻辑真机实测 **11/11 通过**（start/输出捕获/stop/list/remove/readPackageScripts）
- 进程树杀实测通过（修复顺序 bug 后）
- Electron 真机启动成功（CDP 9333），**UI 交互尚未人工点验**

## 待办事项 (Next Steps)

- [ ] **真机点验「任务」页**：手动跑命令 / 点 script / 停止 / 看输出
- [ ] 装 v0.8.39 exe 复核；确认 CI（tag v0.8.27～v0.8.39）Win+Mac 构建
- [ ] 旧待办：验证 v0.8.35~v0.8.38 各项（Git 历史不闪、全部折叠、规则滚动、空白气泡等）

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`（Win+Mac）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 发版流程：写 CHANGELOG → bump package.json/lock（三处一致）→ commit → `git tag -a vX.Y.Z` → push master + push tag
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push）
- **用户偏好**：改完代码**主动** commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
