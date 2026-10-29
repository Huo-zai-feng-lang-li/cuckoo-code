# 最新接续状态 (2026-10-29 12:16)

## 核心进展
- v0.10.173 已发布（master `e86d1c9`，本地/远程同步，工作区干净）：工具执行遮罩文案区分阶段——执行期「工具调用执行中 Ns」，结果回传期「正在回传结果 Ns」，秒数连续不归零。
- 本轮共发三版：171（计划面板卡住修复 + 遮罩秒数）、172（执行反馈闭环：5 分钟超时兜底 + 秒数连续 + 纯净模式秒数）、173（回传阶段文案）。

## 核心动机与背景 (Motivation & Background)

**问题来源（用户反馈）**：
- 纯净模式顶部「计划」面板一直卡在「正在生成计划条目…」不显示实际清单。
- 工具执行时提示「工具调用执行中」反复出现，用户分不清是「还在跑」还是「卡住了」。
- 询问是否要加执行时间、是否需要 5 分钟超时兜底。

**171 的根因（两层，第二层是子代理挖出来的真凶）**：
- 表层：`todoWrite` 把任务列表按 projectDir 分桶存成对象 `{ "D:/xxx": [...] }`，主进程 `src/app/ipc/tool.ts` 用 `Array.isArray` 判断恒为 false，数据从未推送前端。
- 深层：`resetTodosCache()` 把 `__cuckooTodos` 置为**空数组 `[]`**，而 `todo-write.ts` 的守卫 `if (!x)` 判断空数组为 truthy，跳过对象初始化 → 列表被挂成数组自定义属性 → 主进程按数组分支取到空数组 → 不推送。且 `harness-send` 每次发消息都 reset，主路径必然踩中。

**172/173 的背景**：
- 遮罩原本无超时兜底，底层发送卡死则永久残留。
- 工具执行完到结果发出之间有「拟人化发送延迟」，默认 6~16 秒（`state.sendDelayMin/Max`，设置里可改，代码兜底 1~10 秒），期间文案仍写「工具调用执行中」语义不准。

## 关键设计与实现 (Implementation & Decisions)

**171 · 计划面板数据链路**
- `src/app/ipc/tool.ts`：`resetTodosCache` 写 `{}`；读取时**对象优先、数组兜底**（`allTodos && typeof allTodos === 'object' && !Array.isArray(allTodos)` 取 `allTodos[selectedDir || '__default__']`）。
- `src/tools/impl/todo-write.ts`：加防御——`__cuckooTodos` 是数组时重建为对象。

**172 · 执行反馈闭环**
- `src/overlay/panel.ts`：`MASK_TIMEOUT_MS = 5 * 60 * 1000`；`stopMaskTick()` 同时清 interval 与 timeout；超时 → `hideToolMask()` + `showToast('工具执行超过 5 分钟…')`（只解 UI，不杀进程）。`startMaskTick(reuse?)` 支持复用不重置。
- `src/bridge/intercept/observer.ts`：发送阶段 `showToolMask(fn, true)` 复用计时。
- `src/ui/harness.html`：`toolTickTimer / toolStartAt / startToolTick() / stopToolTick()`；`tool-start` 启动、`tool-end` 归零停止。**关键**：tick 内只写 `statusText.textContent`，绝不调 `setStatus`（会把 `generating` 置 true，导致工具结束后卡「生成中…」）。`markAborted()` 内加 `stopToolTick()` 防跨中止秒数错显。

**173 · 回传阶段文案**
- `panel.ts`：模块级 `maskLabel` + `renderMaskText()` 统一渲染出口；`startMaskTick(reuse?, label?)`；`showToolMask(onCancel?, reuseTick?, label?)`。
- `observer.ts`：发送阶段传 `'正在回传结果'`，reuse 时只换文案不动计时。

## 待办事项 (Next Steps)
- [ ] **真机验证（172 + 173 合并）**：装 v0.10.173 包，确认——① 网页模式工具执行秒数递增；② 进入回传文案变「正在回传结果」且秒数不归零；③ 5 分钟超时自动解除遮罩 + toast；④ 纯净模式状态条「工具运行中 Ns…」递增；⑤ 工具结束后状态恢复「就绪/生成中」，不卡「生成中…」；⑥ 中止后下一个工具秒数从 0 起算。
- [ ] 两条低优先级建议（子代理提，未做不阻断）：`panel.ts:254` 的 JSDoc 补 `@param reuseTick / @param label`；5 分钟超时是「执行+发送」累计寿命，非分阶段独立。
- [ ] 历史遗留：092 子代理并发池真机验证 A~H；`v0.10.164` tag 违规（含数字 4）仍在 origin，是否删除待定。

## 关键上下文
- 目录: `D:/Desktop/Super-File/cuckoo-code`
- 主要文件:
  - `src/overlay/panel.ts` — `showToolMask` / `hideToolMask` / `startMaskTick` / `stopMaskTick` / `renderMaskText`（遮罩与计时）
  - `src/bridge/intercept/observer.ts` — `processInterceptedResponse`（工具执行与结果回传两阶段）
  - `src/ui/harness.html` — `startToolTick` / `stopToolTick` / `markAborted` / `tool-start` / `tool-end` 分支（纯净模式秒数）
  - `src/app/ipc/tool.ts` — `resetTodosCache` / `execute-js` 内的 todo 推送逻辑
  - `src/tools/impl/todo-write.ts` — `__cuckooTodos` 写入与数组防御
  - `src/overlay/chat-input.ts` — `doSendToChat`（`randomDelay` 决定回传延迟；`afterSent` 触发 `hideToolMask`）

## 本场教训
1. **空数组是 truthy**：`if (!x)` 对 `[]` 不成立。写「初始化若不存在」守卫必须显式排除错误类型（`Array.isArray`）。
2. **工具运行 ≠ 模型生成**：改状态条文字若走 `setStatus`，会连带把 `generating` 置真，工具结束后状态卡死。只改文字就只改 `textContent`。
3. **重试前先确认上一次是否已成功**：本场因工具调用失败重试，导致同一段代码被重复插入 `harness.html`（23 行垃圾），引发语法错误，清理后才恢复。
4. **读不到文件内容时不要断言别人误读**：曾错误驳回子代理关于 `MainActivity.java` 的正确结论，后经 `readLines` 亲验纠正。
5. **子代理审查能救命**：171 的 `resetTodosCache` 高危问题、172 的 `markAborted` 停表边界，都是子代理顺着调用链挖出来的。
