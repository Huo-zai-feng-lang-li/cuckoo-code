---
id: 128
type: fix
title: 纯净模式长暂停结束后的发送状态顺序修复
status: doing
branch: fix/127-env-fingerprint-hardening
created: 2026-11-23
updated: 2026-11-23
---

# 128 纯净模式长暂停结束后的发送状态顺序修复

- 状态：代码与单测完成，待真机复验
- 分支：随 `fix/127-env-fingerprint-hardening` 验证（未单独切分支）
- 日期：2026-11-23

## 用户现象

随机长暂停倒计时结束后，宠物先显示「生成中…」，随后才显示「把结果发给 AI…（结果发给模型）」。用户预期是：暂停结束应立即进入投递，宠物提示「发给模型」，等模型真正开始回答后再显示「生成中」。

## 根因

两处状态源叠加，顺序与真实因果相反：

1. `src/ui/harness.html` 的 `tool-end` 为保活 `sendTick`，用 `setStatus('生成中…','busy')` 把 `generating` 置为 `true`。长暂停结束分支调用 `syncPet()` 时命中 `generating` 分支，宠物先切 `thinking` 并冒「生成中…」。
2. `src/bridge/harness-bridge.ts` 的 `onMessageDelivered` 先 `setAiGenerating(true)`（上报 `ai-state`），后上报 `framework-send`。harness 先收到「生成中」，后收到「已发送/结果发给模型」，进一步固化了颠倒顺序。

## 改动

| 文件 | 内容 |
|---|---|
| `src/bridge/harness-bridge.ts` | `onMessageDelivered` 先上报 `framework-send`，再 `setAiGenerating(true)`；`tag === 'harness'` 仍只更新生成态、不报框架投递 |
| `src/ui/harness.html` | `send-pause` 结束分支停表后直接进入「正在发送…（工具结果）」+ 宠物 `waiting` / 「把结果发给 AI…」；不再在该分支调用 `syncPet()`（否则会被 `generating=true` 按回「生成中」）。`syncPet()` 只保留在暂停进行中的分支 |
| `test/bridge/harness-bridge.test.js` | 新增「先 framework-send、后 ai-state」顺序用例 |
| `test/ui/harness-page.test.js` | 新增「长暂停结束先等待投递、不回落生成中」源码守卫；更新原暂停结束断言 |

## 边界

- 只修显示顺序，不改发送/RNG/长暂停时长与 `chat-input` 的投递逻辑。
- 暂停结束到 `framework-send` 之间新增一个短暂的「正在发送」窗口；若投递彻底失败，仍由既有 `ai-error` / 重试 / 静默兜底收尾。
- 手机端 PWA 的状态链路不在本次改动范围。

## 验证

- `npx vitest run test/bridge/harness-bridge.test.js`：31/31 通过（新增顺序用例先红后绿）。
- `npx vitest run test/ui/harness-page.test.js`：51/51 通过。
- `npm run typecheck`：通过。
- `npm test`：153 文件 / 1556 用例通过。
- `npm run lint`：0 error / 72 warning（历史遗留）。
- `npm run compile`：通过。
- 真机：待用户按原路径触发随机长暂停复验。

## 遗留

- 真机需确认三帧顺序：暂停结束「正在发送…」→「已发送，等待 AI 响应…」→ 首个流式帧「生成中…」。
- 宠物视觉状态与气泡文案仍可能不同步（`onFrameworkSend` 的 `setStatus` 会先把宠物置 `thinking`，随后气泡改「把结果发给 AI…」）；本次以气泡/状态文案顺序为准，未扩展调整宠物动画。
