# 最新接续状态 (2026-11-08 19:55)

## 核心进展

- **`v0.10.208` 关键缺陷修复：DeepSeek 官方 SSE 协议与事件模型升级适配（需求 107）已彻底闭环**。
  - 用户反馈官方网页端正常对话未被限流，但 Cuckoo Code 频繁弹出 Toast 报「请求失败，17 秒后自动重试…」。
  - 经从官方生产 Bundle（`chat.deepseek.com` 的 `main.9120333998.js`）反编译取证，彻底确诊官方通信协议变更：废弃 `response/status = FINISHED` 状态帧并转为标准 SSE `event: finish` / `event: close`，且 Delta 采用状态化继承与 BATCH 路径级联（官方 `class xY`）。
  - 新增 `src/providers/hooks/shared/deepseek-protocol.ts` 纯函数模块，升级 `src/providers/hooks/shared/sse.ts` 与 `src/providers/hooks/deepseek.ts`。
  - 用户本地真机实测确认 bug 已经完全修复，四项校验（typecheck / test 1336 用例 / lint 0 errors / compile）全绿。

## 核心动机与背景 (Motivation & Background)

- **Bug 根因深度剖析**：
  1. **暗号废弃**：官方已不再向 JSON 内部注入 `response/status = FINISHED`，而是使用标准 SSE 事件机制分发 `event: finish` / `event: close`。
  2. **事件行丢失**：原有公共 `src/providers/hooks/shared/sse.ts` 只通过 `extractData` 捕获 `data:` 行并把 `event:` 行整行丢弃，导致 `extractor.finished` 永远为 `false`。
  3. **Stateful Delta 与 BATCH 级联失配**：官方 Delta 引擎具备上下文状态机，缺省 `p`/`o` 延续上一帧；在嵌套 `BATCH` 中外层 path 会自动拼接到内层 sub-path（例如外层 `response` + 内层 `fragments/0/content`）。原 hook 未处理父路径拼接，导致正文长度被算作 0（`textLen === 0`）。
  4. **终态误判触发重试**：流自然结束时因 `finished` 未置位且 `textLen === 0`，`resolveStatus()` 兜底降级为 `'error'`，进而向应用层派发 `cuckoo-ai-error`，导致 `src/bridge/loop/retry.ts` 频繁唤起 15~30 秒退避倒计时。

## 关键设计与实现 (Implementation & Decisions)

1. **共享 SSE 解析器升级（`src/providers/hooks/shared/sse.ts`）**：
   - 新增 `parseSseBlock(block: string): ParsedSseFrame | null`，按行抽取 `event:` 与 `data:` 并安全反序列化 JSON，空块/注释块安全跳过；
   - 保留 `extractData` 与 `parseBlock` 既有接口，保持 100% 向后兼容。
2. **纯函数协议解耦（`src/providers/hooks/shared/deepseek-protocol.ts`）**：
   - `flattenDelta(item, parentPath, state)`：状态化 Delta 解析器，支持状态（`op`/`path`）继承与任意深度的 `BATCH` 路径级联；
   - `decideDeepSeekStreamExit(opts)`：纯函数终态裁决器（主动停止 > 服务端截断 > 流内 Toast 限流 > 完成事件终态 > 正文宽容收尾），圈复杂度仅为 1。
3. **DeepSeek 拦截器适配与多级兜底（`src/providers/hooks/deepseek.ts`）**：
   - `fetch` 与 `XHR` 拦截流全面切换至 `parseSseBlock`；
   - 识别 `event: finish` / `event: close` 即刻标记 `finished = true`；
   - 识别 `event: toast` / `event: hint` 文案捕获流内限流，同时兼容 JSON 对象与纯文本载荷；
   - `isFragmentsPatch` 全面支持 `o: "SET"` 与 `o: "APPEND"`；
   - 状态裁决委托给纯函数 `decideDeepSeekStreamExit`。
4. **测试与文档**：
   - `test/providers/hooks/shared/sse.test.js`：补齐针对 `parseSseBlock` 的事件与数据提取单测；
   - `test/providers/hooks/shared/deepseek-protocol.test.js`：补齐 BATCH 级联、状态继承及终态边界单测；
   - 需求档案：`docs/requirements/107-deepseek-sse-protocol-adapt.md`（状态标记为 completed）。

## 待办事项 (Next Steps)

- [x] DeepSeek 官方新版 SSE 协议与 Delta 状态化适配
- [x] `npm run compile`、`npm run typecheck`、`npm test`、`npm run lint` 全部跑通
- [x] 用户本地真机实测验证通过
- [x] 更新需求档案 107 与接力文档
- [ ] 后续若官方再度调整 Web 端认证或心跳帧机制，可继续在 `deepseek-protocol.ts` 纯函数中单点扩展

## 关键上下文

- 目录: `d:\Desktop\Super-File\cuckoo-code`
- 主要文件:
  - `src/providers/hooks/shared/sse.ts` (`parseSseBlock`)
  - `src/providers/hooks/shared/deepseek-protocol.ts` (`flattenDelta`, `decideDeepSeekStreamExit`)
  - `src/providers/hooks/deepseek.ts` (`observeBody`, `observeXhr`, `createExtractor`)
  - `test/providers/hooks/shared/sse.test.js`
  - `test/providers/hooks/shared/deepseek-protocol.test.js`
  - `docs/requirements/107-deepseek-sse-protocol-adapt.md`
