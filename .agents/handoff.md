# 最新接续状态 (2026-10-13 22:00)

## 核心进展

本轮（v0.8.27 → v0.8.37，共 11 个版本）集中做 **UI/功能体检修复 + 两项重构**，全部已提交、打 tag、推送 origin。最新 tag **v0.8.37**，工作区 clean。

## 核心动机与背景

用户逐个体检界面，报告问题 → 我修复 → 递增发版。本批覆盖 4 类：

1. **窗口组切换（需求 034）**：「转移对话」总报「IndexedDB 无该会话消息」。根因：切换直接读 IDB，而 DeepSeek 同会话内不更新 IDB、仅刷新才补齐（压缩能用正因它走了刷新）。修复：复刻压缩流程（清 IDB → 刷新 → 等 hook 重建 → 全量分享 → 回执），超时放宽 90s。
2. **视觉/交互细节**：F12 打不开 DevTools、字号模糊/溢出、Git 历史闪烁、图标 hover 旋转、工具栏间距、提交详情乱码等。
3. **Git 面板增强（需求 035）**：提交历史列表 + fs.watch 自动刷新 + 工作区「全部收起」。
4. **规则体系统一（需求 036）**：项目级规则目录 `.cuckoo/rules/` → `.agents/rules/`（兼容回退）+ 兼容 Cursor `trigger`/`globs` 格式 + 内置默认全局规则。

## 关键设计与实现

- **转移对话**（`src/session/compaction.ts`）：新增 `prepareSwitchShare`/`checkPendingSwitchShare`，reqId 经 localStorage 跨刷新回执；hook flag 加 `cuckoo-switch-share`。
- **窗口组提示**（`src/app/entry.ts` `notifyWindowSwitch`）：系统通知为主（toast 会被 AI WebContentsView 盖住）；手动转移也关源窗口（`reason`/`closeSource` 解耦）。
- **字号不模糊**（`src/app/harness-zoom.ts`）：放弃 `setZoomFactor`（视图缩放，非整数倍插值→模糊），改 **CSS `zoom`** 作用在 `.app` 上 + `calc(100vw/zoom)` 尺寸反向补偿（防溢出；且 `.app` 外的 fixed 元素不受影响）。
- **窗口空白**（`entry.ts`）：补 `restore`/`focus` 重排（此前缺这两个时机）。
- **F12**（`entry.ts` + `browser-window-manager.ts`）：三端绑定 + 判断 `keyDown`（否则按下开、抬起关）。
- **Git 历史**（`src/app/ipc/git.ts` + `ui/shell/scripts/pages/git.ts`）：`git-log`/`git-show-commit`；自动刷新走 `fs.watch recursive` + 400ms 防抖 + 噪声过滤，仅面板激活时刷。**闪烁修复**：内容签名（hash 列表）未变则跳过重绘。
- **规则统一**（`src/rules/scanner.ts` `scanProjectRules`）：优先 `.agents/rules/`，回退 `.cuckoo/rules/`；`frontmatter.ts` 无 `paths` 时回退解析 Cursor `globs`（逗号拆多路径、`always_on` 视为始终）；`files.ts` `seedDefaultRules` 首次写入 `~/.cuckoo/rules/global-default.md`（不覆盖用户已有 + seed 标记防复活）。

## 版本清单（v0.8.27 → v0.8.37）

| 版本 | 内容 |
|---|---|
| v0.8.27 | 记忆多行文本框 + 转移对话修复(034) + 切前台 harness 空白修复 |
| v0.8.28 | 切换提示恢复系统通知 + 手动转移关源窗口 + 字号「特大」130%→126% |
| v0.8.29 | 字号不模糊（CSS zoom） |
| v0.8.30 | 字号不溢出 + 设置页刷新恢复全部 + 修监听器泄漏 + 下载通知精简 |
| v0.8.31 | F12 修复（三端 + 工具窗口） |
| v0.8.32 | Git 历史 + 自动刷新(035) + 工作区全部收起 + 悬停双提示修复 |
| v0.8.33 | 规则目录统一到 .agents/rules/(036) + Cursor 兼容 + 内置默认规则 |
| v0.8.34 | 规则页 frontmatter 格式说明 |
| v0.8.35 | Git 历史防闪 + 项目文件全部折叠 + 图标不旋转 + 间距收窄 |
| v0.8.36 | 规则编辑自动滚动到编辑区 |
| v0.8.37 | 提交详情乱码修复（%x1f → %n） |

## 待办事项 (Next Steps)

- [ ] **装最新 exe（v0.8.37）真机验证**（全部为运行时行为，静态测不出）：
  - 转移对话不再报错 + 系统通知 + 源窗口关闭
  - 切前台/最小化恢复 harness 不空白
  - 字号「特大/超大」清晰且输入框不溢出
  - F12 三端（壳/AI/harness）+ 工具浏览器窗口开控制台
  - Git 提交历史（列表 + 点开详情不乱码）+ 自动刷新
  - 记忆编辑多行文本框、设置页刷新恢复、工作区全部收起、项目文件全部折叠
  - 规则页说明 + 规则编辑自动滚动
- [ ] 确认 CI（tag v0.8.27～v0.8.37）Win+Mac 构建成功

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li（你的仓库，CI 所在）；tag 推送触发 `.github/workflows/release.yml`
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 规则体系：项目级 `.agents/rules/*.md`（优先，回退 `.cuckoo/rules/`）；用户级 `~/.cuckoo/rules/`；兼容 Cursor `trigger`/`globs`
- 发版流程：写 CHANGELOG → bump package.json/lock（三处一致）→ commit → `git tag -a vX.Y.Z` → push master + push tag
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push）
- **用户偏好（已更新）**：改完代码**主动** commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
