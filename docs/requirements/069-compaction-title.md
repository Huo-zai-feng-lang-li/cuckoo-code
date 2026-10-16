---
id: 069
type: feature
title: 压缩续接会话继承/生成标题（消除工作区 UUID 显示）
status: done
branch: feat/069-compaction-title
created: 2026-10-16
updated: 2026-10-16
---

# 069 — 压缩续接会话继承/生成标题（消除工作区 UUID 显示）

## 背景

工作区列表渲染规则（`src/ui/shell/scripts/pages/workspaces.ts:81`）：
```js
const label = (s.kind === 'subagent' && s.agentName) ? ('子代理: ' + s.agentName) : (s.title || s.sessionId);
```
`title` 为 null 时回退显示 sessionId（一串 UUID）。

真机取证（打包版 `session-dir-map-profile-...-j61vr4.json`）证实：
**所有显示 UUID 的会话 title 全为 null，且 kind 全为 `compaction`（压缩产物）。**
其父会话（如"打招呼"、"介绍自身能力"）均有标题。

两层根因：
1. **血缘写入不继承标题**：`src/session/store.ts` 的 `setSessionLineage` 新建条目时 `title` 硬编码为 `null`，只写 parentId/kind/agentName，不读父会话标题。
2. **命名提示词不覆盖压缩场景**：系统提示词只要求 AI 在"首条用户消息"时调 `nameConversation`；压缩后新会话 AI 先收到的是系统注入的摘要（extraPrompt），不是用户消息 → 不会主动命名。

## 目标

压缩产生的续接会话不再显示 UUID，而是继承父标题或由 AI 生成贴合内容的新标题。

## 方案（A+B）

### A. 继承父标题（兜底，立即生效）
`setSessionLineage` 写 `kind==='compaction'` 血缘时，若本会话尚无标题、父会话有标题，则复制父标题。

### B. 压缩时 AI 生成标题（贴合内容）
- 段1 摘要指令追加要求：在最开头单独一行输出 `【标题】xxx`（≤20 字），再输出摘要正文。
- 段3 `checkPendingInit` 解析该标题行：取出标题（从摘要正文中剔除），调用新增 IPC `set-pending-session-title` 走 `setSessionTitle` 暂存逻辑，待新会话 ID 出现时绑定。
- 解析失败则退化为方案 A 继承的父标题。

优先级：方案 B 生成的标题在会话 ID 出现时绑定（pendingTitle 在 pendingLineage 之后处理），会覆盖方案 A 继承的标题。

## 改动文件
- `src/session/store.ts`：setSessionLineage 继承父标题
- `src/session/compaction.ts`：摘要指令 + 段3解析 + 调 IPC
- `src/app/ipc/session.ts`：新增 `set-pending-session-title` handler
- `src/bridge/api.ts`：暴露 `setPendingSessionTitle`

## 验收
- 压缩后新会话标题 = AI 生成的标题（解析成功）或父标题（兜底），不再显示 UUID
- 摘要正文不含标题行（不污染 extraPrompt）
- typecheck / test / lint / compile 全绿
- 真机验证：压缩后工作区列表新会话显示中文标题

## 审查修复（子代理审查 + 主代理审计）

1. **parseSummaryTitle 正则跨行 bug**：`\s*` 含换行，导致标题为空时把正文首行误当标题。改为先剥离前导空白、按首行精确匹配，且无论标题是否为空都剥离标签行（防污染 extraPrompt）。
2. **setPendingSessionTitle 时序脆弱点**：原走 `setSessionTitle` 会检查 `currentSessionId`，若分享页加载时 currentSessionId 仍指向父会话，标题会误写到父会话。新增 `forceStage` 参数强制暂存（压缩续接专用）。
3. **段2 失败未清 COMPACT_TITLE_KEY**：补齐清理，与摘要清理对称。
4. **setPendingSessionTitle 未捕获 rejection**：补 `.catch()`，避免 unhandled rejection。
5. **标题截断对齐**：slice(0,30) → slice(0,20)，与提示词要求一致。

## 验证
- 单测：`test/session/compaction.test.js` 新增 7 个 parseSummaryTitle 用例（标准/无标题/标题空/仅标题/超长/空白/空串），全绿
- typecheck / test(988) / lint(0 error) / compile 全绿
- 真机（dev 9444）：`setPendingSessionTitle` 返回 `{success:true, pending:true}`（forceStage 强制暂存生效）

## 待真机确认（需触发完整压缩流程）
- 压缩后新会话是否显示 AI 生成的标题（或兜底父标题）
