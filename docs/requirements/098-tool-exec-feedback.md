---
id: 098
type: feat
title: 工具执行反馈闭环（遮罩超时兜底 + 纯净模式秒数 + 发送阶段计时复用）
status: doing
branch: feat/098-tool-exec-feedback
created: 2026-10-29
updated: 2026-10-29
---

# 需求 098：工具执行反馈闭环

## 1. 背景
工具执行期间用户无法判断"还在跑"还是"卡住"，三类场景各有缺口：

| 场景 | 现状 | 问题 |
|---|---|---|
| 原版网页（遮罩） | 有秒数（097 之后） | 无超时兜底，底层发送卡死则遮罩永久残留 |
| 原版网页（发送阶段） | 二次 `showToolMask` | 秒数归零重数，易误判为"卡住" |
| 纯净模式 | 只有「工具运行中…」静态文字 | 无秒数，长时间执行看不出是否活着 |

## 2. 方案

### 2.1 遮罩超时兜底（src/overlay/panel.ts）
- 新增 `MASK_TIMEOUT_MS = 5 * 60 * 1000`。
- `startMaskTick()` 内启动一个 `setTimeout`：超时则 `hideToolMask()` + `showToast('工具执行超过 5 分钟，已解除遮罩（后台可能仍在运行），请检查')`。
- `stopMaskTick()` 同时清 interval 和 timeout。
- **只解除 UI 遮罩，不中止工具进程**。进程层已有 `JsRunner` 的 60s 无活动兜底、`bash/pwsh` 自身 timeout，UI 层不应越权杀进程。

### 2.2 发送阶段计时复用（src/overlay/panel.ts + src/bridge/intercept/observer.ts）
- `showToolMask(onCancel?, reuseTick?)` 增加第二参数。
- `reuseTick === true` 且已有计时器时，**不重置** `maskStartAt`。
- `observer.ts:255` 的发送阶段调用改为 `showToolMask(fn, true)`，秒数连续不归零。

### 2.3 纯净模式秒数（src/ui/harness.html）
- 新增 `toolTickTimer` / `toolStartAt`。
- `tool-start`：`toolRunningCount++` 后调 `startToolTick()`；每秒把状态条刷成「工具运行中 Ns…」。
- `tool-end`：`toolRunningCount--`；归零时 `stopToolTick()`。
- 计时器回调内若 `toolRunningCount <= 0` 或 `isBusy()` 为假，自停，防泄漏。
- **只在"工具运行中"语义下刷新**，不覆盖"生成中…"（工具与生成可能交替）。

## 3. 涉及文件
- `src/overlay/panel.ts`
- `src/bridge/intercept/observer.ts`
- `src/ui/harness.html`

## 4. 验收标准
- [ ] 遮罩显示 5 分钟自动解除并 toast 提示
- [ ] 遮罩正常隐藏时超时定时器被清理（不误触发）
- [ ] 发送阶段秒数连续（不归零）
- [ ] 纯净模式工具执行时状态条显示递增秒数
- [ ] 工具结束/任务结束后秒数停止、状态恢复
- [ ] typecheck / test / lint / compile 全绿
