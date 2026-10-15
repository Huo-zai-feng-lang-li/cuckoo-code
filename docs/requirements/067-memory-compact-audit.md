---
id: 067
type: fix
title: 用户记忆稳健性 + 上下文耗尽续接智能化
status: done
branch: fix/067-memory-compact-audit
created: 2026-10-16
updated: 2026-10-16
---

## 背景

用户要求审计三个领域：记忆系统、窗口组转移、上下文耗尽自动续接。经取证，确认 **3 个真问题**（1 个初判被驳回）：

### 🔴 问题1：记忆截断方向反了（保留最早、丢最新）
`src/infra/memories.ts:135-139`：`list` 顺序是"旧→新"，`body.slice(0, MAX_SECTION_LEN)` 保留**最早**的记忆、丢弃**最新**的。
→ 用户刚记的偏好反而**不被注入**（最该生效的被丢）。

### 🔴 问题2：记忆写入非原子（崩溃即全丢）
`src/infra/memories.ts:71`：`fs.writeFileSync` 直写目标文件。若写入中途崩溃/断电 → 文件损坏 → `listMemories` JSON.parse 抛错 → 返回 `[]` → **全部记忆静默丢失**（且下次 `saveMemories` 会覆盖成空）。

### 🔴 问题3：压缩摘要生成了却被完全丢弃
`src/session/compaction.ts`：
- 段1（`runCompaction:266-270`）发摘要指令、**花 token 拿到 `summaryText`**，却只 `logStep` 打了长度，之后**完全没用**。
- 段2（`checkPendingCompact:329`）用 `pickRecentPairedIds(allMsgs, currentMessageId, 0.2)` 只取**最近 20%** 消息。
→ 新会话只有最近 20% 原文，**前 80% 的关键决策/背景全丢**，模型不知道之前发生过什么。
→ 名为"压缩"，实为"截断 + 搬家"，**既不压缩也不摘要**。

### 驳回：记忆并发丢更新
初判 `addMemory` 是 read-modify-write 有并发竞态。**证伪**：全同步 API（readFileSync/writeFileSync），主进程单线程 → 天然串行，无交错。**不改。**

## 方案

### 修复1（memories.ts）：写入原子化
`saveMemories` 改为"写临时文件 → rename 覆盖"。rename 是原子操作，崩溃时要么旧文件完整、要么新文件完整，不会半截。

### 修复2（memories.ts）：截断保留最新
`buildMemorySection` 截断时改为**保留最新的记忆**（从尾部取），丢弃最旧的。与 `MAX_MEMORIES` 的"丢弃最旧"策略一致。

### 修复3（compaction.ts）：摘要注入新会话
- 段1：把 `summaryText` 存到 localStorage（跨刷新）。
- 段3（`checkPendingInit`）：读取摘要，作为 `extraPrompt` 传给 `initProject`。
- 摘要长度限制（防 prompt 膨胀）。
- 提示措辞："这是上一段对话的摘要，请基于它无缝续接"。

## 验证

- 补/更新单测（memories 原子写、截断方向）
- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核（重点：摘要注入不破坏压缩流程、不引入新问题）
- 真机：压缩后续接更完整

## 风险

- 修复3 改压缩流程，需确保：摘要存在时不冲突现有 `isCompaction` 的"请继续"提示；摘要过长有上限。
- 修复1/2 纯 `memories.ts` 内部，无外部影响。

## 审计意见处理（子代理审计，3 个真问题全修 + 3 项建议）

- **🔴 无必须改项**。
- **🟡-1（Windows rename 覆盖被占用文件 EPERM）**：真问题（本次引入的新失败路径）。采纳：rename 失败时降级为就地覆盖。
- **🟡-2（注释宣称防断电但未 fsync）**：采纳，注释收窄为"防进程崩溃"。
- **🟡-3（压缩中途失败残留摘要 key）**：采纳，段2 失败时清 key。
- **🔵 单条超限边界 / len 多算 1 / 提示冗余**：不改（防御性无害 / 偏保守 / 不影响功能）。

## 证伪记录

- 初判"记忆并发丢更新" → **驳回**：全同步 API + 主进程单线程，天然串行，无竞态。
- 子代理验证：renameSync 在 Windows 能覆盖（Node 用 MOVEFILE_REPLACE_EXISTING）；tmp 名无并发冲突；截断顺序正确；localStorage 同源（chat.deepseek.com）；extraPrompt 注入路径与子代理一致。

## 窗口组转移审计澄清（重要：此前措辞不准确，此处更正）

**结论：窗口组转移的完整性无需修改。** 此前把它列为"分支历史丢失"问题是**措辞不准确**，特此澄清：

### 实际迁移内容（`harness.html:exportHarnessState()` 3736 行）
- `history` —— 完整可见对话
- `sendQueue` —— 待发队列
- `goal` / `goalNoProgress` —— 目标
- `planState` / `planTodos` —— 计划

**即：队列、目标、计划、最新对话——全都在迁移，无遗漏。**

### "不迁分支"是正确设计，不是缺陷
- 窗口组切换的分享取 `pickRecentPairedIds(allMsgs, currentMessageId, 1.0)`（`compaction.ts:564`）：`ratio=1.0` = **全量**，沿 `parent_id` 从**当前叶子**回溯 → 得到**最新主对话线**。
- "重新生成 / 编辑"产生的**废弃分支**（旧答案）本就**不该**给模型看——它只会污染上下文、造成角色序列错乱。
- 且这是 DeepSeek 分享 API 的**硬约束**：`share/create` 要求消息 USER/ASSISTANT 成对，分支会破坏配对 → 直接报 `MESSAGES_MUST_APPEAR_IN_PAIRS`。故 `pickRecentPairedIds` 刻意沿 `parent_id` 回溯，是**正确实现**。

### 修正后的结论
- 窗口组转移**没有需要修的完整性问题**（v0.8.95 已闭环）。
- 之前"分支历史丢失"的表述，准确说法是："分支是废弃版本，本就不该迁移——丢掉是正确行为。"
