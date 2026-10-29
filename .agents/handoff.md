# 最新接续状态 (2026-10-29 15:30)

## 核心进展
- **v0.10.176 已发布**（master `5f872c0`，tag 已推送，CI 构建中）：
  - 纯净模式（harness）子代理卡片特殊化
  - 修复纯净模式子代理 Result 永不显示的时序 bug
  - 修复 runAgents 多子代理只跟 1 个
- 上一版 v0.10.175 已发布：Android 图标可切换 + 遮罩超时对齐 + 停止不清输入框 + 壳页面子代理卡片增强

## 本轮改动详情（v0.10.176）

### 纯净模式子代理卡片特殊化
**问题**：纯净模式对话流里 AI 调用 runAgent 只显示普通工具卡片（图标发光），看不到哪个子代理/第几轮/在干什么/剩余多久/能否停。

**改动**：
- `src/app/subagent.ts`：`notifyParent` 扩展，除壳页面外同时给 `ctx.harnessView` 推 `harness-event { type: 'subagents', subagents: listRunning(...) }`
- `src/app/harness-preload.ts`：暴露 `cancelSubagent(windowId)`
- `src/ui/harness.html`：
  - `parseToolCall` 识别 runAgent/runAgents，提取 agentName
  - `addToolStart` 对 agent 生成专用卡片（`.tool-card-subagent`，含 task/badge/remaining/stop/live 段）
  - 新增 `pendingAgentCards` / `agentCardByWindow` 状态 + `updateAgentCard` / `applySubagents` / `createDynamicAgentCard`
  - onEvent 加 `case 'subagents'`
  - `addToolEnd` 对 agent 卡片特殊处理 + 跳过动态卡
  - CSS：红色渐变边框 + 扫光动画 + Live 段样式

### 修复的时序 Bug（关键）
**问题**：`applySubagents` 在子代理完成时把 badge 的 `run` class 去掉（改 `ok`），随后 `tool-end` 到达时 `addToolEnd` 靠 `.tool-badge.run` 选卡 → 选不中 → Result 输出永不显示、真实结果不覆盖、`agentCardByWindow` 泄漏。**时序上必然触发**（`updateRunning(done)` 同步发生在 `runAgent` 返回前）。

**修复**：
- `updateAgentCard` 与「已消失」分支：普通卡完成后保留 `run` class，徽章文字改「收尾中」，等 `tool-end` 覆盖
- 动态卡（`data-agent-dynamic`）无对应 tool-end，直接标最终态
- 两分支都 `delete agentCardByWindow[widStr]` 防泄漏

### 修复 runAgents 多子代理
**问题**：一个 `runAgents` 代码块只产生 1 张 pending 卡，N 个子代理只有 1 个能追踪。

**修复**：pending 队列用尽时 `createDynamicAgentCard` 动态补卡，`addToolEnd` 跳过动态卡（由 `applySubagents` 的「已消失」分支兜底）。

## 验证结果
- `npm run typecheck` ✅
- `npm run lint` ✅ 0 error
- `npm test` ✅ 1304 tests passed
- `npm run compile` ✅
- **未做**：真机验证（用户手动测试）

## 待办事项 (Next Steps)

### P0 · 真机验证（用户手动）
- [ ] **v0.10.176 纯净模式子代理卡片**：派 runAgent → 卡片显示代理名/任务/轮次/剩余时间；展开见 Live 输出；点停止只杀该子代理；完成后 Result 段显示最终文本（**这是本轮修复的关键**）
- [ ] **v0.10.176 runAgents 多子代理**：一次派 2-3 个 → 每张卡片独立追踪（动态补卡生效）
- [ ] **v0.10.175 Android 图标**：默认黑底双蛋 → 切 glass/sticker/gold，桌面几秒内更新，重启后保持
- [ ] **v0.10.175 遮罩降级**：普通工具 5min 超时降级；含子代理 12min 超时降级；降级后停止按钮可用
- [ ] **v0.10.175 纯净模式停止**：输入框有草稿时点停止，草稿保留

### P1 · 后续改进（未做）
- [ ] 子代理 runAgent 完整展示模块（时间轴/工具流/token），单开需求 100
- [ ] 子代理对话污染 DeepSeek/Claude 网页历史（N 个子代理 = 历史多 N 条）
- [ ] 老版本升级兼容：LAUNCHER 迁到 activity-alias 后旧桌面快捷方式失效

### P2 · 历史遗留
- [ ] `ForegroundService` 通知小图标用系统图标
- [ ] `gen-android-icons.mjs` 硬编码外部路径（已有 existsSync 降级）
- [ ] 172/173 真机验证（遮罩逻辑已变，需重验）
- [ ] 092 并发池 A~H 真机验证
- [ ] v0.10.164 tag 违规仍在 origin

## 关键上下文

### 项目目录
`D:/Desktop/Super-File/cuckoo-code`

### 关键文件（v0.10.176 改动）
- `src/app/subagent.ts` — notifyParent 扩展推 harness（L93-115）
- `src/app/harness-preload.ts` — cancelSubagent(windowId)
- `src/ui/harness.html` — parseToolCall 识别 agent / addToolStart 专用卡片 / applySubagents / updateAgentCard / createDynamicAgentCard / addToolEnd 特殊处理 / CSS

### 关键文件（v0.10.175 改动，仍在生效）
- `src/infra/timeouts.ts` — 全局超时常量
- `src/overlay/panel.ts` — 遮罩降级态（L195-252）
- `src/bridge/intercept/observer.ts` — hasSubagentCall
- `src/ui/harness.html` — stop() 不清输入框
- `src/app/subagent.ts` — cancelSubagentsByParent 支持 windowId
- `src/ui/shell/scripts/pages/agents.ts` — 壳页面子代理卡片倒计时 + 单杀
- `android/app/src/main/java/com/cuckoo/cuckoocode/AppIconPlugin.java` — 图标切换插件
- `.agents/rules/subagent-dispatch.md` — 派发子代理协议

### 版本与提交
- 当前版本：`0.10.176`
- HEAD：`5f872c0`
- CI 构建中：Windows 安装包 + Android APK

### 踩坑记录（重要）
- **编辑 style.css 时曾用 `read()` 的返回值直接 `write()`，把 `<path>` 包装和行号前缀写进了文件**。后来 diff 显示 2965 行变化才暴露。教训：**永远不要拿 read() 的原始返回写回文件**，要用 readLines() 或基于精确 oldString 的 edit()。
- 派发子代理必须自包含三要素（见 `.agents/rules/subagent-dispatch.md`），严禁「上一轮你指出」等伪连续措辞。
