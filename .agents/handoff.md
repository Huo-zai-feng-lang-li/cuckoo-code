# 最新接续状态 (2026-10-12 15:12)

## 核心进展
- **v0.8.14 已发版**：tag `v0.8.14`（commit `f6238cc`）已 push，CI 自动构建 Win+Mac Release。
- **本会话（v0.8.14 之后）完成**：文件管理（新建/重命名/删除走回收站）+ git diff + 冲突查看差异 + diff 隐藏树 + 弹框换行 + 纯净/原版叠加修复。
- **文件树交互改造**：行内操作从「右键菜单」改为「hover 图标」（目录=新建文件/新建文件夹/重命名/删除；文件=重命名/删除）；顶部工具栏加常驻「新建文件/新建文件夹」按钮；**彻底移除右键菜单**（showCtxMenu 函数 + ck-ctx-menu 样式，因右键菜单点非工作区关不掉）。改动文件：src/ui/shell/scripts/pages/files.ts、src/ui/shell/partials/pages/files.html、src/ui/shell/styles/components.css、test/ui/files-manage.test.js。已 compile+typecheck+lint+test 全绿（962 通过）。
- HEAD 已与 origin/master 同步（`ada6bd7`），工作区干净。

## 核心动机与背景 (Motivation & Background)
- **文件管理缺失**：文件树只读，用户要能新建/重命名/删除 → 加右键菜单 + IPC。
- **变更可视化**：要像 VSCode 那样看"相对上次提交改了啥" → 加 git diff 视图。
- **冲突不丢数据**：外部改了文件且本地有未保存编辑 → 三选一（采用外部版/查看差异/保留我的），而非盲选。
- **diff 太窄**：预览区被文件树占一半 → diff 时隐藏树。
- **纯净/原版叠加**：进纯净模式后 AI 页面残留透出 → 治本（body 不透明）+ 双保险（bounds 归零）。
- **弹框换行**：`\n` 被 HTML 折叠 → `white-space: pre-wrap`。

## 关键设计与实现 (Implementation & Decisions)
- **文件管理**（`src/app/ipc/session.ts` + `pages/files.ts`）：
  - IPC：`create/rename/delete-project-entry`（复用 `resolveProjectPath` 防穿越；删除走 `shell.trashItem` 回收站；拒绝操作项目根目录；非法名正则拦截）。
  - 前端：`showCtxMenu` 通用右键菜单（目录=新建文件/夹+重命名+删除；文件=重命名+删除；空白=根新建）。
- **Diff**（`preview-monaco.ts` + `preview.ts`）：
  - `showDiff` 用 Monaco `createDiffEditor`（`renderSideBySide:false` 内联）。
  - 基准 = `git show HEAD:<file>`（IPC `git-show-file`，execFile）；修改侧 = 编辑器当前内容。
  - **独立容器** `#ck-monaco-diff`，不覆盖编辑器 model、不丢未保存编辑。
- **冲突三选一**：`shared.ts` 加 `ckDialog3`；`preview.ts` `onExternalChange` → primary=采用外部版 / alt=查看差异（`showConflictDiff`+`showConflictBar` 决策条）/ cancel=保留我的。
- **diff 隐藏树**：`.ck-files-cols.diff-mode .ck-ft{display:none}`，`setDiffTreeHidden()` 控制；退出/切文件恢复。
- **纯净叠加修复**：`harness.html` body 背景 `transparent→var(--bg)`（不透明治本；插件壁纸用 `!important` 仍可覆盖）；`entry.ts` 隐藏 AI 视图时 `setVisible(false)+setBounds(0)` 双保险。
- **弹框换行**：`.ck-dialog-msg` 加 `white-space:pre-wrap`，弹框 `max-width 280→420px`。

## 待办事项 (Next Steps)
- [ ] **真机验收 v0.8.14 之后改动**（主进程+前端，需重启）：① 行内 hover 图标（目录=新建文件/夹+重命名+删除；文件=重命名+删除）② 删除进回收站可恢复 ③ Diff 按钮对比+树隐藏 ④ 冲突三选一+查看差异 ⑤ 纯净模式无叠加 ⑥ 弹框换行 ⑦ 顶部「新建文件/文件夹」按钮
- [ ] 确认 GitHub Actions CI 构建成功
- [ ] 遗留 3 项（backup/pre-ff 有、master 无）：子进程树 taskkill、IPC 白名单、删 fab.ts

## 关键上下文
- 目录: D:\\Desktop\\Super-File\\cuckoo-code
- 主要文件:
  - `src/app/ipc/session.ts`（文件 read/write/create/rename/delete + git-show + watch）
  - `src/ui/shell/scripts/preview.ts`（自动刷新 + 冲突三选一 + diff）
  - `src/ui/shell/scripts/preview-monaco.ts`（Monaco 编辑 + diff）
  - `src/ui/shell/scripts/pages/files.ts`（文件树 + 右键菜单）
  - `src/ui/shell/scripts/shared.ts`（ckDialog/ckDialog3/ckPrompt）
  - `src/ui/harness.html`（纯净模式，手写源）
  - `.cuckoo/rules/project.md`（含「发版纪律」）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- CDP 调试：Electron `--remote-debugging-port=9333`（`/json` 列 target）
- 发版流程：汇总上次 tag 后提交 → 写 CHANGELOG → bump package.json/lock → commit → tag → push tag（触发 CI）
- 用户偏好: **改完代码不主动 commit/push**，等明确指示才提交；提交前分离无关改动
