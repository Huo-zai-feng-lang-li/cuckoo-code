---
id: 056
type: fix
title: 审计整改：053 dataset.raw O(n²) + 054 增量标记脱钩丢字
status: done
branch: fix/056-audit-rectify-perf-cache
created: 2026-10-16
updated: 2026-10-16
---

## 背景

对已发布的 v0.8.81（053）、v0.8.82（054）做独立子代理审计，发现以下真缺陷：

### 🔴 A（053）：手机端每帧全量回写 `dataset.raw` → 重新引入 O(n²)
- `src/remote/pwa/app.js:556`：`appendStreaming` 每帧执行 `streamingEl.dataset.raw = streamingText`，
  把持续增长的字符串写入 DOM 属性，浏览器须整串 flatten + 序列化 → 单帧 O(n)、累计 O(n²)。
- `appendChild(createTextNode(delta))` 的优化被这一行抵消。
- **修复**：流式期间不写 `dataset.raw`（复制/后续渲染由 `finishStreaming` 写全量，无遗漏）。

### 🟡 B（053）：bridge `stop`/`error` 分支丢弃 `pendingText` → 丢尾帧
- `src/bridge/remote-bridge.ts:52-55`：`stopStreamThrottle()` 清了 timer 和 pendingText，但**未 flush**。
- `onUserStop` / `onAiError` 之后没有全量帧兜底 → 节流窗口内最后 <100ms 的文本永久丢失。
- **修复**：`stopStreamThrottle(flush: boolean)`，stop/error 传 true 先 flush 一次，reply 传 false（有全量帧兜底，避免重复）。

### 🔴 C（054）：Harness 增量渲染标记与气泡脱钩 → 前缀巧合丢字
- `src/ui/harness.html:2505-2507`：`_streamRenderedText` / `_streamRenderedThink` 是全局裸变量，
  只在 `resetStreamRender()` 清零；`appendStreamBody` 的续写判据是 `full.startsWith(rendered)`。
- 触发：`stop()` / `send()` / `tool-start` 新建气泡时不复位标记 → 若新气泡文本恰好以旧标记为前缀，`delta = full.slice(旧长度)` 吞掉前缀。
- **修复**：
  1. 标记增加 body 归属校验（`_streamRenderedTextBody` / `_streamRenderedThinkBody`）：body 换了标记作废，走清空重来。
  2. `stop()` / `send()` 显式调 `resetStreamRender()`（双保险）。

### 🟡 D（054）：`clearPendingBubble` 只从 `cur.body` 摘光标，thinkBody 里的漏摘
- 多数路径后跟 `resetStreamRender()` 兜住，但 `stop()` 之类不跟 reset 的路径会在思考块留一个闪烁光标。
- **修复**：`clearPendingBubble` 末尾补 `resetStreamRender()`。

### 🔵 E（054）：`cancelStreamRender` 已成空壳（`resetStreamRender` 的别名），全仓无有效调用点
- **修复**：删除。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机验证：长回复流式流畅度、stop 后重发不丢字、stop 后无光标残渣

## 备注

均为上一轮审计发现的真缺陷（性能回退 + 隐性数据损坏），按项目规则视为 bug 修复。
