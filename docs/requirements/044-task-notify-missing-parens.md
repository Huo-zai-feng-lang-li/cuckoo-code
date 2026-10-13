---
id: 044
type: fix
title: 任务状态变更不自动刷新（isDestroyed 漏括号致通知永不推送）
status: done
branch: fix/044-task-notify-missing-parens
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

任务页「任务列表」状态不自动刷新：停止任务后按钮一直显示「停止中…」，手动点刷新按钮才更新。

## 根因

`src/app/ipc/task.ts` 的 `broadcastChange()`（任务变更 → 推 `shell-tasks-changed` 给壳页面）里：

```ts
if (ctx.win && !ctx.win.isDestroyed && ctx.win.webContents) {  // ← 漏括号
```

`isDestroyed` 是**方法**，`!ctx.win.isDestroyed`（未调用）恒为 `false` → 整个条件**永远 false** → `webContents.send('shell-tasks-changed')` **从未执行**。

影响：**所有任务状态变更都不推送**（启动/输出/停止/退出/stopping），不止"停止中"。启动时因代码里手动调了 `loadTasks()` 才显示出来，掩盖了问题。

## 修复

补括号 `!ctx.win.isDestroyed()`，并加 `!ctx.win.webContents.isDestroyed()` 更稳。

## 验收

- 启动任务后不点刷新，停止 → DOM 自动刷新为「退出码 1」+ 移除按钮 ✓
- `onTasksChanged` 计数器：运行期间收到 8 次推送、停止后 +3 次 ✓
