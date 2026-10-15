# 最新接续状态 (2026-10-16 04:00)

## 核心进展
- **059 修复 Harness 卡"生成中"** 已闭环并发版 v0.8.87（分支 fix/059-harness-busy-stuck）。
- 用户此前要求"移除手机远程功能"，**已改为先修复**（删除改动已回滚，未提交）。

## 核心动机与背景 (Motivation & Background)
- 用户反馈：Harness 纯净模式下，AI 网页原始回复已终止（真实任务结束），但 Harness 仍显示"生成中"。

## 根因（证据链）
`aiGenerating` 置 true 后缺可靠复位时机 + 心跳续命死循环：
1. `harness-bridge.ts` onStream 只处理非 finished 帧置 true，**finished 不复位**
2. onInterceptedResponse 仅"回复不含 js/cuckoo 块"才复位，**含工具块永不复位**
3. 卡 true 后 2s 心跳持续报 true
4. `harness.html` onAiState(true) 每次刷新 lastActivityAt → 6s 静默永不满足 → 永久 busy

## 关键设计与实现 (Implementation & Decisions)
- `src/bridge/harness-bridge.ts` onStream：**finished 帧调 setAiGenerating(false)**（流式结束的权威信号）
- `src/ui/harness.html` onAiState：toolRunningCount>0 时静默阈值 6s → 600s（防误清长工具）；tool-end 一到 toolRunningCount=0 即回落 6s；interval 的 600000 字面量统一为常量 AI_STATE_QUIET_TOOL_MS
- 审计意见处理：🟡-2（闪就绪）驳回（tool-end 分支已有 lastActivityAt 刷新）；🟡-1（600s 退化）权衡后保留（安全优先）；🔵-1 采纳（常量统一）

## 待办事项 (Next Steps)
- [ ] **手机远程功能修复**（用户新需求，详见下方"用户新需求"）：
  - 及时同步电脑端与手机端的**思考信息 + 正文信息**，逐字展示，注意性能
  - 当前**没有显示思考**，消息同步不及时
  - 手机端"连接成功但消息推送失败"
  - 切后台再切回**需要重连**
  - 手机端展示思考完毕后**自动折叠**

## 用户新需求（手机远程修复，尚未开始）
用户明确要求（撤回删除）：
1. **及时同步**：手机端要实时看到电脑端的思考 + 正文，逐字展示
2. **展示思考**：手机端要显示 AI 的思考过程（thinking）
3. **思考自动折叠**：手机端展示思考完毕后自动折叠
4. **修复"连接成功但推送失败"**
5. **修复"切后台再切回需重连"**
6. 注意性能问题

关键文件（保留未删）：`src/remote/`（config/manager/server/tunnel/pwa）、`src/bridge/remote-bridge.ts`、`src/app/ipc/remote.ts`

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 分支: fix/059-harness-busy-stuck（已发版，可删）
- 主分支: master（v0.8.87）
- 验证状态：typecheck / test(978) / lint(0 error) / compile 全绿；真机验证 ai-state 序列正确复位

## 审计足迹
- v0.8.81~v0.8.86：053~058（手机远程性能、Harness 性能、窗口 UI、审计整改、限流浮窗）
- v0.8.87：059（Harness 卡生成中修复）
