# 最新接续状态 (2026-10-13 17:13)

## 核心进展

本轮 v0.8.39（任务页）+ v0.8.40（Token 统计按窗口）已完成、验证全绿、待提交发版。分支 **feat/038-token-by-window**（037 已合并 master 并打 tag v0.8.39）。

## 本轮两个功能

### v0.8.39 · 任务页（feat/037-task-runner，已合并 master + tag）
命令 / package.json scripts / AI 后台命令统一管理。详见 `docs/requirements/037-task-runner.md`。
- infra/task-manager（进程表 + 进程树杀 taskkill /T /F）、bash 工具 background 参数、app/ipc/task、壳页面任务页
- **修了个真 bug**：stop 抢先 child.kill() 导致 taskkill /T 找不到子进程树 → 子进程残留；改为只走 taskkill
- 验证：typecheck/compile/lint/test 全绿 + 核心逻辑实测 11/11 + 进程树杀实测

### v0.8.40 · Token 统计按窗口（feat/038-token-by-window，待提交）
- **新增「今日全窗口」**（全局 × 今日），填补缺失维度
- **命名消歧**：「今日窗口」→「今日本窗口」，「窗口累计」→「本窗口历史累计」
- **柱图改为按窗口展示今日用量**（替换原近 10 天趋势），含窗口名，点击看占比 + 历史累计
- token-stats.ts 扩展为对象存储（`{cumulative, today, todayDate, name}`，兼容旧 v1 数字格式），跨天自动归零
- 数据流：overlay 上报 → shell.ts setWindowUsage + broadcastWindowUsage → 壳页面柱图

## 关键设计与实现

详见 `docs/requirements/038-token-by-window.md`。

## 验证结果

- v0.8.40：typecheck ✅ / compile ✅ / lint 0 error ✅ / test 970 passed ✅
- 产物确认：shell.html 含「今日全窗口」「本窗口历史累计」改动

## 待办事项 (Next Steps)

- [ ] **真机点验 v0.8.40**：Token 页看「今日全窗口」、柱图是否按窗口展示今日
- [ ] 真机点验 v0.8.39「任务」页（手动命令 / script / 停止 / 输出）
- [ ] 确认 CI（tag v0.8.27～v0.8.40）Win+Mac 构建

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 发版流程：写 CHANGELOG → bump package.json/lock（三处一致）→ commit → `git tag -a vX.Y.Z` → push master + push tag
- **用户偏好**：改完代码**主动** commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
