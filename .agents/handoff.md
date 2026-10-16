# 最新接续状态 (2026-10-16)

## v0.9.11 本次会话（2026-10-16）——思考阶段 TPS 修复

### 背景
用户真机观察：DeepSeek 输出思考时底栏 TPS 显示 `-- t/s` 不变化。

### 根因（需求档案 071）
TPS 只取正文（`events.ts:417` `ev.text`），忽略思考内容（`ev.think`）。思考阶段：正文空 → 估算路径失效；DeepSeek `acc` 思考阶段未下发 → 精确路径失效 → `-- t/s`。hook 早带 think，只是没被 TPS 用上。

### 交付
`events.ts` TPS 回调：`text = (ev.text||'') + (ev.think||'')`。1 处改动。

### 验证
- typecheck / test(988) / lint(0 error) / compile 全绿；tps 单测 17 全过
- 真机：壳页面 TPS 元素存在（空闲 `--`）✅
- ⚠️ 完整思考流验证需真实生成（用户手动测）

## v0.9.10 本次会话（2026-10-16）——生成中禁用切换 + 脚本折叠

### 背景
用户问："纯净模式下 AI 正在回复时，切换到其他会话/子对话会怎样？"——查证结论：
- 纯文本生成中切换：页面导航中断流（基本无害）。
- **工具执行中切换**：工具在后台跑完但结果回传上下文随导航销毁 → **工具白跑、AI 卡住**（真问题）。
- 待发队列被清空（用户消息队列，切不同会话不应迁移，属正确行为——用户已确认不修）。
- 子代理是独立窗口，不受影响。
「对话」页已有 harnessBusy 置灰禁用；「工作区」页缺失。

### 交付（需求档案 070）
1. **工作区页生成中禁用其他会话切换**：新增模块级 `harnessBusy`，订阅既有 `api.onHarnessBusy`（无需新增 IPC）；`renderItem` 对非当前会话加 `ck-ws-disabled`；点击处理双保险早退；CSS 降透明 + not-allowed。
2. **任务页 package.json 脚本默认折叠**：`tasks.html` caret 加 `ck-git-caret-c`、列表加 `cuckoo-hidden`。

### 真机验证（dev 9444）
- 壳页面：onHarnessBusy=function、10 个会话项、初始 disabled=0 ✅
- typecheck / test(988) / lint(0 error) / compile 全绿
- ⚠️ 未做端到端"真实生成中观察置灰"（需完整纯净模式跑一轮生成，成本高）；已验证 API 挂载 + 生成物含逻辑

### 关键文件
- `src/ui/shell/scripts/pages/workspaces.ts`（harnessBusy + renderItem + 点击拦截 + 订阅）
- `src/ui/shell/styles/components.css`（ck-ws-disabled）
- `src/ui/shell/partials/pages/tasks.html`（默认折叠）

## v0.9.9 本次会话（2026-10-16）——压缩续接会话标题

### 背景
用户问"为什么有的标题可以显示中文，有的不行？"——真机取证：显示 UUID 的会话 title 全为 null 且 kind 全为 `compaction`。根因两层：① setSessionLineage 新建条目 title 硬编码 null；② 命名提示词只覆盖"首条用户消息"，压缩新会话先收到系统摘要，不会触发命名。

### 交付（方案 A+B，需求档案 069）
1. **方案 A 继承父标题**：`setSessionLineage` 写 compaction 血缘时，父有标题且本条目无标题则复制（store.ts）。
2. **方案 B AI 生成标题**：摘要指令要求首行「【标题】xxx」→ `parseSummaryTitle` 解析 → 段1 存 `COMPACT_TITLE_KEY` → 段3 调新增 IPC `set-pending-session-title`（`forceStage=true` 强制暂存，避免误写父会话）→ 新会话 ID 出现时绑定，覆盖方案 A 继承标题。
3. **新增 IPC**：`src/app/ipc/session.ts` set-pending-session-title + `src/bridge/api.ts` setPendingSessionTitle。

### 审查修复（子代理审查 + 主代理审计，5 项）
- parseSummaryTitle 正则 `\s*` 跨行 bug（标题空时误吞正文首行）→ 先剥前导空白、首行精确匹配、无论标题空否都剥标签行
- setPendingSessionTitle 时序脆弱（可能误写父会话）→ 新增 `forceStage` 参数
- 段2 失败未清 COMPACT_TITLE_KEY → 补齐
- setPendingSessionTitle 未捕获 rejection → 补 .catch()
- 标题截断 30→20 对齐提示词

### 真机验证（dev 9444）
- `setPendingSessionTitle('测试压缩标题')` → `{success:true, pending:true}`（forceStage 生效）✅
- 单测：新增 7 个 parseSummaryTitle 用例；typecheck / test(988) / lint(0 error) / compile 全绿

### 待真机确认
- 触发完整压缩流程，确认新会话显示 AI 生成标题（或兜底父标题）

### 关键文件
- `src/session/store.ts`（setSessionLineage 继承 + setSessionTitle forceStage）
- `src/session/compaction.ts`（SUMMARY_INSTRUCTION + parseSummaryTitle + COMPACT_TITLE_KEY + 段1/段3）
- `src/app/ipc/session.ts` + `src/bridge/api.ts`（新 IPC）
- `test/session/compaction.test.js`（parseSummaryTitle 测试）

## v0.9.8 本次会话（2026-10-16）——UI 四改

### 交付
1. **对话导航 tooltip 修复**：生成中 `scrollBottom` 频繁触发 `scroll` → 全局 tooltip 引擎监听 scroll 立即隐藏 → 导航 tooltip 一显示就被打断。现 `.conv-nav`（fixed）的 tooltip 不受滚动影响；且右侧空间不足时**显示在元素左侧**（垂直居中），不再遮挡导航。
2. **底部「最近」快捷按钮**：技能/MCP/子代理/提示词统一改为**只填入输入框不自动发送**（autoSend=false）。
3. **任务完成通知**：图片区 170px→100px；正文改为展示 **AI 回复摘要**（截断 120 字），无摘要退回"回复已生成"。

### 真机验证（dev 9444）
- 导航 tooltip：shown=true、位置在元素左侧（tipRight 1195 ≤ elLeft 1201）、scroll 后仍显示 ✅
- 通知：title="AI 任务已完成"、body=回复摘要、picH=100px、innerH=218 ✅
- typecheck / test(981) / lint(0 error) / compile 全绿

### 关键文件
- `src/ui/harness.html`（positionTooltip 左侧翻转、scroll 监听放行 conv-nav）
- `src/ui/shell/scripts/recent.ts`（autoSend=false）
- `src/app/notification-window.ts`（PIC_HEIGHT 100）+ `src/ui/notification-window.html`（pic-wrap 100px）
- `src/bridge/api.ts` + `src/bridge/intercept/observer.ts` + `src/app/ipc/renderer.ts`（通知摘要链路）

## v0.9.7 本次会话（2026-10-16）

### 背景
用户提问：限流切换 / 手动切换 / 压缩新开对话会不会丢上下文/队列/目标/侧导航？会不会降质？TPS 准不准？

### 分析结论（真机取证 + 代码核实）
- **切换类（限流/手动）**：harness 状态全量迁移（history/sendQueue/goal/planState/planTodos），不丢。两处调用 closeSource=true（都关源窗口），原注释有误已修。
- **压缩**：AI 侧续接（摘要+最近20%），但 harness 侧队列/目标/计划/侧导航**重置为空白**（用户明确"不需要迁移，只需提示语"）。
- **分享页可续聊**：**真机验证确认** —— 打开 /share/xxx 有输入框、上下文完整（bodyHead 含完整系统提示词）。切换降质担忧解除。
- **TPS**：滑动窗口 4s，DeepSeek 用服务端 acc 差值较准，ChatGPT/Claude 长度估算不准；显示策略问题（结束后残留）已修。

### 交付
1. **压缩续接提示**：harness 检测 framework-send tag='压缩-摘要' → 置内存标记 → 新会话空历史时显示提示。
   - ⚠️ 关键坑：harness 是 file:// 页面，AI 页面是 https://，**localStorage 隔离**，跨页标记方案不生效（真机验证发现）。改用内存标志。
2. **TPS 清空**：task-idle + tool-start 时清空为 `--`（新增 onToolStart 回调注入）。
3. **注释修正**：entry.ts 窗口组切换注释。

### 真机验证（dev 9444）
- 分享页 /share/xxx：hasTextarea=true、上下文完整 ✅
- TPS 流式→有值(141)→task-idle 清空(--) ✅
- TPS 流式→有值→tool-start 清空(--) ✅
- 压缩提示：simulateFrameworkSend('压缩-摘要')→提示正确显示、标记消费 ✅；无 pending/过期不显示 ✅
- 验证：typecheck / test(981) / lint(0 error) / compile 全绿

### 关键文件
- `src/ui/harness.html`（onFrameworkSend 置标记、showCompactedHintIfAny、onSessionChanged 空历史分支）
- `src/overlay/events.ts`（onTaskIdle/onToolStart 清 TPS）
- `src/bridge/entry.ts`（wireEvents 注入 onToolStart）
- `src/app/entry.ts`（注释）

## 核心进展
- **任务完成通知图片轮换 + 队列手动发送修复** → v0.9.6：通知浮窗新增 170px 图片轮换区（src/ui/notif-images/ 27 张 webp，原 129MB 压至 1.6MB；懒加载+预加载下一张+hover暂停）；队列"点一个立即发送"改为临时抑制（不再永久暂停整个队列）+ manualSendInFlight 防连点顺序错乱。真机验证：队列剩余项照常自动排空。
- **更新弹窗改用专属 update 图标（下载箭头）** → v0.9.5
- **限流弹窗去X + 三弹窗图标块立体高光** → v0.9.4
- **子代理完成误弹通知修复（销毁竞态）** → v0.9.3
- **弹窗视觉重构 + 队列插队修复** → v0.9.2（通知/确认浮窗去关闭按钮、实心图标、发丝线、渐变进度条；确认窗动态高度；纯净模式队列手动插队不再连带自动发送——新增 autoFlushPaused + 恢复按钮；确认框 Enter 双触发修复）。真机验证：队列插队后剩余保留、点恢复自动排空。
- **手机端进入显示电脑对话历史** → v0.9.1（`remote/server.ts` 新增 sendToClient；`remote/manager.ts` 新增 pushHistoryToNewClient，**先补历史再补活跃流**；`pwa/app.js` 新增 renderHistory）。真机验证：手机 WS 连入收到 history len=8、PWA 正确渲染。
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
