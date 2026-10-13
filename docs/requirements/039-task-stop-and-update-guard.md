---
id: 039
type: fix
title: 任务停止态修复 + 运行后滚动 + 更新并发保护
status: done
branch: fix/039-task-stop-and-update-guard
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

v0.8.42 起任务页上线后，真机测试发现三个问题：

1. **停止按钮卡在"停止中…"**：点击停止后按钮一直不恢复。
2. **运行脚本/命令后看不到运行状态**：任务列表在页面下方，需手动滚动。
3. **更新静默安装期间可重复启动旧 exe**：安装窗口期无"门禁"，用户再双击旧图标会与安装程序争用文件，可能导致安装失败/版本混乱。

## 目标

1. **停止态单一来源**：停止中状态由主进程 `TaskInfo.stopping` 驱动，渲染层据此显示，不再手改 DOM。进程真退出后自动恢复。
2. **运行后滚动到底部**：运行命令/脚本后，任务页容器平滑滚到底部，露出任务列表。
3. **更新并发保护**：安装前写"更新中"标记；启动时检查——若当前版本仍低于目标版本且标记未过期，提示"更新进行中"并退出；版本达标或过期则清理标记、正常启动。

## 非目标

- 不消除安装本身的窗口闪动（NSIS 行为，系统层面）。
- 不做安装进度可视化（NSIS 静默安装无进度可读）。

## 设计要点

### 停止态（1）

- `src/infra/task-manager.ts`：`TaskInfo` 增 `stopping?: boolean`；`stop()` 置位后 `notifyChange()`；`toInfo` 透出。
- `src/ui/shell/scripts/pages/tasks.ts`：渲染签名纳入 `stopping`；`renderTaskItem` 据此渲染"停止中…"按钮（disabled）；停止 handler 只调 IPC + `loadTasks()`，不再手改按钮。

### 运行后滚动（2）

- 运行成功后 `await loadTasks()`（DOM 已更新）→ 让 `.ck-panel-body` 平滑滚到底部。

### 更新并发保护（3）

- `src/updater/index.ts`：
  - `markUpdatePending(targetVersion)`：安装前同步写 `<userData>/update-pending.json`。
  - `isUpdatePending()`：启动时检查，版本 `>=` 目标或超过 10 分钟则清理并返回 false。
  - 统一 `installAndRestart()`：写标记 + `quitAndInstall(true, true)`（三处调用归一）。
- `src/app/entry.ts`：`app.whenReady` 开头检查 `isUpdatePending()`，命中则弹提示 + `app.quit()`。

## 验收

- 停止一个长驻任务：按钮立即显示"停止中…"，进程退出后恢复为"已结束"，可移除。
- 运行脚本后任务页自动滚到底部，任务卡片可见。
- 更新安装期间启动旧 exe：提示"更新进行中"并退出；更新完成后启动正常。
