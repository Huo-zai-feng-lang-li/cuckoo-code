---
id: 035
type: feature
title: Git 面板增强——提交历史 + 自动刷新
status: done
branch: feat/035-git-history-refresh
created: 2026-10-13
updated: 2026-10-13
---

## 背景

1. **无提交历史**：Git 面板只有分支栏 + 提交框 + 文件列表，看不到提交历史（VSCode 的"图形"缺失）。
2. **不自动刷新**：`loadGit()` 仅在 4 个时机触发（切 tab / 点刷新 / Git 操作后 / 项目目录变化）。停在面板时，AI 改文件、外部编辑器改动**完全看不到**，需手动刷新。

## 目标

### A. 提交历史列表
- `git log` 式列表：短 hash + 提交信息 + 作者 + 相对时间
- 点击某次提交 → 查看该提交的改动（diff）

### B. 自动刷新
- 项目文件变化 → 近实时刷新 Git 状态
- 只在 Git 面板激活时刷新（省资源）
- 排除噪声目录（node_modules/.git/objects 等）

### 范围
- ✅ 主进程：git-log IPC + fs.watch 推送
- ✅ preload/shell-api：暴露新接口与事件订阅
- ✅ UI：历史列表区 + 自动刷新接线
- ❌ 不做：图形分支线（DAG，后续可选）

## 方案

### A. 提交历史
- 主进程 `git-log`：`git log --pretty=format:... -n 50`，解析为 {hash, shortHash, subject, author, date}
- 主进程 `git-show`（或复用现有 diff 机制）：点提交看改动
- UI：文件列表下方加"历史"折叠区，懒加载（展开时才拉）

### B. 自动刷新
- 主进程监听项目根目录（`fs.watch recursive`，Windows 支持；失败降级定时轮询）
- 防抖 400ms + 排除噪声目录 → 推 `shell-git-changed`
- 壳页面收信号 → **仅当 Git tab 激活** → `loadGit()`
- 生命周期：项目目录变化/窗口关闭时清理 watcher

## 验收标准

- [ ] Git 面板显示提交历史（hash/信息/作者/时间）
- [ ] 点提交可查看该次改动
- [ ] 面板激活时，文件变化 → 自动刷新（无需手动点）
- [ ] 非激活时不空跑（省资源）
- [ ] 大项目（含 node_modules）不因噪声频繁刷新
- [ ] typecheck + lint + compile + test 全绿

## 遗留
- 图形分支线（DAG）后续可选
