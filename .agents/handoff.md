# 最新接续状态 (2026-11-12 v0.10.225 回传话术池扩充与暂停计时修复)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`master`（已打 tag `v0.10.225` 并推送到远程）
> 当前版本：`0.10.225`（下一版 `0.10.226`，版本号任意位置禁含数字 4）

---

## 0. 总览

四门禁全绿（146 个测试文件、1481 个用例 100% passed，编译/类型检查/代码规范全绿）。

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| A 工具结果回传话术池扩充 + 避开近期重复 | ✅ 已闭环 | 单/多段各 18 条，recentPrefixes 容量 8 |
| B 纯净模式长暂停结束幽灵「等待发送」计时 | ✅ 已闭环 | send-pause 结束分支改 stopSendTick() |

---

## 1. 本轮改动详情

### 1.1 回传前缀反模式化（`src/overlay/chat-input.ts`）

- **问题**：工具结果回传每轮开头都是固定 5 句话随机一句（"跑完了，结果："等），几十轮后形成稳定句式，属典型机器指纹。
- **改动**：
  - `SINGLE_PREFIXES` 5 条 → 18 条；`MULTI_PREFIXES` 5 条 → 18 条。
  - 新增模块级 `recentPrefixes`（`PREFIX_MEMORY = 8`，单段/多段**共用一份**记忆）。`pickPrefix` 先从"近 8 次未用过"的池里抽，抽空回落全量池，抽中即记录。
  - 判据去冗余：删除 `current.includes('跑完了，结果')` 与 `includes('执行结果：')` 两条与 `some(startsWith)` 重复的硬编码，改为前缀列表单一真相源（扩列表时不会漏改）。
  - 副作用（有意）：残留判定从"任意位置命中"收窄为"开头命中"，不再误删用户真实输入。

### 1.2 长暂停结束幽灵计时（`src/ui/harness.html`）

- **问题**：`send-pause` 的暂停结束分支执行 `sendStartAt = Date.now()`，把计时起点重置为当前时刻。
- **为何是幽灵**：`chat-input.ts` L433 的 `else if (didLongPause)` 已把 `reactionMs` / `hesitationMs` 全部置 0，长暂停结束后消息**立刻填充并发送**，物理上不存在"等待发送"窗口。但 `renderSendTick` 会从 0 重新计秒，界面上凭空多出一段"等待发送 Ns"。
- **修复**：该分支改为 `stopSendTick()`，立即停表（同时移除 `sending` 配色类）。

---

## 2. 关键上下文

- 根目录：`d:\Desktop\Super-File\cuckoo-code`
- 核心文件：
  - `src/overlay/chat-input.ts`：`SINGLE_PREFIXES` / `MULTI_PREFIXES` / `recentPrefixes` / `pickPrefix` / `sendCombinedJsResultsToChat`
  - `src/ui/harness.html`：`send-pause` 分支、`renderSendTick` / `startSendTick` / `stopSendTick`
  - `test/overlay/chat-input.test.js`：前缀多样性 + 相邻不重复断言
  - `test/ui/harness-page.test.js`：暂停结束分支源码切片断言
- 注意：`package-lock.json` 版本字段停留在 `0.10.218`（历史发版均未同步，保持惯例）。

## 3. 历史遗留待办（上一轮 handoff 转入）

- **真机验证待补（v0.10.222 修复）**：附件通道被 debugger 常驻占用导致失效的问题已代码修复，但"启用代理/指纹时附件通道恢复"需真机复验。
  - 启动：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& npx electron . --remote-debugging-port=9444`
  - 验证要点：开启代理后发一条 >4000 字符的工具回传，确认日志出现 `长文本已走附件通道` 而非 `附件通道失败，回退 insertText: debugger-busy`。
  - ⚠️ 注意：v0.10.223 已把 `shouldAttach` 改为纯文本恒返回 `false`（停用纯文本自动转附件），该验证的前提已变化，需先确认当前策略再决定验证方式。
- **附件失败静默降级**：附件失败目前静默回退 `insertText`，建议后续至少记录显式告警。

## 4. 后续建议

- 可考虑给 `recentPrefixes` 加容量上限测试（边界：池子被抽空时的回落路径）。
- 长暂停相关的状态机分支较多（start/stop/自停/中止），可考虑补一条"暂停中用户主动中止"的回归测试。
