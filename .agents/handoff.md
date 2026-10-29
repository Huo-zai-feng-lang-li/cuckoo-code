# 最新接续状态 (2026-10-29 · v0.10.172 已发版)

## 核心进展
- **v0.10.172 发布**：工具执行反馈闭环（遮罩超时兜底 + 秒数连续 + 纯净模式秒数）。
- 近期版本：094/095/096/097（远程与通知）→ 171（计划面板修复 + 遮罩秒数）→ 172（执行反馈闭环）。

## v0.10.172 改动（需求 098）

### 1. 遮罩超时兜底（src/overlay/panel.ts）
- `MASK_TIMEOUT_MS = 5 * 60 * 1000`；`stopMaskTick()` 同时清 interval 和 timeout。
- 超时 → `hideToolMask()` + `showToast('工具执行超过 5 分钟，已解除遮罩…')`。
- **只解 UI 不杀进程**：进程层已有 JsRunner 60s 无活动兜底、bash/pwsh 自身 timeout。

### 2. 发送阶段计时复用（panel.ts + observer.ts）
- `showToolMask(onCancel?, reuseTick?)` / `startMaskTick(reuse?)`。
- observer.ts 发送阶段传 `true`，秒数连续不归零。

### 3. 纯净模式秒数（src/ui/harness.html）
- `toolTickTimer / toolStartAt / startToolTick() / stopToolTick()`。
- `tool-start` 启动、`tool-end` 归零时停。
- **关键防 bug**：tick 内只写 `statusText.textContent`，**绝不调 setStatus**（会把 generating 置 true，导致工具结束后卡「生成中…」）。
- `markAborted()` 内加 `stopToolTick()`，防跨中止秒数错显。

## 验证
- typecheck / lint（0 error）/ test（131 文件 1304 用例）/ compile 全绿。
- 内联脚本 SYNTAX_OK。
- 子代理 code-reviewer 审查：确认 setStatus 副作用已绕开、无定时器泄漏、超时清理正确；指出 markAborted 未停表（已修）、statusText 未 guard（已加）。

## 已知取舍（未改，可接受）
1. 超时解除后，若工具随后完成进入发送阶段，遮罩会再短暂出现（发送阶段确有遮盖需求）。
2. 5 分钟是「执行+发送」累计总寿命，非分阶段独立。
3. tick 每秒覆盖 statusText，会吞掉同期「框架：…」文案（工具期只显示时长，设计取舍）。

## 真机验证清单（098）
- [ ] 原版网页工具执行，秒数连续递增，进入回传不归零
- [ ] 等待/模拟 5 分钟 → 遮罩自动解除 + toast
- [ ] 纯净模式工具执行，状态条显示「工具运行中 Ns…」递增
- [ ] 工具结束状态正确恢复（不卡「生成中…」）
- [ ] 中止任务后，下一个工具秒数从 0 起算

## 历史遗留
- 092 子代理并发池真机验证 A~H 未做。
- `v0.10.164` tag 违规（含数字 4）仍在 origin。

## 教训
- **「工具运行」≠「模型生成」**：改状态条文字时若走 `setStatus`，会连带把 `generating` 置真，工具结束后状态卡死。只改文字就只改 `textContent`。
- 子代理提的「markAborted 未停表」是真实边界：中止与下一工具 start 间隔 <1s 时会沿用旧起点，秒数错显。一行 `stopToolTick()` 解决。
