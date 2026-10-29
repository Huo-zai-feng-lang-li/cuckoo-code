# 最新接续状态 (2026-10-29 17:00)

## 核心进展
- **v0.10.178 已发布**（master `128e56b`，tag 已推送，CI 构建中）：
  - 修复多代码块结果 LIFO 错配
  - 修复遮罩降级态发送阶段文案误导

## 版本链路

| 版本 | 内容 |
|---|---|
| v0.10.175 | Android 图标可切换 + 遮罩超时对齐 + 降级态 + 纯净模式停止不清输入框 + 壳页面子代理卡片 + 派发协议 |
| v0.10.176 | 纯净模式子代理卡片特殊化 + Result 时序 bug + runAgents 多子代理追踪 |
| v0.10.177 | 修复 overlay.css 污染（v0.10.175 遗留） |
| v0.10.178 | 修复多代码块结果错配 + 降级态发送阶段文案 |

## v0.10.178 修复详情

### 修复 1（中危）：多代码块结果 LIFO 错配
**根因**：`observer.ts:195-210` 的 `executeJsBlocksWithRetry` 是「全部 emitToolCall(start) → 顺序执行 → 全部 emitToolCall(end)」。而 `harness.html` 的 `addToolEnd` 只按「最后一个 `.tool-badge.run` 卡」匹配，不校验归属。N 个代码块时第 1 条结果填到第 N 张卡、第 N 条填到第 1 张卡——**结果张冠李戴**。

**修复**：
- `addToolStart` 把 `code` 存入 `data-tool-code`（子代理卡 + 普通卡都存）
- `tool-end` 事件处理传 `payload.code`
- `addToolEnd(success, output, error, code)` 优先按 `data-tool-code` 精确匹配，匹配不到才退化为「最后一个 run 卡」

### 修复 2（低危）：降级态发送阶段文案误导
**根因**：执行阶段已超时降级 → 任务跑完进入「正在回传结果」阶段时，`renderMaskText` 的降级分支无条件输出「任务仍在后台执行」，label 被吞。用户可能误点停止取消回传。

**修复**：降级分支感知 `maskLabel === '正在回传结果'`，发送阶段输出「正在回传结果（已 Ns），可点下方停止」。

## 已验证无问题的项（审计确认）

1. maskDegraded 生命周期（stopMaskTick 重置 + showToolMask 非 reuse 清除）
2. IPC 五层 windowId 参数对齐（undefined 一致传递，不会变 null）
3. subagent-cancel 并发调用幂等
4. addToolEnd 与 applySubagents 时序（子代理完成后保留 run class）
5. 纯净模式 stop() 不清输入框（队列由 aborted() 保护）
6. 依赖方向（infra → overlay/bridge/app 合规）
7. 16 个改动文件零污染
8. data-subagent-id NaN 安全

## 待办事项 (Next Steps)

### P0 · 真机验证（用户手动，v0.10.178）
- [ ] **多 runAgent 块结果不再错配**：让 AI 一次回复里调 2 个 `runAgent`（不同代码块），确认第 1 条结果填到第 1 张卡
- [ ] **降级态发送阶段文案**：跑一个超 5min 的普通工具 → 降级 → 工具跑完进入回传阶段 → 遮罩应显示「正在回传结果（已 Ns）」，不再是「任务仍在后台执行」
- [ ] 遮罩降级基础行为（半透明 + 黄色文字 + 停止按钮可点）
- [ ] 纯净模式子代理卡片（红色渐变 + Live + 单杀 + Result 展示）
- [ ] 纯净模式停止不清输入框
- [ ] Android 图标 4 套切换 + 重启保持
- [ ] 壳页面子代理卡片倒计时 + 单杀

### P1 · 记录但不修（历史遗留，风险大于收益）
- [ ] `send()` 的 `clearAbortSuppression` 会解除停止保护，残留 sendQueue 下次空闲被自动发（既有队列语义，需产品决策）
- [ ] 父窗口关闭不级联取消子代理（靠自然完成/超时，设计边界）
- [ ] `runAgents` 动态卡无 Result 区（runAgents 合并结果只显示在主卡，架构限制）
- [ ] `(ctx as any).harnessView` 未在 WindowContext 接口声明（类型不安全，功能正常）
- [ ] notifyParent 每 400ms 全量推送（既定实时刷新，可后续节流）

### P2 · 后续改进
- [ ] 子代理 runAgent 完整展示模块（时间轴/工具流/token），单开需求 100
- [ ] 子代理对话污染网页历史
- [ ] 老版本升级兼容：LAUNCHER 迁到 activity-alias 后旧桌面快捷方式失效
- [ ] runAgents 的 agentName 解析（数组参数解析不到名字）

## 关键上下文

### 项目目录
`D:/Desktop/Super-File/cuckoo-code`

### 版本与提交
- 当前版本：`0.10.178`
- HEAD：`128e56b`
- 四个 tag：v0.10.175 / 176 / 177 / 178 均已推送

### 关键文件（v0.10.175-178 汇总）
- `src/infra/timeouts.ts` — 全局超时常量
- `src/overlay/panel.ts` — 遮罩降级态 + renderMaskText 阶段感知
- `src/overlay/template/overlay.css` — 降级态样式（已从污染恢复）
- `src/bridge/intercept/observer.ts` — hasSubagentCall
- `src/ui/harness.html` — stop() 不清输入框 + 子代理卡片特殊化 + addToolEnd 按 code 匹配
- `src/app/subagent.ts` — cancelSubagentsByParent 支持 windowId + notifyParent 推 harness
- `src/app/harness-preload.ts` / `src/app/shell-preload.ts` — cancelSubagent 暴露
- `src/app/ipc/subagent.ts` — windowId 透传
- `src/ui/shell/scripts/pages/agents.ts` — 壳页面子代理卡片
- `src/ui/shell/styles/components.css` — .ck-agent-running 视觉重做
- `android/app/src/main/java/com/cuckoo/cuckoocode/AppIconPlugin.java` — 图标切换
- `android/app/src/main/AndroidManifest.xml` — 4 个 activity-alias
- `scripts/gen-android-icons.mjs` — 图标资源生成
- `.agents/rules/subagent-dispatch.md` — 派发协议

### 关键踩坑（务必牢记）
1. **绝不 `write(filePath, await read(filePath))`**——会写入工具包装和行号前缀。用 `readLines` / `edit` / node `fs` 操作。
2. **派发子代理必须自包含三要素**——严禁「上一轮你指出」等伪连续措辞。
3. **多代码块结果匹配必须按 code**——不能靠「最后一个 run 卡」。
