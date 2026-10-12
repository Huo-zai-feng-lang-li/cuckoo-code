# 最新接续状态 (2026-10-12 20:30)

## 进行中：需求 026 源代码管理面板（Git）

- **分支**：`feat/026-git-panel`（基于 master 7daf240/v0.8.17）
- **档案**：`docs/requirements/026-git-panel.md`
- **状态**：代码完成 + 静态验证全绿（compile/typecheck/lint/test），**待真机验证**

### 改动文件（8 个）
- 新建 `src/app/ipc/git.ts`（6 IPC：git-status/stage/unstage/restore/discard-untracked/commit）
- 新建 `src/ui/shell/partials/pages/git.html` + `scripts/pages/git.ts`
- 改：`src/app/ipc/index.ts`（注册）、`shell-preload.ts`（暴露 6 api）、`shell-api.ts`（类型）、`main.ts`（registerTab + 预加载）、`partials/activitybar.html`（图标+badge）、`index.html`（include）、`styles/base.css`（badge）、`styles/pages.css`（面板）

### 已知修复的 Bug
1. 未跟踪文件用「删除」而非「撤销」（git restore 对 ?? 无效）
2. 首次提交前 unstage 回退 `git rm --cached`
3. 提交按钮误判（区分已暂存组）
4. 中文文件名八进制乱码（`-c core.quotepath=false` + unquoteGitPath）

### 待真机验证项
- [ ] 活动栏 Git 图标 + badge 改动数
- [ ] 暂存/取消暂存/撤销（含二次确认）/删除未跟踪/提交
- [ ] 点击文件跳转文件页预览
- [ ] 空改动/非 git 目录/无项目目录 提示
- [ ] 提交按钮 disabled 状态

---

# 历史接续状态 (2026-10-12 21:30)

## 核心进展
- **v0.8.16 已发布**：修复通知点击偶尔打不开窗口（3 根因：Notification 被 GC / 旧窗口引用 / 前台激活弱）。tag + master 均已推送 origin。
- **v0.8.15 已发布**：需求 025「纯净模式真截断」（真机验证通过）+ 元面板增强（图表/预估费用/指标改名）+ 文件管理增强。
- **feat/025 分支已删除**（本地 + origin，已完全合入 master）。
- **通知 bug 修复**（src/app/ipc/renderer.ts）：① Notification 持引用 + 定长数组上限防 GC/泄漏；② 点击时按 profileId 动态重查窗口（三级兜底）；③ bringWindowToFront 临时置顶抢前台。
- **元面板微调**：5 个 `!` 图标 hover 说明；图标垂直对齐 translateY(1px) 微调（待真机确认）。

## 待办事项 (Next Steps)
- [ ] **真机验证 v0.8.16 通知点击**（UI 运行时行为，静态测不出）：发消息 → 切走窗口 → 等通知 → 点击 → 确认窗口到前台；边界：窗口最小化/已关闭/多次通知。
- [ ] **真机确认元面板 `!` 图标对齐**（translateY 1px 是否合适，偏上/偏下再调）。
- [ ] 确认 GitHub Actions CI（tag v0.8.15 / v0.8.16）Win+Mac 构建成功。
- [ ] **CI 既有失败排查**：master coverage 工作流有 1 个测试失败（962 中 1，与本次改动无关），待查。
- [ ] **（可选）工具卡片分类图标**：当前所有工具共用写死"文档"图标（harness.html:2393），建议加 TOOL_ICONS 按类别映射（runAgent 用人形）。
- [ ] 遗留 3 项（backup/pre-ff 有、master 无）：子进程树 taskkill、IPC 白名单、删 fab.ts。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li（你的仓库，CI 所在）, 8555uuy=上游插件作者仓库（只读，勿 push）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 发版流程：汇总上次 tag 后提交 → 写 CHANGELOG → bump package.json/lock → commit → tag → push tag（触发 CI release.yml，自动构建 Win+Mac）
- **git 钩子**：`.githooks/post-commit` 自动 push origin 当前分支；`.githooks/pre-commit` 自动重建生成物 + 刷新需求 INDEX
- 用户偏好: **改完代码不主动 commit/push**，等明确指示才提交；提交前分离无关改动
