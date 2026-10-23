# 087 Git 面板「全部撤销」

- **类型**：feature
- **状态**：done
- **分支**：feat/087-git-discard-all
- **日期**：2026-10-23

## 需求

「源代码管理」面板的「更改」分组增加「全部撤销」按钮，一键清空**更改区**全部内容。

## 语义（用户最终确认）

「全部撤销」= 清空更改区，即 `git restore -- .` + `git clean -fd`：

1. **已跟踪文件**：从暂存区恢复到工作区（撤销未暂存的修改）
2. **未跟踪文件/目录**：永久删除
3. **不动暂存区** —— 已暂存的改动属于「已暂存」区，由「全部取消」处理
4. **不删被 .gitignore 忽略的文件** —— `clean` 不带 `-x`

对照关系：
- 「全部取消」（已暂存分组）= `git reset` 取消暂存
- 「全部撤销」（更改分组）= 清空更改区（恢复 + 删除）

## 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 主进程 | `src/app/ipc/git.ts` | `git-discard-all` → `restore -- .` + `clean -fd` |
| preload | `src/app/shell-preload.ts` | 暴露 `gitDiscardAll()` |
| 类型 | `src/ui/shell/scripts/shell-api.ts` | `gitDiscardAll?: () => Promise<any>` |
| 页面 | `src/ui/shell/scripts/pages/git.ts` | `groupHtml` 支持第二动作；changed 分组挂「全部撤销」；`doBulk` 分支 + 动态确认文案 |
| 样式 | `src/ui/shell/styles/pages.css` | `.ck-git-act-danger` 红色常驻可见 |
| 档案 | `docs/requirements/087-git-discard-all.md` | 本文件 |

## 安全设计

1. **动态二次确认**：文案按实际内容生成「将撤销 N 个已跟踪文件的改动，并永久删除 M 个未跟踪文件」，用户点确定前知道确切后果。
2. **按钮红色常驻可见**：不做隐藏（曾用 `opacity: 0` 导致用户看不见、以为功能坏了）。
3. **空操作提示**：更改区无内容时弹纯提示框（取消按钮隐藏），不执行任何 git 操作。
4. **失败必告知**：`doBulk` 检查返回值，失败弹 `ckAlert`（如 unmerged 冲突会让 restore 整体中止）。
5. **路径安全**：`execFile('git', [参数数组])`，无 shell 拼接；不接收用户路径输入。

## 验证

- [x] typecheck / lint(0 errors) / compile / test(129 文件 1230 条) 全绿
- [x] 子代理审查（arch-guard 合规；code-reviewer 2 条中等问题已修复）
- [x] 临时仓库实测 `restore + clean -fd`：已跟踪恢复原内容、未跟踪文件与目录被删、`.gitignore` 内文件保留
- [x] 真机端到端（CDP 9444）：按钮可见 → 点击弹动态确认（"将撤销 1 个已跟踪文件的改动，并永久删除 3 个未跟踪文件"）→ 确定 → `git status` 全空、tracked.txt 恢复 ORIGINAL、untracked.txt/newdir 已删、ignored-dir/keep.txt 保留
