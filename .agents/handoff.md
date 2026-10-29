# 最新接续状态 (2026-10-29 第四场 · 已发版)

## 核心进展
- **需求 096 已发版 v0.10.169**：修复手机端在正常任务结束时误弹「已停止生成」气泡。
- 近期版本：094（扫码布局+APK 固定签名，v0.10.167）→ 095（子代理泄漏远程事件，v0.10.168）→ 096（停止气泡误报，v0.10.169）。
- **当前版本**：v0.10.169。

## 096 根因
电脑端 busy watchdog 在「网页已不在生成、静默超 8 秒」时主动收尾并广播 `ai-stop`，手机端对**所有** `ai-stop` 都显示「已停止生成」。

触发条件（很常见）：任务**最后一轮只输出工具代码块、没有正文** →
1. `stripBlocks` 把内容剥空 → `remote-bridge.ts:97` `if (!clean) return` → 不发 `ai-reply`
2. `manager.ts` 的 `s.active` 保持 true（只有 ai-reply/stop/error 才清）
3. `onTaskDone` 明确不清流式状态（manager.ts:384 注释写明）
4. 8 秒后 watchdog 判定需要兜底 → `onAiStop` → 手机弹「已停止生成」

用户什么都没停止，任务只是正常做完了。所以现象是「有时候」——取决于最后一步有没有正文。

## 修复（只改气泡显示，不动状态流转）
- `src/remote/manager.ts`：`onAiStop(profileId, reason = 'user')`，broadcast 带 `reason`；`busyWatchdogTick` 传 `'watchdog'`。
- `src/remote/pwa/app.js`：`ai-stop` 分支 `reason === 'watchdog'` 时 `hideExec(); break;`——只复位状态、不弹气泡。
  - **注意**：这里必须显式 `hideExec()`。子代理审查发现初版漏了它，该场景下 `onToolEvent('end')` 已把执行条置为「正在生成回复…」，不隐藏会永久残留。

## 验证
- `npm run typecheck` ✅
- `npm test` ✅ 131 文件 / 1304 用例
- `npm run lint` ✅ 0 error（65 个既有 warning）
- `npm run compile` ✅
- 子代理 code-reviewer 审查：指出 `hideExec()` 遗漏（已修），其余 4 项核验通过
- **未做真机验证**

## 真机验证清单（待做）
- A. 让任务最后一轮只调工具（无正文），手机端**不再**弹「已停止生成」，且执行状态条正常消失（不卡「正在生成回复」）
- B. 手机端主动点停止 → 仍弹「已停止生成」
- C. 网页端点停止 → 仍弹「已停止生成」

## 尚未修复的相关问题（待用户决定）
1. **`onTaskDone` 不清流式状态**，导致 watchdog 每轮都要干等 8 秒才收尾。彻底修法是让 `onTaskDone` 也清状态（与 `onAiReply` 一致），但会改动状态流转，096 刻意没做。
2. **ChatGPT 平台把断流判为用户停止**（`providers/hooks/chatgpt.ts:117`，`AbortedError`/`XHR status===0`），弱网时会误报「已停止生成」。DeepSeek 只认 `stop_stream` 请求，无此问题。
3. `onPhoneStop` 双次 ai-stop（pre-existing，手机侧幂等）。

## 历史遗留
- 092 子代理并发池的真机验证清单 A~H 仍未做。
- `v0.10.164` tag 违规（含数字 4）仍在 origin。

## 教训
- **「共用 profileId」是隐形炸弹**：任何以 profileId 为键的广播/状态，都必须显式区分主窗口与子代理（095）。
- **事件语义复用是误报温床**：`ai-stop` 同时承担「用户停止」和「兜底收尾」两种语义，用户就会看到莫名其妙的提示。加 `reason` 区分是低成本正解（096）。
- **只改显示不等于只改一行**：剥离气泡后，原先被 `showExecBrief` 顺带做掉的 `hideExec` 就漏了——子代理审查抓到了，说明改显示路径也要核对全部状态复位点。
