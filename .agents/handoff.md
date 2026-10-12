# 最新接续状态 (2026-10-12 20:30)

## 核心进展
- **v0.8.15 发版**：分支 `feat/025-harness-true-truncate`（与 master 同基点 `0d86bc9`），改动已提交并打 tag `v0.8.15`。
- **需求 025「纯净模式真截断」✅ 已完成并真机验证通过**：状态改 `done`。用户自测 4 项闭环（截断成功/发送失败回退/中途切会话/中途重载）全部通过，假设 #2（responseMessageId == IDB message_id）已核实。
- **元面板优化**：图表增强（汇总/数值/今日高亮/点击详情）+ 预估费用（DeepSeek Flash 单价粗估，含闲时/高峰）+ 指标改名消歧（当前上下文→本轮上下文，对话累计→各轮累计）+ 5 个 `!` 说明图标。
- **文件管理增强**（随 0.8.15 一起发）：文件新建/重命名/删除（回收站）+ git diff + 冲突查看 + diff 隐藏树 + 弹框换行。

## 待办事项 (Next Steps)
- [ ] 确认 GitHub Actions CI（tag `v0.8.15`）构建成功
- [ ] **（可选）工具卡片分类图标**：当前所有工具共用写死"文档"图标（`harness.html:2393`），建议加 `TOOL_ICONS` 按类别映射（runAgent 用人形）。
- [ ] 遗留 3 项（backup/pre-ff 有、master 无）：子进程树 taskkill、IPC 白名单、删 fab.ts
- [ ] CI 既有失败：master `0d86bc9` 的 coverage 工作流有 1 个测试失败（与 0.8.15 改动无关），待查。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li（CI 所在）, 8555uuy=个人 fork
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 发版流程：汇总上次 tag 后提交 → 写 CHANGELOG → bump package.json/lock → commit → tag → push tag（触发 CI release.yml，自动构建 Win+Mac）
- 用户偏好: **改完代码不主动 commit/push**（本次发版经用户明确指示后执行）；提交前分离无关改动
