---
id: 037
type: feature
title: 任务运行器（命令 / scripts / AI 后台命令统一管理）
status: done
branch: feat/037-task-runner
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

用户在 Cuckoo Code 里跑 `npm run dev` 这类**长驻命令**时：
- 命令一直不结束 → AI 那轮对话卡在"执行中"
- 到 30s 超时被强制 kill，进程可能残留
- **UI 上没有任何入口**能查看或停止它，用户只能关闭 exe 强杀

根因：现有 `bash` 工具与 `execute-command` IPC 都是"一次性阻塞命令"（`exec` + 30s timeout），**没有后台任务/进程表的概念**。

## 目标

1. **手动命令**：壳页面新增「任务」页，可手动输入任意命令运行
2. **一键 scripts**：自动读当前项目 `package.json` 的 `scripts`，每个渲染成按钮，点击运行
3. **统一进程表**：手动命令、scripts、AI 后台命令，三者在同一个列表里可见、可停
4. **AI 后台命令**：`bash` 工具新增 `background` 参数；AI 判断为长驻命令时用后台模式启动 → 进列表
5. **实时输出**：可查看每个任务的输出（环形缓冲）
6. **精准停止**：一键杀掉整棵进程树（Windows `taskkill /T /F`；Unix 进程组 SIGTERM）
7. **自动清理**：退出时杀干净，不留孤儿进程

## 非目标

- 不做完整终端模拟器（无 PTY、无交互式 stdin、无 tab 补全）
- 不做命令历史/持久化（进程表仅内存）

## 设计要点

### 分层与依赖

```
infra/task-manager.ts   ← 纯 node（child_process），回调注入通知
        ↑ 注入
tools/impl/bash.ts      ← background 参数 → 任务管理器
        ↑ 注入
app/ipc/task.ts         ← IPC 编排
app/entry.ts            ← 装配 + 生命周期清理
```

- 任务管理器放 **infra**（只依赖 `node:child_process` / `node:path` / `node:fs`）
- 通知 UI 用**回调注入**（`setChangeListener`），infra 不依赖上层

### 边界与性能

- **输出缓冲**：环形，单任务上限 256KB（超出丢头部，防无界内存）
- **进程树杀**：Windows `taskkill /pid PID /T /F`；Unix spawn 时 `detached: true` + `process.kill(-pid)`
- **孤儿防护**：`app.on('before-quit')` → `dispose()` 杀全部
- **并发上限**：同时最多 20 个后台任务，超出拒绝
- **危险命令**：start 前过 `isDangerous` 拦截
- **防闪屏**：列表签名未变则不重建 DOM，只增量刷输出

## 实现文件

| 文件 | 改动 |
|---|---|
| `src/infra/task-manager.ts` | 新增：进程表 + start/stop/list/output/remove/dispose/readPackageScripts |
| `src/tools/impl/bash.ts` | 加 `background` 参数（apiMetas + bootstrap + schema + execute） |
| `src/app/ipc/task.ts` | 新增：7 个 IPC + 变更广播 |
| `src/app/ipc/index.ts` | 注册 registerTaskIpc |
| `src/app/shell-preload.ts` | 暴露 task* API + onTasksChanged |
| `src/app/entry.ts` | before-quit 调 taskManager.dispose() |
| `src/ui/shell/scripts/shell-api.ts` | 补任务 API 类型 |
| `src/ui/shell/partials/activitybar.html` | 加「任务」图标 + badge |
| `src/ui/shell/partials/pages/tasks.html` | 新增页面 |
| `src/ui/shell/scripts/pages/tasks.ts` | 新增页面脚本 |
| `src/ui/shell/scripts/main.ts` | 注册 tab |
| `src/ui/shell/index.html` | 引入页面 partial |
| `src/ui/shell/styles/pages.css` | 追加任务页样式 |

## 验收标准

- [x] 「任务」页可手动敲命令运行，实时看输出
- [x] 自动列出 `package.json` scripts，一键运行
- [x] AI 用 `bash background=true` 跑的长驻命令出现在列表
- [x] 停止按钮精准杀进程树（含子进程）——实测验证
- [x] 退出时杀干净，不留孤儿进程
- [x] typecheck / test / lint / compile 全绿
- [ ] 真机 UI 人工点验（待用户确认）

## 验证记录

- typecheck ✅ / compile ✅ / lint 0 error ✅ / test 970 passed ✅
- 核心逻辑实测 11/11（start/输出/stop/list/remove/readPackageScripts）
- 进程树杀实测：修复顺序 bug（stop 抢先 child.kill）后，子进程被正确杀掉
