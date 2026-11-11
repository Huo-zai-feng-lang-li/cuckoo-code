---
id: 116
type: feat
title: 接续发送与暂停闭环及上下文阈值切换
status: doing
branch: fix/115-long-text-attachment
created: 2026-11-11
updated: 2026-11-10
---

# 接续任务闭环

复用需求 115 当前分支完成发送竞态、随机长暂停配置与宠物反馈；Token 页增加默认关闭、默认 10 万 token 的上下文切换开关及阈值。

任务空闲后达到阈值时复用限流告警与窗口组切换，成功关闭源窗口；取消、未分组、失败均需释放锁并保留窗口。上下文切换与自动压缩不同时执行，同一轮上下文避免重复告警。限流文案保持原行为。

执行计划与证据见 `.agents/plan-代码闭环执行.md`。验收包括发送并发、取消、设置保存同步、阈值去重及全量 typecheck/test/lint/compile。真机测试由用户执行。

## 一、本轮代码闭环记录（2026-11-10）

### 1. 发送竞态 / 漏发（任务 A）

- 纯净模式用户消息走串行链 `sendUserMessageToChat`：先 `cancelPendingSend` → `await clearInputArea` → `sendToChat('harness', 0)`，旧工具结果不再排队串发。
- S 延迟 timer 原先吞掉 `triggerSend` 返回布尔、恒 resolve(true) 并派发 delivered。已改为 async 消费发送结果：触发发送后等 300ms 让受控组件清空输入框，读回仍有残留即判未发出（resolve(false)、调 afterSent、不发 `emitMessageDelivered`）；成功路径才派发 delivered。主进程 `sendInputEvent` 不抛异常即返回 true（Enter 可能打空），不能单信该返回值。
- 摘要指令 tag `切换-摘要` 补入 `SYSTEM_MSG_TAGS`：即时投递、不上报为用户消息、不参与长暂停/附件（与 `压缩-摘要` 同列）。
- 回归测试：残留 → false 且 delivered 不触发；`isSystemTag('切换-摘要')===true`。

### 1.1 逐请求发送回执闭环（2026-11-10 补）

> 背景：此前 harness.html 发送前先清空输入框，主进程 `harness-send` 转发后即返回恒成功，bridge 成败只上报 status、无 requestId 配对；偶发失败时草稿已清空、界面又只认恒成功返回，既不报错也不恢复草稿。

- **requestId 贯穿**：前端 harness.html 生成 requestId → preload `sendMessage(text, requestId)` → 主进程 `harness-send` 转发 `harness-user-message` 带 requestId → bridge 按闭包 requestId 经 `harness-user-message-result` 回传 `{requestId, success, error}`；无 requestId 的自动投递（分享页激活）不挂回执，保留旧行为。
- **receipt 纯模块**：`src/app/ipc/harness-send-receipt.ts` `waitForUserMessageReceipt(ipc, target, timeoutMs, requestId?)`，一次性监听、按 `event.sender===target && requestId 匹配` settle；超时 150s（覆盖长暂停 75s + 拟人延迟 30s + 附件/输入余量）settle 失败；settle 后 off 监听、清 timer；cancel 可提前收尾。
- **主进程接线**：`src/app/ipc/harness.ts` `harness-send` 改 async，先挂回执再转发，`await receipt.result`；结果另经 `harness-event` `{type:'send-result',...}` 事件通道兜底回 harness 页；返回 `{success, error}`。
- **bridge 回执**：`src/bridge/harness-bridge.ts` 成功/失败/异常三条路径都回传回执；失败文案保留原「网页未找到输入框…」，异常携带 error.message。
- **harness 草稿回填**：`src/ui/harness.html` 普通直发（非 override）清空前存 `pendingDraft={requestId,text,at}`；回执成功清草稿；失败且输入框仍为空才回填原文并复位高度，输入框非空（用户已打新内容）不覆盖；草稿 TTL 150s 过期清理；`send-result` 事件与 invoke `.then` 双通道幂等 settle。
- **🔴#1 URL 变化误判投递失败（方案 A'）**：`src/overlay/chat-input.ts` `sendAndConfirm` 原先 `window.location.href !== sessionUrl` 即提前 `return false`，把"发首条消息创建新会话/导航"误判失败，触发上层重试 → 同一条双发。已移除该提前判失败：URL 变化后继续在 1500ms 观察窗内读回输入框，空框判成功、仍有残留判失败；`token.cancelled` 跨会话防护保留。
- 回归测试：`test/app/harness-send-receipt.test.js` 3 条；`test/bridge/harness-bridge.test.js` +3 回执用例；`test/ui/harness-page.test.js` +5 草稿守卫；`test/overlay/chat-input.test.js` URL 变化两条（空框成功 / 残留失败）。

### 1.2 真机漏发排查与发送按钮兜底修复（2026-11-11）

> 背景：真机反馈纯净模式一条「文字 + 图片附件」消息未提交，输入框残留文字与图片气泡。本轮连 CDP 9444 真机复现排查。

- **空闲态未复现**：纯文本直发、图片附件后发送两条路径真机回执均 `success:true`，输入框清空、附件随消息提交；未能在空闲态复现截图漏发。
- **确证缺陷（已修）**：`src/providers/deepseek.ts` `findSendButton` 原 14 条选择器全部以 `<button>` 标签起头；真机实测 DeepSeek 发送/停止主按钮是 `DIV.ds-button--primary`（34×34，aria-label/title 全空），选择器 0 命中 → 原生 Enter 失败后，原生物理鼠标点击按钮这条兜底通道在 DeepSeek 落空，只剩合成 Enter 最后防线。已补 div 主按钮入口：可见、`class` 不含 `ds-button--disabled`、svg path 为箭头（排除 `M2 4.88` 方块停止态，避免生成中误点停止）。回归测试 `test/providers/deepseek-send-button.test.js` 3 条（箭头命中 / 方块排除 / 禁用排除）。
- **留档时序疑点（空闲态未复现，未贸然改）**：
  - 附件上传走合成事件兜底 `attachFn`（harness.ts）：`change` 派发即判 `success`，不等站点真正接收/上传完成；DeepSeek 图片是无文件名缩略图，现有就绪判据（文件名文本卡片）走不到。随后 harness.html 固定 `setTimeout 1500ms` 再发送，无就绪复核。慢网/大图/长上下文下可能附件未绑定就触发发送，被站点忽略。需真机慢/大图场景观测上传中 DOM 后再补条件等待。
  - `debugger-busy` 避让：`net-identity` 为指纹/代理/时区常驻持有 debugger，`cdp-attach` 检测到已 attach 即避让，DeepSeek 实际走合成事件兜底（日志实测 `CDP 上传结果: debugger-busy`）。属设计现状，非缺陷。
  - `doSendToChat` 开头 `findInputArea` 为 null 即返回 false，无有界等待；导航/加载态偶发踩中会直接失败。`sendAndConfirm` 观察窗 1500ms，站点慢时清空晚于该窗可能被误判残留。均待对应场景真机复现后再处理。

### 2. 随机长暂停 + 宠物通知（任务 B）

- 配置链路：`global-settings`（开关/概率/区间，秒；normalize 钳制）→ 主进程 `applyDelta` 增量合并 → 广播 → `bridge/entry.ts` 落 localStorage（秒 ×1000 存毫秒）→ overlay `state` / events 恢复；壳设置页 `st-pause-*` 控件接线（SET_FIELDS / collectSettings 兜底 0.1/30/75 / renderSettings / change 监听）；overlay 面板数据函数 `getSettingsData/applySettingsData/resetSettingsData` 同步暂停字段。
- 触发：`usesNaturalDelivery(tag)` 且概率命中才暂停；`onSendPause` 回调上报 active/durationMs，finally 复位 inactive；取消走 `interruptibleWait` 中断。
- 宠物：内嵌宠物 `petMood('pausing')`；桌面独立宠物窗口经 `api.setPetState({state:'pausing',...})` 推主进程（harness.ts 转发 verbatim，pausing 计忙态）；结束按 toolRunningCount/generating 复位 working/thinking/idle；`pet-window.html` applyState 补 pausing 映射，`pet.js` pausing 情绪组 8 条文案，`pickMood` 兜底 idle。

### 3. 上下文阈值自动切换窗口（任务 C）

- 配置：`contextSwitchEnabled` 默认 false、`contextSwitchThreshold` 默认 10（万 token）；normalize `toBool` / `toNum>0` 否则回退默认；Token 页双卡片（自动压缩 + 上下文切换），IPC `get-context-switch` / `save-context-switch`，preload/api 类型齐全。
- 触发：overlay `createContextSwitchGate`（busy + 按 sessionId 去重 Set）；仅在 `onTaskIdle` 判断，`checkContextSwitch()` 优先于 `checkAutoCompact()`，不同时执行；`tokenSessionId` 守卫防切会话残余帧；disabled/not-in-group/in-progress 时 reset 允许重试。
- 主进程：`context-limit-hit` 与 `rate-limit-hit` 共用 `runAutomaticSwitch`（去重锁/取消/superseded/异常收尾/closeSource=true）；上下文切换带 `withSummary=true`：先生成摘要（120s）再只分享最近 20%，摘要随回执注入目标会话 `extraPrompt`；限流保持全量分享。目标未就绪（60s）不关源窗口。
- 弹窗：`reason: 'rate-limit'|'context-limit'` 双端文案；context-limit 标题「上下文达到阈值，自动切换窗口」，限流文案回归不变。

### 4. 已知限制（留档，未做伪修复）

- 取消/中断后已上传附件无 detach 通道（缺站点级卸载证据）。
- overlay 自有设置面板的 open/save/reset DOM 死路径保留未删；活路径是壳设置页 + 纯数据函数。
- `events.ts` response meta 未带 sessionId，`meta.sessionId` 守卫为死分支；现有 `tokenSessionId` 守卫仍生效。
- **选窗可用性判断（已实现的部分）**：自动切换前逐个探测组内窗口，跳过 `isGeneratingAny`（主窗口 + 子代理在途）与 `isRateLimited`（5 分钟限流冷却）；`probeWindow` 导航首页发「你好」实测，429/rate_limit → limited（写冷却），完整回复 → ok，60s 超时/其他错误 → 跳过且不写冷却；全部不可用时恢复源窗口重试、不切换。
- **选窗已知缺口（留档，未做伪修复）**：探测目前只识别限流（429/rate_limit），未专门识别「账号被封 / 登出 / 无登录态」。这类页面既不 429 也不回完整回复，落到 60s timeout 且不写冷却，下一轮会再探测一次。可靠识别需真机观测封禁页/登录页 DOM 特征后再补选择器；凭猜测加选择器有误判正常窗口的风险，本轮不做。

## 二、验证记录

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `npm run typecheck` | EXIT=0 |
| test | `npm test` | EXIT=0，145 files / **1461 tests passed**（2026-11-11 本轮，+3 发送按钮兜底回归） |
| lint | `npm run lint` | EXIT=0，0 errors，70 warnings（历史遗留） |
| compile | `npm run compile` | EXIT=0，生成物已重建 |

真机验证清单（用户执行，本窗口未启动 Electron、未打包、未发布）：
- [ ] 工具循环中纯净模式回车只发用户消息、无残留
- [ ] 偶发投递失败时原草稿回填输入框；失败后接着打字不被覆盖
- [ ] 发首条消息触发站点新建会话（URL 变化）不被误判失败、不双发
- [ ] 壳设置页改暂停 → 日志「随机长暂停 Xs」；长暂停宠物文案
- [ ] Token 页低阈值触发弹窗 → 文案正确 → 关源窗留一窗；限流弹窗文案回归不变
