---
id: 107
type: fix
title: DeepSeek 官方 SSE 协议升级导致频繁误判为请求失败与自动重试
status: completed
branch: fix/107-deepseek-sse-protocol-adapt
created: 2026-11-08
updated: 2026-11-08
---

# 需求 107：DeepSeek 官方 SSE 协议升级导致频繁误判为请求失败与自动重试

## 1. 背景与现象

用户反馈：在 DeepSeek 网页端原本没有被限流，内容正常生成，但 Cuckoo Code 频繁弹出 Toast：
`“请求失败，17 秒后自动重试… 取消”`。

经核验：
- 17 秒落在 `src/bridge/loop/retry.ts` 默认的 15~30 秒普通失败退避区间，证明系统走的是**普通失败重试**，而非 429 限流重试（429 是 120 秒）。
- 根本原因在于 DeepSeek 官方近期更新了前端与服务端通信协议，导致我们原有的 SSE 解析器与网络 Hook 无法正确识别完成状态与增量数据。

## 2. 根因分析（基于官方生产环境 JS 逆向审计）

经从官方生产 JS（`https://fe-static.deepseek.com/chat/static/main.9120333998.js`）反编译提取官方实现：
1. **完成暗号废弃**：官方已彻底移除了 `p: "response/status", v: "FINISHED"`。改用标准 SSE 事件类型 `event: finish` / `event: close`。
2. **多行事件被丢弃**：公共解码器 `src/providers/hooks/shared/sse.ts` 的 `extractData(block)` 仅提取 `data:` 行，导致 `event:` 行被整行丢弃，`extractor.finished` 永远为 `false`。
3. **Stateful Delta 继承机制**：官方 `class xY`（DeltaParser）具备状态继承机制：
   - 缺省 `p`（path）时继承上一帧的 `path`，缺省 `o` 时继承上一帧的 `op`；
   - `BATCH` 操作时，父路径会自动拼接到内层各子元素的前缀上（`e.path = (s ? s + "/" : "") + e.path`）。
   - 原有 `deepseek.ts` 在处理 `BATCH` 时丢失了外层 `p`，导致 `isResponsePatch(p)` 判断失败，正文被丢弃。
4. **终态误判**：由于既没有收到旧版 `FINISHED`，且可能因路径解析问题导致 `textLen === 0`，流结束时 `resolveStatus` 进入兜底分支返回 `'error'`，派发 `cuckoo-ai-error`，触发了 15~30 秒的重试倒计时。

## 3. 修复方案

1. **`src/providers/hooks/shared/sse.ts`**：
   - 保留向后兼容的 `extractData` 和 `parseBlock`；
   - 新增 `parseSseBlock(block: string): ParsedSseFrame | null`，同时提取 `event:` 与 `data:` 并尝试 JSON 反序列化。
2. **`src/providers/hooks/shared/deepseek-protocol.ts`（纯函数抽取）**：
   - `flattenDelta(item, parentPath, state)`：支持 BATCH 路径深层级联与 Delta 状态（op/path）继承；
   - `decideDeepSeekStreamExit(opts)`：纯函数终态裁决，圈复杂度降至极低。
3. **`src/providers/hooks/deepseek.ts`**：
   - 使用 `parseSseBlock` 代替纯 `parseBlock`；
   - 支持处理 `event: finish` 与 `event: close`，将 `finished` 置为 `true`；
   - 支持处理 `event: toast` 与 `event: hint`，识别限流文案（JSON/纯文本双重适配）；
   - `isFragmentsPatch` 支持 `o: "SET"` 与 `o: "APPEND"`；
   - `resolveStatus` 委托给 `decideDeepSeekStreamExit`。
4. **测试覆盖**：
   - `test/providers/hooks/shared/sse.test.js`：涵盖事件提取、纯事件帧、纯数据帧与空块容错；
   - `test/providers/hooks/shared/deepseek-protocol.test.js`：涵盖 Delta 展平、路径级联、状态继承及各类终态判定。

## 4. 影响面与向后兼容

- **Claude / ChatGPT**：`shared/sse.ts` 保持既有导出签名向后兼容，不影响其它 Provider。
- **DeepSeek 历史版本兼容**：保留对旧格式 `response/status === 'FINISHED'` 的识别，同时兼容新格式 `event: finish` / `event: close`。

## 5. 验证结果

- [x] `npm run typecheck` 通过
- [x] `npm test` 通过（132 测试文件，1336 用例全部 PASS）
- [x] `npm run lint` 0 errors，67 warnings（基线持平）
- [x] `npm run compile` 重新构建 `hook-sources.ts` 与 `shell.html` 通过
- [x] 本地开发环境真机启动验证通过，无倒计时误报，正常问答生成完毕后立即平稳收尾

