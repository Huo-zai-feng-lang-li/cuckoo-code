---
id: 046
type: feature
title: 提交详情查看 diff（源代码管理）
status: doing
branch: feat/046-commit-diff
created: 2026-10-13
updated: 2026-10-13
---

## 背景

源代码管理页的「提交历史」点某条提交，当前只用 `ckAlert` 弹出 `git log -1 --stat` 的**原始纯文本**（未格式化、不可滚动、无着色），看不到具体改了哪些行。

## 目标

点提交 → 弹出**专用详情弹框**，展示该提交的完整 diff：
- 顶部：提交元信息（hash / 标题 / 作者·时间，来自 stat 头部）
- 正文：`git show` 输出（diffstat + patch），等宽字体、可滚动
- patch 着色：`+` 行绿、`-` 行红、`@@` 块头蓝、`diff --git`/`+++`/`---` 等文件头加粗

### 范围

- ✅ 新增 IPC `git-show-commit-diff`（`git show --patch`，含大输出截断保护）
- ✅ 新增专用弹框（modals.html）+ 着色渲染 + CSS
- ✅ 保留原 `git-show-commit`（stat 摘要）作降级/兼容
- ❌ 不做：逐文件折叠、行内评论、并排视图（Monaco）、跨提交对比

## 实现要点

1. 主进程 `src/app/ipc/git.ts`：新增 handler，跑 `git -c core.quotepath=false show --no-color --patch <hash>`，输出超 512KB 截断并附提示；校验 hash 合法性。
2. `src/app/shell-preload.ts` + `src/ui/shell/scripts/shell-api.ts`：暴露/声明 `gitShowCommitDiff`。
3. `src/ui/shell/partials/pages/../modals.html`：新增 `#git-diff-modal`。
4. `src/ui/shell/scripts/pages/git.ts`：`showCommit` 改为打开弹框并渲染着色。
5. `src/ui/shell/styles/pages.css`：`.ck-git-diff-*` 样式。
6. 改完 `npm run compile` 重建 shell.html。

## 验证

- [ ] typecheck / test / lint / compile 全绿
- [ ] 真机：点提交 → 弹框显示 diff；大提交截断提示；非 git 目录/非法 hash 报错
