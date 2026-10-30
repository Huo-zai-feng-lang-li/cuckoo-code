---
id: 101
type: fix
title: 手机端执行胶囊遮挡输入框 + 后台回来计时秒数爆炸
status: doing
branch: fix/101-remote-exec-pill-timer
created: 2026-10-31
updated: 2026-10-31
---

# 需求 101：手机端执行胶囊遮挡与后台计时异常

## 1. 背景

用户反馈两个手机端（远程 PWA）缺陷：

1. **执行胶囊被输入框遮挡**：输入框文字多行变高后，浮动执行状态胶囊（「生成中…」「延迟发送 Ns…」）被压到输入框后面看不见。
2. **切后台回来计时秒数异常**：手机切到后台一段时间再回来，「延迟发送」秒数显示成几百秒。

## 2. 根因

### ① 胶囊位置写死

`src/remote/pwa/style.css` 的 `.exec-status`：

```css
bottom: calc(env(safe-area-inset-bottom) + 70px);
```

70px 是按「单行输入框」估的。`#input` 有 `max-height: 120px`，多行输入时 composer 实际高度远超 70px，胶囊被盖住。

### ② 计时基准跨越了后台冻结期

`src/remote/pwa/app.js` 的 `startToolTick` / `startSendTick`：

```js
startAt = Date.now();
function tick() {
  const sec = Math.floor((Date.now() - startAt) / 1000);
  ...
}
setInterval(tick, 1000);
```

移动端浏览器切后台会**冻结 `setInterval`**（省电）。回来后定时器恢复，第一次 tick 算出的 `Date.now() - startAt` 是真实流逝的墙钟时间（可能是几百秒），秒数直接跳到几百。

现有 `visibilitychange` 只处理连接探活/重连，完全没管计时器。

## 3. 修复

### ① 胶囊跟随输入框实际高度

- `app.js` 新增 `ResizeObserver` 监听 `.composer`，把实际高度写入 CSS 变量 `--composer-h`
- `style.css` 改为 `bottom: calc(var(--composer-h, 70px) + 10px)`

不改 DOM 结构，兼容性最好（ResizeObserver：Chrome 64+ / Safari 13.1+，均有 fallback 到 `resize` 事件）。

### ② 后台回来补偿计时基准

`visibilitychange` 扩展：

- **进入后台**：记录 `hiddenAt`
- **回到前台**：
  - 离开 **> 10 秒**：执行态可能已过时（工具可能早已结束，或相关消息在后台丢失），保守清理状态条，等后续真实事件（`tool` / `sending` / `ai-reply` / `task-done`）重新驱动
  - 离开 **≤ 10 秒**：把 `startAt` 往后推 `awayMs`，秒数保持连续，不跳变
  - 之后继续原有的连接探活逻辑

阈值取 10 秒的理由：小于「去看个通知就回来」的时长（补偿有效），大于工具正常结束周期（避免误清理长任务）。

## 4. 影响面

- `src/remote/pwa/app.js`（新增 ResizeObserver + 扩展 visibilitychange）
- `src/remote/pwa/style.css`（1 处 bottom）
- 不涉及服务端、不涉及电脑端 UI、不涉及 IPC
- 计时器清理复用既有 `stopSendTick` / `stopToolTick` / `hideExec`，无新增状态

## 5. 验证

- typecheck / compile / test / lint 全绿
- PWA 真机（HTTP + mock WebSocket）：
  - 多行输入时胶囊始终在输入框上方
  - 模拟后台 30 秒回来，秒数不跳变（清理或连续）
  - 模拟短暂切后台 2 秒，秒数连续
  - 不回归：单工具全链路、多工具并行、停止按钮、断线 3s 清理
