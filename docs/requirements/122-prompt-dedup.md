---
id: 122
type: refactor
title: 系统提示词工具段去重（api.d.ts JSDoc 压缩 + 删除 TOOLS_LIST）
status: done
branch: refactor/122-prompt-dedup
created: 2026-11-16
updated: 2026-11-16
---

# 需求 122：系统提示词工具段去重

## 1. 背景

新建对话的系统提示词约 41KB（13–15K token），其中工具说明存在**三重重复**：

| 段 | 字符 | 内容 |
|---|---|---|
| `api.d.ts`（TOOL_API_TYPES） | 11,972 | 27 个函数签名 + 完整 JSDoc（约 72% 是注释格式） |
| `TOOL_SECTIONS` | 3,547 | 24 条工具用法要点（策略层） |
| `TOOLS_LIST` | 2,510 | 27 条「n. 签名 — 一句话」，与 api.d.ts 签名 100% 重复 |

工具段合计 18,029 字符，占首屏提示词约 44%。

## 2. 目标

消除工具说明的三重重复，**只优化「恒定成本」**（工具契约，与项目无关），不动「动态成本」（项目规则/介绍/技能/记忆）。工具调用能力零损失。

## 3. 关键事实（取证）

- 开发期 `resolveToolSpec()` 返回 `src/tools/api.d.ts`；打包期返回 `resources/tools/cuckoo-tools.d.ts`（构建时从同一文件复制）。压缩 `api.d.ts` 即压缩注入内容。
- `getFormattedJsApiForPrompt` 仅被 `src/session/prompt-builder.ts` 调用（另有 `ToolRegistry.ts` 定义、测试与 backlog 文档引用，不阻塞）。
- 模板实际占位符：`deepseek.md` / `default.md` / `claude.md` 有 `{{TOOLS_LIST}}`；**`chatgpt.md` 无**（仅 `{{TOOL_SECTIONS}}`）。
- `api.d.ts` 实测 11,972 字符 / 436 行 / 67 个 JSDoc 块。

## 4. 改动清单

### 4.1 删除 TOOLS_LIST（零风险）

- `src/session/prompt-builder.ts`：删 `getFormattedJsApiForPrompt()` 调用与 `{{TOOLS_LIST}}` 占位符。
- 模板 `deepseek.md` / `default.md` / `claude.md`：删除「可用工具函数」章节（标题 + 占位符 + 悬空注释）；`chatgpt.md` 不动。
- `ToolRegistry.getFormattedJsApiForPrompt()` **保留**（测试直接覆盖，插件可能复用）。

### 4.2 压缩 api.d.ts 的 JSDoc 格式（语义零删）

真源：`scripts/build-tool-api.mjs` 的 `render()`。

- 多行 doc 空白折叠为一行；
- **所有 JSDoc 一律压成单行** `/** xxx */`；
- `doc` / `paramDocs` / `returnsDoc` / `throws` 文本一字不改；
- 文件头「使用规则速览」、`types` interface 块、分类标题保留。

> 注：早期估算压到 8,500 过于乐观。实际 JSDoc 开销多为单行注释（本就单行，压不动），实得 11,489。

## 5. 不动的部分

- `TOOL_SECTIONS`（策略层，api.d.ts 没有）
- `@throws` / `paramDocs` 非显然语义
- 技能描述、项目规则、CUCKOO.md、用户记忆、MCP 章节
- 项目级技能/代理（新项目注入它自己的，属预期）

## 6. 为什么换项目不降质

1. 优化对象是工具契约（恒定成本），语义零删，换任何项目工具调用能力一致。
2. 腾出的空间抵消新项目规则增长，总占用与当前持平。
3. 动态部分是「替换」不是「叠加」，不存在越换越大。

## 7. 验收结果

- [x] `api.d.ts` 11,972 → **11,489** 字符（行 436 → 257）
- [x] `{{TOOLS_LIST}}` 已从 prompt-builder + 3 模板移除（chatgpt 本无），全 `src` 无残留
- [x] 工具语义零损失：67 个 JSDoc 块归一化后逐块比对，**0 不一致**
- [x] 四门禁全绿：typecheck 0 错 / test 146 文件 1490 用例全过 / lint 0 error（74 既有 warning）/ compile 通过
- [x] 工具段总字符 18,029 → **15,036**（省 2,993，−16.6%）
- [x] 换项目验证（两个不同临时目录 buildPrompt）：两边均含完整 api.d.ts、项目段各自注入互不污染、无占位符残留

## 8. 结论

首屏提示词约 41KB → ~38KB。收益低于初期估算（原以为可省 5–6KB），主因是 JSDoc 开销多为单行注释、压不动。但改动零风险、语义零损失，且工具契约是恒定成本，每个新项目都受益。
