---
id: 088
type: fix
title: 修复格式误报（XML/JSON 工具调用误判正常讨论文本）
status: done
branch: fix/088-format-false-positive
updated: 2026-10-23
---

# 088 fix — 修复格式误报

## 问题

拦截器在检测「AI 是否输出了错误格式的工具调用」时，把**正常讨论文本里的伪代码举例**误判为真实调用，向对话发送纠正提示，打断 AI 的正常回复。

已实证的误报场景：

1. **中文引号/括号举例**：正文用中文引号包着一个对象字面量（含 tool 键）——被 JSON 检测正则命中
2. **非 cuckoo/js 代码块**：xml / ts / text 围栏里贴标签——`stripToolBlocks` 只剥离 cuckoo/javascript/js
3. **表格/全角括号内的标签**：剥离规则只认反引号与 `>` 引用行
4. **讨论本 bug 自身即触发**（自我指涉陷阱）：AI 解释该 bug 时必须引用标签原文

## 根因

`src/bridge/intercept/observer.ts`：

- `stripToolBlocks`（:74-79）只剥离 cuckoo/javascript/js 三种围栏
- `stripInlineCodeAndQuotes`（:88-95）只剥离行内反引号与行首 `>` 引用行
- 二者都不处理中文引号「」『』、中文括号（）、Markdown 表格单元格

`src/bridge/parser/json-detector.ts`（:10）：

- 匹配规则只要求「花括号 + tool/toolName + 冒号」，不校验冒号后是否为合法 JSON 值

## 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| bridge | `src/bridge/intercept/observer.ts` | `stripInlineCodeAndQuotes` 补中文引号/括号/表格行；提示移除 intent 回显；正常回复时清零计数 |
| bridge | `src/bridge/parser/json-detector.ts` | 正则收窄：冒号后必须是 JSON 值开头 |
| prompt | `src/prompt/{deepseek,claude,default}.md` | 「禁止 XML/DSML/antml」改为纯正向表述，不再点名格式 |
| test | `test/bridge/intercept/observer.test.js` | 补 9 个用例：各类举例不误报 + 真错误不放过 |

## 设计取舍

**代码围栏仍用白名单（cuckoo/javascript/js）**：初版尝试剥离所有围栏，但既有测试「stripToolBlocks 不剥离 json / python 等其他块（真错误不放过）」明确表达项目取舍——宁可误报不漏报，确保模型用错格式时能被纠正。遂回退，尊重原设计。

**保留 JSON 正则的「识别」定位**：D11 明确只识别不执行，故收窄而非删除。

**提示不回显属性串**：`intent` 是标签的原始属性（如 name="zzz"），拼进提示读不通且属原文回显，与去污染初衷不符。改为不携带 intent，只给「请改用 cuckoo 代码块」指令。

## 验证

- [x] typecheck / lint(0 errors) / compile / test(129 文件 1245 条) 全绿
- [x] 子代理审查（code-reviewer 无高危；采纳两条建议：补取舍注释、补反向锚定测试）
- [ ] 真机验证（待重启开发版实例，用户执行）
