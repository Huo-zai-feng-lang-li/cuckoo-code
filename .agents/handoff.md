# 最新接续状态 (2026-10-15 23:30)

## 核心进展
- **053 远程手机端流式性能修复（O(n²) → O(n)）** 已闭环并发版 v0.8.81（分支 perf/053-remote-stream-perf）。核心：两端流式链路从「全量覆盖」改「增量协议」，另修一处幽灵帧竞态。

## 核心动机与背景 (Motivation & Background)
- **问题**：远程手机端（PWA）与电脑端（主进程）的流式链路全线按「全量覆盖」设计，长回复（>2000 字）性能随文本长度**平方级放大**：
  - 主进程每 100ms 广播**整个累积文本**（总出站量 ≈ L·M/2，经 Cloudflare 隧道放大数十倍）；
  - 手机端每帧对**全文**执行 `markdown 解析 + XSS 消毒（new DOMParser）+ innerHTML 整棵子树重建`；
  - bridge 层每个 token 事件都对全量文本跑 `stripBlocks`（6 次正则），占满 AI 页面主线程；
  - `serveStatic` 用 `readFileSync` 阻塞主进程。
- **性质**：不是崩溃型 bug，是长回复场景下的体验退化（卡顿/发烫/光标闪烁/带宽暴涨），用户判定为「准 bug」要求修复。

## 关键设计与实现 (Implementation & Decisions)
- **增量协议**：`StreamState` 新增 `sent` 字段（已发送基线）。`flushStream` 以 `s.text.startsWith(s.sent)` 判断——是前缀则发 `delta = 新增部分`（reset=false），否则发全文（reset=true）。三条终帧（reply/stop/error）清 `sent`。
- **手机端**：`startStreaming` 建 `.stream-text` 文本容器 + 光标；`appendStreaming(delta, reset)` 非 reset 时 `appendChild(createTextNode(delta))`（真 O(n)），reset 时 `textContent` 全量覆盖；`finishStreaming` 才 `renderMd` 全量渲染 + `decorateContent` + `attachActions`，并 `classList.remove('streaming')`。
- **bridge 节流**：`streamTimer/pendingText` 合并到 ~100ms 一次；**关键**：三个终帧回调入口统一调 `stopStreamThrottle()` 清幽灵帧（否则竞态 → 手机端僵尸气泡 + 按钮永久禁用）。
- **serveStatic 异步化**：`fs.promises.stat/readFile`；catch 里防 `headersSent` 重复写头。
- **取舍**：流式期间为纯文本（失去实时 Markdown 样式），结束帧补齐——性能换体验。
- **协议兼容**：电脑端与手机端同步发布；老手机端连新电脑端会看不到流式（结束帧 ai-reply 仍正常）。

## 待办事项 (Next Steps)
- [ ] **用户真机验证**：长回复流式流畅度、最终 Markdown 渲染正确性、幽灵帧是否复现。
- [ ] **（低优先）双层节流**：bridge 100ms + manager 100ms → 端到端首帧延迟 ~200ms，可考虑合并为单层。
- [ ] **（低优先）图片上传**：base64 塞 WS 单帧（8MB→~11MB），可改 HTTP POST 分片。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 分支: perf/053-remote-stream-perf
- 主要文件:
  - `src/remote/manager.ts`：`StreamState`（含 sent）、`flushStream`（delta）、`onAiStream/onAiReply/onAiStop/onAiError`
  - `src/remote/pwa/app.js`：`startStreaming/appendStreaming/finishStreaming`、`streamNode`
  - `src/bridge/remote-bridge.ts`：`onStream` 节流 + `stopStreamThrottle`
  - `src/remote/server.ts`：`serveStatic` 异步
  - `src/remote/pwa/style.css`：`.stream-text`
  - `docs/requirements/053-remote-stream-perf.md`：需求档案
- 验证状态：typecheck / test(978) / lint(0 error) / compile 全绿；code-reviewer 审计的 2 个 P0 竞态已修复。
