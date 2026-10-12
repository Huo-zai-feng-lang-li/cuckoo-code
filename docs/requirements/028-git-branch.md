---
id: 028
type: feature
title: Git 面板分支支持（显示当前分支 + 切换）
status: doing
branch: feat/028-git-branch
created: 2026-10-12
updated: 2026-10-12
---

## 背景

需求 026 新增的 Git 源代码管理面板只有「更改/已暂存」列表与提交能力，**看不到当前分支，也不能切换分支**。对标 VS Code，源代码管理面板顶部应有当前分支显示，并支持切换。

## 目标

- 面板顶部显示当前分支名
- 点击可切换分支（列出本地分支）
- 切换前检测未提交改动，有则警告/阻止（防丢数据）

### 范围

- ✅ 当前分支显示
- ✅ 本地分支列表 + 切换
- ✅ 脏工作区检测（有未提交改动时二次确认或阻止）
- ❌ 不做：新建分支、删除分支、远程分支、合并/rebase

## 方案

### 主进程（src/app/ipc/git.ts）

| IPC | 命令 | 说明 |
|---|---|---|
| `git-current-branch` | `git branch --show-current` | 当前分支名 |
| `git-list-branches` | `git branch --format=...` | 本地分支列表 |
| `git-checkout` | `git checkout <branch>` | 切换分支（先查脏工作区） |

### 脏工作区检测

`git-checkout` 前先跑 `git status --porcelain`：
- 有改动 → 返回 `{ success: false, dirty: true }`，由 UI 决定是否强制
- 无改动 → 直接切换

### UI（git.html + git.ts）

- 顶部一行：`⎇ <当前分支>`（点击展开分支列表）
- 分支列表：点选切换；脏工作区时弹二次确认

## 验收标准

- [ ] 面板顶部显示当前分支
- [ ] 可列出本地分支并切换
- [ ] 有未提交改动时切换会警告
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- 新建/删除分支、远程分支、合并/rebase 未纳入
