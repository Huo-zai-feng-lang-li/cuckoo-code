# 最新接续状态 (2026-10-28 22:30)

## 核心进展

- **v0.10.155 发版**：设置全局化 + 防封默认收紧 + 队列/停止加固，对抗性审计闭环。
- **审计（audit-staged）发现并修复 2 处真缺陷**：
  1. **🔴 防封迁移对老用户完全失效**：`global-settings.ts` 的 `LEGACY_DEFAULTS.sendDelay` 误写成需求文档目标值 4/12（旧代码真值是 1000/10000ms = **1/10 秒**）。老用户 localStorage 存 1/10 秒 → `migrateLegacy` 比对不命中 → 保留 1/10 秒，防封节奏优化（6/16）对其 100% 失效。已改为 1/10，并新增回归测试「旧真值 sendDelay 1/10 秒必须命中迁移」锁死语义。
  2. **🟡 多窗口并发保存时发起方 localStorage 持陈旧数据**：`save-settings` 广播跳过发起方。若两窗口在 await 窗口（~50ms）内并发保存**不同字段**，后完成方自己的 AI 页会永久缺对方刚写的字段（与落盘文件不一致，hook/loop 读的是 localStorage）。已改为广播不跳过发起方（幂等应用）。
- **注释/文档对齐**：`settings.ts:62` JSDoc（声称含 harnessView，实际只发 ctx.view）、`global-settings.ts` 头注释（sendDelay 旧值写错）、`docs/requirements/089`（4-12 秒 → 实际 6-16 秒）。

## 本轮改动主体（相对 v0.10.153）

1. **设置全局化**：`src/app/global-settings.ts`（新）为唯一真相源 `~/.cuckoo/agent-settings.json`；AI 页面 localStorage 降级为运行时缓存；`ipc/settings.ts` 重写为「增量 + 最新基底合并 + 广播」；`entry.ts` 在 did-finish-load 下发或触发迁移。
2. **防封默认收紧**：retryCount 10→3、retryDelay 4~10s→15~30s、retry429Count 40→1、watchdogCount 3→1、sendDelay 1~10s→6~16s。
3. **浏览器指纹加固**：`user-agent.ts` 重写 `buildUserAgentDataFix()`（webdriver 走 Navigator.prototype、补 window.chrome 全套）；`entry.ts` 追加 `--disable-blink-features=AutomationControlled`。
4. **队列先停后发**：`harness.html` 的 `sendQueueItemNow` / `doSendQueueItem` / `maybeFlushQueue` / `send(override...)` / `waitForAiIdleThenSend`（静默期 300→500ms）。
5. **停止闭环**：`stopGeneration` 的 not-generating / escape 改为成功；`onPhoneStop` 统一 clearBusy；`requestAbort` 级联 `emitUserStop`；`observer.ts` 中止后丢弃残余帧与工具回传。
6. **壳页面布局跨窗口同步**：`layout-sync.ts`（新）+ `sidebar.ts` / `activitybar-visibility.ts` / `ui-prefs.ts` / `shell-preload.ts`。
7. **手机端**：任务完成通知（task-done 与 ai-reply 区分）、电量优化单次引导、停止收尾。

## 未闭环项（真机验证，一项都没跑）

> 代码层面已闭环并发版，但按「必须端到端真实运行验证」规则，以下均未验证：
> 尤其第 1 项是本轮修复的严重 bug 的唯一直接验收点。

## 验证结果

- `npm run typecheck` → 通过
- `npm test` → **130 套件 / 1267 用例全绿**
- `npm run lint` → 0 errors（65 warnings 均为历史存量 unused-vars）
- `npm run compile` → 通过（shell.html 522080 字节）
- 审计报告：`.agents/settings-sync-and-safe-defaults-审计.md`

## 待办事项 (Next Steps)

- [ ] 真机验证（开发版 CDP 9444）：纯净模式点停止 → 顶栏「已停止」→ 1.5s 后「就绪」；工具卡片转「已停止」。
- [ ] 真机验证：老用户升级路径。构造 `~/.cuckoo/agent-settings.json` 不存在 + AI 页 localStorage 存 `cuckoo-send-delay-min=1000`/`max=10000` → 启动后应为 6000/16000。
- [ ] 真机验证：手机端长任务中途点停止 → 流式气泡收敛、忙态解除。
- [ ] 实际 Android 手机安装 APK，验证冷启动电量优化仅首次弹窗。
- [ ] 多窗口并发保存设置（两窗口同时改不同项）→ 两边 localStorage 与文件一致。

## 关键上下文

- 工作目录: `d:\Desktop\Super-File\cuckoo-code`
- 版本: `0.10.155`（跳过含 4 的 0.10.154）
- 快照: `snap-1793193757560-hnuqay`（审计修复前）
- 垃圾清理：已删除 `dist/` `out/` `wyp/` `coverage/` `.codegraph/` `.archify/` `temp_audit_diff.patch` `wyp-t.log`（共约 879 MB）。`out/` 已由 `npm run compile` 重建。
