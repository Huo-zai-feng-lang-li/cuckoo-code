# 最新接续状态 (2026-10-13 18:19)

## 核心进展

本轮连续推进 v0.8.40 → v0.8.45（6 个版本），全部已提交、打 tag、推送 origin。最新 tag **v0.8.45**。工作区干净，master 与 origin 同步。

主要两大块：**任务页**（037，命令/scripts/AI后台命令统一管理）+ **Token 统计改造** + **自动更新修复**。

## 版本清单（本轮）

- **v0.8.40**：Token 统计按窗口——新增「今日全窗口」、命名消歧（今日窗口→今日本窗口、窗口累计→本窗口历史累计）、柱图改按窗口
- **v0.8.41**：柱图改回按天（数值=全窗口每日总量，新增 `__daily__` 快照）+ 预估费用改按今日全窗口 + 自动更新一键化
- **v0.8.42**：任务页修复——折叠误用未定义 `ck-hidden`（应 `cuckoo-hidden`）、scripts 按钮改执行 `npm run <name>`、运行后自动展开输出
- **v0.8.43**：任务输出中文乱码（cmd 是 GBK，改用 `decodeOutput`）
- **v0.8.44**：自动更新静默安装（`quitAndInstall(true, true)` 传 /S 跳过 NSIS 向导 + 自动重启）+ 规则页保存提示「新对话生效」
- **v0.8.45**：Token 页「今日全窗口」「预估费用」高亮（斜体放大 + 琥珀色）

## 核心动机与背景

- 用户最初痛点：AI 跑 `npm run dev` 停不掉、看不到 → 催生任务页（v0.8.39 已做，本轮后续修复）
- Token 页口径混乱 + 缺"全局今日"维度 → v0.8.40/41
- 自动更新每次要手动装、还弹 NSIS 安装向导 → v0.8.41/44
- 任务页折叠失效、脚本跑不起来、输出乱码 → v0.8.42/43

## 关键设计与实现

- **任务管理器**（`src/infra/task-manager.ts`）：进程表 + 进程树杀。Windows `taskkill /T /F`（**注意**：stop 里不能同时 `child.kill()`，否则 taskkill 找不到子进程树 → 子进程残留）。输出用 `decodeOutput` 解码（GBK 兼容）
- **Token 统计**（`src/app/token-stats.ts`）：存储 v3 = `{ "<profileId>": {cumulative,today,todayDate,name}, "__daily__": {日期:全窗口总量} }`，兼容 v1 数字/v2。跨天 todayDate 不符则 today 归零
- **自动更新**（`src/updater/index.ts`）：三处 `quitAndInstall(true, true)`（isSilent 传 /S 给 NSIS，isForceRunAfter 装完自动重启）。子代理 code-reviewer 已源码级验证 `NsisUpdater.js:107-113`
- **任务页**（`src/ui/shell/scripts/pages/tasks.ts`）：全局隐藏类是 `cuckoo-hidden`（**不是 ck-hidden**，项目里无全局 ck-hidden，只有 git 两个特例）；scripts 按钮执行 `npm run <name>`

## ⚠️ 发现的产品 Bug（未修，重要）

**全局规则第 4 条未注入**：用户的 `~/.cuckoo/rules/global-override.md` 第 25 行有「4. 复杂代码修改后使用子代理检查，主代理审计」、第 46 行有「> 也可派出子代理检查，你在审计」，但**系统提示词注入的 global-override 里这两行丢失**（第 3 条措辞也由"工具/mcp"变成"mcp"）。疑似**规则注入被截断/用了旧缓存**。用户重启 IDE 后重读文件确认文件是对的 → 问题在**注入环节**。**待排查**。

## 待办事项 (Next Steps)

- [ ] **排查规则注入丢失 bug**（上面那条，疑似缓存或截断）
- [ ] 真机验证 v0.8.40~v0.8.45 各项：Token 页高亮/柱图、任务页折叠/跑脚本/输出/停止、规则页提示
- [ ] 自动更新静默安装需**跨版本**才能真机验证（装 v0.8.44+ 后，等下个版本发布）
- [ ] 确认 CI（tag v0.8.40~v0.8.45）Win+Mac 构建成功
- [ ] 旧待办：v0.8.35~v0.8.39 各项真机复核（Git 历史不闪、全部折叠、任务页等）

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`（Win+Mac）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 全局规则：`~/.cuckoo/rules/global-override.md`（第 4 条：复杂改动后派子代理检查 + 主代理审计——用户已确认此条存在，但注入丢失待查）
- 发版流程：写 CHANGELOG → `npm version X --no-git-tag-version` → commit → `git tag -a vX` → push master + push tag
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push master）
- **用户偏好**：改完代码主动 commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
