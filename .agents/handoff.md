# 最新接续状态 (2026-10-13 19:10)

## 核心进展

本轮推进 **v0.8.46**：修复任务页「停止」卡死 + 运行后滚动 + 更新并发保护。已提交（fix/039 分支）并合入 master。最新 tag **v0.8.46**。

前序 v0.8.40 → v0.8.45（任务页 + Token 统计 + 自动更新）已全部真机验证通过。

## 版本清单（本轮）

- **v0.8.46**：任务页停止态修复（stopping 纳入 TaskInfo + 渲染签名）+ 运行后滚动到任务列表 + 更新安装并发保护（标记文件 + 版本拦截）

## 本轮修复详情（v0.8.46）

### 1. 任务「停止」按钮卡在「停止中…」
- **根因**：渲染层手动改按钮 DOM（`textContent='停止中…'; pointerEvents='none'`），但 `renderTasks` 按签名去重——签名（id|status|exitCode|command）在进程真退出前不变 → 不重建 DOM → 按钮停在手动态；要等进程退出/3.5s 兜底才恢复。
- **修法**：`TaskInfo` 增 `stopping?: boolean`；`stop()` 置位后 `notifyChange()`；`toInfo` 透出；`finish()`（进程退出）清 `stopping=false`。渲染层：签名纳入 `stopping`；`renderTaskItem` 据 `running && stopping` 渲染「停止中…」(disabled)；停止 handler 不再手改 DOM。
- **验证**（CDP）：停止→`stopping:true`+按钮「停止中…」disabled→进程退出(PID 消失)→`stopping:false`+按钮恢复移除键。✓

### 2. 运行命令/脚本后看不到运行状态
- **修法**：`tasks.ts` 新增 `scrollToTaskList()`，运行成功后 `loadTasks()` 再平滑滚动 `.ck-panel-body` 到底部，露出任务列表。
- 调用点：scripts 按钮 + 手动命令运行。

### 3. 更新静默安装期间可重复启动旧 exe
- **风险**：安装窗口期（应用退出、文件被替换）用户再双击旧图标 → 与安装程序争用文件锁 → 安装失败/版本混乱。
- **修法**：`updater/index.ts` 新增标记文件 `<userData>/update-pending.json`（记录目标版本 + 时间戳）：
  - `markUpdatePending()`：`installAndRestart()` 安装前写标记。
  - `isUpdatePending()`：启动检查——当前版本 < 目标版本 且未超 10 分钟 → true；版本达标/超时/损坏 → 清理并放行。
  - 三处 `quitAndInstall` 归一为 `installAndRestart()`。
  - `entry.ts`：`whenReady` 开头检查，命中则 `showMessageBoxSync` 提示 + `app.quit()`。
- 未真机验证（需跨版本，下次发版验证）。

## 关键设计（沿用）

- 任务管理器 `src/infra/task-manager.ts`：进程表 + 进程树杀（Win `taskkill /T /F`，**stop 里不能同时 child.kill()**）。输出 `decodeOutput`（GBK 兼容）。
- 窗口结构：AI 页面用 `ctx.view.webContents`，不是 `ctx.win.webContents`。
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`。

## ⚠️ 待排查（重要，未修）

**全局规则第 4 条未注入**：`~/.cuckoo/rules/global-override.md` 有「4. 复杂代码修改后使用子代理检查，主代理审计」及第 46 行「> 也可派出子代理检查，你在审计」，但系统提示词注入的 global-override 里这两行丢失。疑似规则注入被截断/旧缓存。**待排查**。

## 待办事项 (Next Steps)

- [ ] **排查规则注入丢失 bug**
- [ ] 真机验证 v0.8.46 更新并发保护（跨版本：装 v0.8.46 后等下个版本发布验证）
- [ ] 确认 CI（tag v0.8.40~v0.8.46）Win+Mac 构建成功

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`（Win+Mac）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 全局规则：`~/.cuckoo/rules/global-override.md`（第 4 条：复杂改动后派子代理检查 + 主代理审计——**注入丢失待查**）
- 发版流程：写 CHANGELOG → `npm version X --no-git-tag-version` → commit → `git tag -a vX` → push master + push tag
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push master）
- **用户偏好**：改完代码主动 commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
- **真机验证注意**：本机常驻 **7 个 Cuckoo-Code.exe（打包版）**，占单实例锁 → 开发版 `npx electron .` 拿不到锁会静默退出。验证开发版需 `CUCKOO_SESSION_DIR=cuckoo-dev-verify npx electron . --remote-debugging-port=9444` + Node CDP 直连。
