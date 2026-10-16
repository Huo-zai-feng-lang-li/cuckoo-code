# 最新接续状态 (2026-10-16)

## 核心进展
- **自绘通知/确认浮窗 + 流式体验回归修复** → v0.9.0（详见下）
- **手机远程流式渲染优化** → v0.8.99（`src/remote/pwa/app.js` + `style.css` + `remote-bridge.ts` + `manager.ts`）：流式期间改低频 markdown 渲染（~200ms），端到端延迟 240→120ms。
- **Harness 流式体验优化** → v0.8.98（`src/providers/hooks/{deepseek,claude,chatgpt}.ts` 节流 80→40ms + `harness.html` scrollBottom rAF 合并）。
- **Harness 流式收尾卡顿修复** → v0.8.97（`harness.html`：finished 帧渲染后设 `lastDoneText`，让 assistant-done 去重、跳过第二次 renderMarkdown）。
- **记忆稳健性 + 压缩摘要注入** → v0.8.95/96（`src/infra/memories.ts` 原子写+保留最新；`src/session/compaction.ts` 摘要注入新会话）。
- **子代理通知隔离 + tools 白名单** → v0.8.94（`src/app/ipc/renderer.ts` + `src/bridge/subagent.ts`）。

## v0.9.0 本次会话（2026-10-16）

### 交付内容
1. **自绘系统通知浮窗**（新增 `notification-window.ts`/`.html`/`preload.ts`）：右下角无边框卡片、堆叠、hover 暂停、点击聚焦。替换 AI完成 / 窗口组切换 / 更新提示 3 处原生通知。
2. **自绘确认对话框**（新增 `confirm-window.ts`/`.html`/`preload.ts`）：主/次按钮 + Esc/Enter。替换更新流程 4 处 `dialog.showMessageBox`。
3. **纯净模式流式渲染改回节流全量 markdown（80ms）** —— 修复"先一大坨 md 后变格式"。
4. **手机端节流 200→80ms** + 思考块高度 320px→45vh + 不提前折叠。
5. **手机端"总是生成失败"根因修复**：新增 `cuckoo-retry-state` 事件，重试期间不误报终态。
6. **流式尾部 ```cuck` 泄漏** + **空气泡** 修复。
7. **`+` 新对话沿用当前项目**（含防双击、失败清理监听）。
8. **TPS 改滑动窗口（4s）**。

### 真机验证（dev 实例 9444，源码直载）
- 纯净模式发 markdown 消息：DOM 含 `<h1><h2><ul><strong><code>`，`hasStrong:true` —— **markdown 正确渲染**（不再是字面 `**`）。
- 4 条 assistant 消息均有内容、**无空气泡**；流式进行中即带格式。
- confirm-window.html 结构完整、无 JS 错误。
- ⚠️ **未验证**：更新弹窗/通知浮窗的**实际弹出效果**（`app.isPackaged` 才触发，开发版测不了）——需打包版真机验证。

### 验证
typecheck / test（981）/ lint（0 error）/ compile 全绿。

### 待办
- [ ] **打包版真机验证**：更新确认框（发现新版本/更新已就绪/更新失败）、系统通知浮窗、窗口组切换通知的实际显示与交互。
- [ ] 通知/确认浮窗的**视觉润色**（按 impeccable 流程截图自检，尚未做）。
- [ ] 若通知浮窗在打包版有多屏/DPI 定位问题，需实机排查。

## 核心动机与背景 (Motivation & Background)

### 本会话主线：修复用户反馈的"流式体验差 + 记忆/压缩"
用户反馈系列问题，逐一定位并修复：
1. **Harness 流式收尾卡顿**：同一条回复被 `renderMarkdown`（KaTeX+marked+innerHTML 重建）渲染**两次**——`onStream(finished)` 收尾帧一次 + `onAssistantDone` 又一次；后者本有文本去重，但 finished 帧未更新 `lastDoneText` → 去重不生效。
2. **Harness 出字"一坨一坨"**：三个 provider hook 流式节流 80ms（12.5fps），文字刷新被卡。且 `scrollBottom` 每帧强制 reflow。
3. **手机远程"先一大坨 md 再变格式"**：手机端（`src/remote/pwa/`，**独立代码**）流式期间是纯文本追加、收尾才渲染；且三层节流（hook 40ms → bridge 100ms → manager 100ms ≈ 端到端 240ms/批）。
4. **记忆系统**：写入非原子（崩溃全丢）、截断保留最早（丢用户新偏好）、压缩摘要生成后被完全丢弃。
5. **子代理**：完成时误弹系统通知（应只父/主对话通知）；frontmatter 的 `tools` 字段全链路无消费（失效）。

### 关键教训（已存入长期记忆）
**判断"是否闭环"必须端到端真实运行验证，不能只读代码就下结论。** 曾草率把"窗口组不迁分支"误报为问题（实为正确设计：分支是废弃版本 + DeepSeek `share/create` API 硬约束要求消息成对）；也曾只读代码漏掉自己引入的边界 bug（记忆截断前缀未计入预算，实测 body 4024>4000）。

## 关键设计与实现 (Implementation & Decisions)

### Harness（电脑端）
- **069 收尾卡顿**：`harness.html` onStream finished 分支渲染后加 `lastDoneText = text.trim()`。去重命中取决于两处文本一致（常见情况命中；工具块边界不一致时安全退化为渲染两次，**不丢内容**）。**未采纳**审计建议"bridge 复用同一份文本"——finished(流式快照)先到、assistant-done(完整响应)后到，复用会丢内容。
- **070 出字流畅**：hook 节流 `80→40ms`（finished 帧绕过节流不受影响）；`scrollBottom` 改 rAF 合并（一帧最多滚一次），rAF 内重新校验 `pinBottom`，避免把上翻历史的用户弹回底部。

### 手机远程 PWA
- **071 流式渲染**：新增 `scheduleStreamMd/flushStreamMd/cancelStreamMd`（~200ms 渲染一次 markdown）；`streamNode` span→**div**（承载块级 HTML）；`.stream-text--md` 切 `normal` 空白（防 `pre-wrap` 与 `<p>` 双重间距）；bridge/manager 节流 `100→60ms`。收尾 `finishStreaming` 仍全量渲染 + `decorateContent` + 复制按钮（不变）。

### 记忆系统（`src/infra/memories.ts`）
- **原子写**：`saveMemories` 改 temp + `renameSync` 覆盖；Windows 占用(EPERM/EBUSY) 降级直写（防"修复引入新失败"）。
- **截断保留最新**：`buildMemorySection` 从尾部取（原 `slice(0,MAX)` 保留最早）；前缀提示计入预算（边界修复）。
- 记忆生效链路实证：`prompt-builder.ts:194` → 模板 `{{MEMORY_SECTION}}`（`deepseek.md:194`）→ 系统提示词。真实文件 3 条。
- **模型能力**：会加（`remember` 工具 + `[记忆]` 标记）、会删（`forgetMemory`），**不能改**（无编辑能力）。

### 压缩续接（`src/session/compaction.ts`）
- 段1 存 `summaryText` 到 `COMPACT_SUMMARY_KEY`；段3 `checkPendingInit` 读取作 `extraPrompt` 注入新会话（原摘要被完全丢弃）。调用链 `events.ts:590-598`。

### 子代理（`src/bridge/subagent.ts` + `renderer.ts`）
- 通知隔离：`show-ai-notification` 判 `ctx.isSubagent` → 跳过。
- tools 白名单：`buildSubagentPrompt` 按 `cfg.tools` 拼【工具约束】提示（软约束，机制层无法硬禁）。

### 窗口组转移（已澄清，无需改）
迁移 `history` + `sendQueue` + `goal` + `planState/planTodos`。**不迁分支是正确设计**。

## 待办事项 (Next Steps)
- [ ] **真机验证 v0.8.99（手机端）**：流式期间是否有格式（不再一大坨 md）、延迟是否降低；长回复不卡；上滑历史不被自动滚底。
- [ ] **真机验证 v0.8.98（电脑端）**：出字流畅度（节流 40ms）、长回复不卡、上翻历史不被弹回底部。
- [ ] **真机验证 v0.8.95-96**：压缩后续接是否带"前情提要"、记忆不再因崩溃丢。
- [ ] 若手机端仍不够流畅 → 评估"只渲染可见区域"或"流式增量 DOM"。
- [ ] 手机远程功能去留（取决于好用程度，用户观察后定）。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 主分支: master（v0.8.99，本地=远程=`6d5d36e`）
- 主要文件:
  - `src/ui/harness.html`（onStream/onAssistantDone/scrollBottom）
  - `src/providers/hooks/{deepseek,claude,chatgpt}.ts`（dispatchStream 节流）
  - `src/remote/pwa/app.js` + `style.css`（流式渲染）
  - `src/bridge/remote-bridge.ts` + `src/remote/manager.ts`（节流常量）
  - `src/infra/memories.ts`（记忆存储）
  - `src/session/compaction.ts`（压缩/摘要注入）
- 构建/验证: `npm run compile` / `npm run typecheck` / `npm test`（981）/ `npm run lint`（0 error）
- **注意**: hook 改动 + 手机端只能真机验证（注入主世界 / 真手机）；生成物（`hook-sources.ts`、`api.d.ts`、`shell.html`）禁手改，`npm run compile` 重建。

## 版本足迹
- v0.8.94（066）：子代理通知隔离 + tools 白名单
- v0.8.95（067）：记忆稳健性 + 压缩摘要注入
- v0.8.96（068）：记忆截断边界修复
- v0.8.97（069）：Harness 流式收尾卡顿
- v0.8.98（070）：Harness 流式体验优化（节流 + rAF 滚动）
- v0.8.99（071）：手机远程流式渲染优化（低频 markdown + 降节流）
