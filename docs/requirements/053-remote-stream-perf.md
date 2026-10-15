---
id: 053
type: performance
title: 远程手机端性能：流式全量广播/渲染 O(n²) + serveStatic 同步 IO
status: done
branch: perf/053-remote-stream-perf
created: 2026-10-15
updated: 2026-10-15
---

## 背景

远程手机端（PWA）与电脑端（Electron 主进程）的流式链路存在三处确凿性能缺陷，长回复（>2000 字）场景下体验明显退化（卡顿、发烫、光标闪烁、隧道带宽暴涨）：

1. **手机端每帧全量重渲染（O(n²)）**：`src/remote/pwa/app.js` 的 `appendStreaming(full)` 每收到一帧就对**全文**执行 `md.parse + sanitize + innerHTML`（整棵 DOM 子树销毁重建）。5000 字回复下每秒 10 次全量解析 + DOMParser 构造 + DOM 重建。
2. **电脑端每帧全量广播（O(n²)）**：`src/remote/manager.ts` 的 `onAiStream` 每 100ms 广播**整个累积文本**，总出站量 ≈ L·M/2。经 cloudflared 隧道时带宽被放大数十倍。
3. **bridge 层每帧全量 stripBlocks**：`src/bridge/remote-bridge.ts` 的 `onStream` 对**全量文本**跑 6 次正则（含贪婪 `[\s\S]*`），发生在 AI 页面 preload 主线程，拖慢 AI 网页本身。
4. **serveStatic 同步读盘**：`src/remote/server.ts` 用 `fs.readFileSync` 阻塞 Electron 主进程事件循环。

## 目标

- 两端流式复杂度从 O(L²) 降到 O(L)；
- serveStatic 异步化，不阻塞主进程；
- 保持对外行为不变（含工具块过滤、Markdown 最终渲染、光标动画）。

## 改动

### 1. server.ts serveStatic 异步化（零风险）
`handleRequest` 与 `serveStatic` 改 async，`fs.readFileSync` → `await fs.promises.readFile`。异常路径不变。

### 2. manager.ts 改 delta 协议（核心）
`StreamState` 增加 `sent` 字段记录上次已广播的文本。`flushStream` 计算增量：
- 若 `s.text` 以 `s.sent` 开头 → `delta = 新增部分`，`reset = false`
- 否则（非前缀，说明 strip 结果发生回退/重排）→ `delta = 全文`，`reset = true`

广播改为 `{ type: 'ai-stream', profileId, delta, reset }`，**不再发全量 `text`**。

### 3. remote-bridge.ts 增量化 stripBlocks 快速路径
新增 `everHadFence` 标记：若历史与本次新增部分均无反引号围栏，直接 `return text.trim()`（与 stripBlocks 严格等价，因三正则均以 `````` 开头）；出现围栏后回退到完整 `stripBlocks`（保证正确）。

### 4. pwa/app.js 流式纯文本增量追加
- `startStreaming` 创建 `.stream-text` 文本容器节点（位于光标之前）。
- `appendStreaming(delta, reset)`：`reset` 时清空文本节点；否则 `appendChild(document.createTextNode(delta))` **纯文本追加**，不做 markdown 解析、不重建 DOM。
- 结束帧 `ai-reply` 仍走 `renderMd` 全量渲染（保留最终 Markdown 样式 + 代码块装饰）。

## 兼容性

- 协议变更（ai-stream 由全量 text 改为 delta/reset）：电脑端与手机端**同步发布**，老手机端连新电脑端会看不到流式（但结束帧 ai-reply 仍正常渲染）——可接受。
- 流式期间失去 Markdown 实时样式（结束帧补齐），是性能换体验的明确取舍。

## 验证

- [ ] typecheck / test / lint / compile 全绿
- [ ] 子代理审计 + 主代理复核
- [ ] 用户真机验证（长回复流畅度、最终渲染正确性）

## 备注

本次改动为「准 bug 修复」：不是崩溃型 bug，而是长回复场景下的体验退化（O(n²) 放大）。用户明确要求全部修复后自行测试。
