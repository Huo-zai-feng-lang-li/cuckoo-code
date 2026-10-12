---
id: 026
type: feature
title: 源代码管理面板（Git 暂存/提交/撤销）
status: done
branch: feat/026-git-panel
created: 2026-10-12
updated: 2026-10-12
---

## 背景

Cuckoo Code 目前只有零星的 git 能力：文件预览的「Diff」按钮（走 `git-show-file` IPC，取 HEAD 版本对比），以及各处对 `.git` 目录的忽略。**没有任何图形化的 Git 管理界面**——暂存、提交、撤销全靠 AI 通过 bash 调 git 命令完成。

对标 VS Code 的「源代码管理」面板，用户需要一个能直接看到改动、暂存、提交、撤销的图形界面。

## 目标

在活动栏新增独立的「源代码管理」图标（分支形状 + badge 显示改动数），点击展开面板：

- **更改列表**：`git status --porcelain` 解析，显示未暂存的文件（状态字母 + 路径）
- **已暂存列表**：显示已暂存的改动
- **单文件操作**：暂存(+)、取消暂存(−)、撤销(↩)、点击看 diff（复用 `git-show-file`）
- **提交**：底部输入框 + 提交按钮，只提交已暂存的改动（标准 git 流程）
- **撤销**：`git restore`（丢弃工作区改动），**必须二次确认**（丢数据操作）

### 范围

- ✅ 新建独立活动栏图标 + 面板（VS Code 式布局）
- ✅ 5 个 git IPC：status / stage / unstage / restore / commit
- ✅ badge 显示改动总数
- ✅ 撤销/提交二次确认
- ❌ 不做：分支切换、提交历史图（「图形」）、冲突解决、远程操作（push/pull）

## 方案

### 分层（遵守依赖铁律）

- `src/ui/shell/`（UI 层）：只调 `window.shellAPI.git*`，不碰主进程
- `src/app/ipc/git.ts`（主进程）：新建独立模块，5 个 IPC handler
- `src/app/shell-preload.ts`（preload）：暴露 5 个 api

### 安全措施

- `execFile('git', [参数数组])`，**绝不拼 shell 字符串**（防注入）
- 路径过 `resolveProjectPath`（防目录穿越，复用 session.ts 的实现）
- 撤销/提交前 UI 二次确认

### 新增 IPC

| IPC | 命令 | 危险度 |
|---|---|---|
| `git-status` | `git status --porcelain=v1` | 只读 |
| `git-stage` | `git add -- <path>` | 低 |
| `git-unstage` | `git restore --staged -- <path>` | 低 |
| `git-restore` | `git restore -- <path>` | **高（丢改动）** |
| `git-commit` | `git commit -m <msg>` | 中 |

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/app/ipc/git.ts` | 新建，5 个 git IPC |
| `src/app/entry.ts` | 注册 registerGitIpc() |
| `src/app/shell-preload.ts` | 暴露 5 个 api |
| `src/ui/shell/scripts/shell-api.ts` | 补 5 个方法类型 |
| `src/ui/shell/partials/activitybar.html` | 加 Git 图标（纯加法） |
| `src/ui/shell/partials/pages/git.html` | 新建面板 |
| `src/ui/shell/scripts/pages/git.ts` | 新建逻辑 |
| `src/ui/shell/scripts/main.ts` | registerTab('git', ...) |
| `src/ui/shell/index.html` | @include pages/git.html |
| `src/ui/shell/styles/pages.css` | badge + 面板样式 |

## 验收标准

- [ ] 活动栏出现 Git 图标，badge 显示改动数（0 时不显示）
- [ ] 更改/已暂存分组正确显示 `git status --porcelain` 结果
- [ ] 暂存/取消暂存/撤销生效，列表与 badge 实时刷新
- [ ] 撤销有二次确认，确认后文件回退到 HEAD
- [ ] 提交只提交已暂存改动，提交后清空输入框
- [ ] 点击文件显示 diff（复用 git-show-file）
- [ ] 空改动 / 非 git 目录 / 无项目目录 均有友好提示
- [ ] typecheck + lint + compile 全绿；真机验证通过

## 遗留

- 「图形」（提交历史图）留待 Phase 2
- 分支切换、冲突解决、远程操作未纳入本次范围
