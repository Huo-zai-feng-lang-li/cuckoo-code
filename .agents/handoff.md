# 最新接续状态 (2026-10-13 16:22)

## 核心进展

本轮（v0.8.35 → v0.8.38）为 UI 细节修复 + 规则体系收尾，全部已提交、打 tag、推送 origin。最新 tag **v0.8.38**。

## 核心动机与背景

用户逐个体检界面报告问题 → 修复 → 递增发版。本轮 4 个版本：

1. **v0.8.35**：Git 提交历史展开后**一直闪**（根因：`loadHistory` 每次刷新清空重绘）；项目文件**缺「全部折叠」**；图标 hover 旋转、工具栏间距大。
2. **v0.8.36**：规则编辑弹框需手动下滑（上方是格式说明）。
3. **v0.8.37**：提交详情**乱码**（`%x1f` ASCII 控制字符显示成"□"）。
4. **v0.8.38**：纯净模式**空白回复气泡**（`clearPendingBubble` 删除条件漏删无 dots 的占位）。

## 关键设计与实现

- **Git 历史防闪**（`src/ui/shell/scripts/pages/git.ts`）：内容签名（hash 列表 `lastHistorySig`）未变则跳过重绘；非首次加载不显示"加载中…"；切分支/提交/换目录时重置签名。
- **项目文件全部折叠**（`files.ts` + `files.html`）：新增 `ft-collapse-all` 按钮，点击 `expanded.clear()` 后重渲染。
- **图标调整**（`src/ui/shell/styles/components.css`）：删 `.ck-icon-btn:hover svg` 的 360° 旋转；`.ck-actions` gap 8px→4px（全局各页统一，14 个页面共用）。
- **规则编辑自动滚动**（`rules.ts`）：`showEditor(true)` 时 `scrollToEditor()`（`requestAnimationFrame` + `scrollIntoView`）。
- **提交详情乱码**（`src/app/ipc/git.ts` `git-show-commit`）：format 从 `%x1f` 改 `%n`（`git-log` 的 `%x1f` 保留——前端按它拆分）。
- **空白气泡**（`src/ui/harness.html` `clearPendingBubble`）：删除条件由 `if (dots && !hasThink && !hasText)` 改为 `if (!hasThink && !hasText)`——去掉 `dots` 前置（经 `onStream` 创建的占位气泡不含 dots，旧条件漏删）。**已逐点核查 17 个调用点，无回归**。

## 附：技能目录调整

- 删除 `.agents/handoff.md`（旧内容）→ 后按用户要求重建（本文件）。
- 技能 `handoff` 已删除，内容并入 `~/.cuckoo/skills/a-handoff/SKILL.md`（含"时间铁律"：必须取系统实时时间）。

## 待办事项 (Next Steps)

- [ ] **装最新 exe（v0.8.38）真机验证**（全部为运行时行为，静态测不出）：
  - Git 提交历史：展开不闪；有 commit 后正确更新；点详情不乱码
  - 项目文件「全部折叠」生效；图标 hover 不旋转；工具栏间距变紧凑
  - 规则编辑自动滚动到编辑区
  - 纯净模式：纯思考/工具回合**不再残留空白气泡**（有思考则保留思考块）
  - 另需验证 v0.8.27~v0.8.34 的项（转移对话、字号、F12、切前台空白、Git 自动刷新等）
- [ ] 确认 CI（tag v0.8.27～v0.8.38）Win+Mac 构建成功

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`（Win+Mac）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 规则体系：项目级 `.agents/rules/*.md`（优先，回退 `.cuckoo/rules/`）；用户级 `~/.cuckoo/rules/`；兼容 Cursor `trigger`/`globs`
- 发版流程：写 CHANGELOG → bump package.json/lock（三处一致）→ commit → `git tag -a vX.Y.Z` → push master + push tag
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push）
- **用户偏好**：改完代码**主动** commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
