---
id: 041
type: fix
title: 运行任务后滚动定位到刚运行的任务
status: done
branch: fix/041-scroll-to-new-task
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

v0.8.46 起运行命令/脚本后滚动到面板底部，但看不到刚运行任务的执行过程。

## 根因

任务列表**新任务在顶部**（`list()` 按 `startedAt` 倒序），滚到面板底部在任务多时看到的是**最旧**任务。

## 修复

`src/ui/shell/scripts/pages/tasks.ts`：`scrollToTaskList()`（滚容器底部）→ `scrollToTask(taskId)`：

```ts
item.scrollIntoView({ behavior: 'smooth', block: 'start' });
```

定位**刚运行的任务卡片**，配合已有的自动展开输出，直接看到执行过程。调用点：scripts 按钮 + 手动命令运行。

## 验收

CDP 真实 UI 路径：输入命令点运行 → `scrollIntoView` 被调一次，参数 `{behavior:'smooth', block:'start'}`，id 正是刚运行任务；该卡片输出已展开 ✓
