---
id: 124
type: fix
title: 手机端宠物补齐延迟状态同步
status: done
branch: fix/124-mobile-pet-delay-sync
created: 2026-11-17
updated: 2026-11-17
---

# 124：手机端宠物补齐延迟状态同步

> 状态：**done**
> 分支：`fix/124-mobile-pet-delay-sync`
> 最近更新：2026-11-17

## 一、用户原始目标与痛点

手机端（PWA）宠物在两类"延迟窗口"里状态不同步：

1. **工具跑完的 6~16s 拟人化回传延迟**：宠物一直停在 `working`（跑起来了 / 搬砖中），
   与"其实在等结果投递"不符。
2. **30~75s 随机长暂停**（拟人化"走神"）：宠物**完全无响应**，停在上一个状态。

桌面端两处都有：纯净模式内嵌宠物与桌面浮窗都会切到 `waiting` / `pausing`。

## 二、根因

| 环节 | 桌面端 | 手机端（修复前） |
|---|---|---|
| 工具 `sending` 相位 | `tool` 事件 → 宠物 waiting | `onToolEvent` 的 `sending` 分支只停表起表，**不调 `petEvent`** |
| 随机长暂停 `send-pause` | `harness.html` 有 `case 'send-pause'` → `petMood('pausing')` | 事件**根本没到手机端**：`remote-bridge.ts` 未订阅 `onSendPause` |

即：不是渲染层缺能力，而是**上报链路断在 bridge**，加上 PWA 分发层漏了一个分支。
`mobile-pet.js` 的 `MOOD_BY_STATE` 也缺 `pausing` 分组。

## 三、改动

1. `src/bridge/remote-bridge.ts`：新增 `onSendPause` 订阅 → `report({type:'send-pause', active, durationMs})`，带 enabled 门控。
2. `src/app/ipc/remote.ts`：`remote-report` handler 新增 dispatch → `onSendPause(active, durationMs, profileId)`。
3. `src/remote/manager.ts`：新增并导出 `onSendPause`，广播带 `profileId` 实现多窗口隔离。
4. `src/remote/pwa/app.js`：
   - `onToolEvent` 的 `sending` 分支补 `petEvent('waiting')`；
   - 新增 `case 'send-pause'`：active=true → 停表（`SEND_TICK_MAX_MS` 45s 硬超时挡不住 30~75s 暂停）、显示暂停文案、宠物 `pausing`；active=false → 收尾四件套对齐 `ai-stop`。
5. `src/remote/pwa/mobile-pet.js`：`MOOD_BY_STATE` 增 `pausing`；`waiting`/`pausing` 均走 `setState('idle')` 只换情绪组（与 `pet-window.html` 映射一致）。

**复用而非新造**：情绪文案沿用 `pet.js` 的 `MOODS.pausing`；事件源沿用 `overlay/chat-input.ts` 的 `onSendPause`；管道沿用既有 `report → remote-report → broadcast → handleServerMessage`；界面沿用 `showExec/hideExec/stopSendTick`。净新增代码约 60 行。

## 四、验证

- 新增 `test/remote/mobile-pet.test.js`（10 用例，vm 跑真实适配层源码于模拟 `window/document/localStorage` 边界，含引擎缺失 / create 抛异常 / 宿主缺失 / localStorage 抛异常 / destroy 后调用五条失败路径）。
- 新增 `test/remote/pwa-app-pet.test.js`（5 用例，钉住 `app.js` 的接线约束：语法可解析、sending→waiting、send-pause→pausing、过滤在收尾之前、收尾四件套齐全）。
- 四门禁：typecheck 0 错 / 150 文件 1526 用例全通过 / lint 0 error / compile 通过。

## 五、遗留

- 手机端生成中映射为 `thinking`，桌面内嵌宠物用 `writing`、桌面浮窗用 `thinking`——桌面端自身两处就不统一，本次不夹带，单独评估。
- 手机端宠物**不显示功能状态文案**（工具运行中 Ns 等），由 `exec-status` 胶囊承担，属既有窄屏设计取舍。
- 真机验证由用户自行完成。
