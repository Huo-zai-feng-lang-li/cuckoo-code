# 最新接续状态 (2026-11-12 v0.10.226 初始化提示词上下文瘦身)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`refactor/119-context-slim`（待合并 master）
> 当前版本：`0.10.226`（下一版 `0.10.227`，版本号任意位置禁含数字 4）

---

## 0. 总览

四门禁全绿（146 个测试文件、1484 个用例 100% passed，编译/类型检查/代码规范全绿）。

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| 119 初始化提示词上下文瘦身 | ✅ 已闭环（待提交） | 总省 3892 字符（-24%） |
| A 工具结果回传话术池扩充 | ✅ 已闭环（v0.10.225） | 单/多段各 18 条，recentPrefixes 容量 8 |
| B 纯净模式长暂停幽灵计时 | ✅ 已闭环（v0.10.225） | send-pause 结束分支改 stopSendTick() |

---

## 1. 本轮改动详情（需求 119）

### 1.1 技能章节路径压缩（`src/skills/prompt.ts`）

- **问题**：`buildSkillsSection` 给每条技能都输出完整绝对路径（`C:\\Users\\Administrator\\.agents\\skills\\<name>\\SKILL.md`），24 条用户级技能路径占 1632 字符。
- **改动**：
  - 按 `source`（project/user/plugin）分组，每组用 `commonRoot()` 算出公共目录，**目录前缀只声明一次**；
  - 每条只输出 `<name>/SKILL.md` 相对路径，分隔符统一转 `/`；
  - 测试同步补充 3 条断言（前缀只出现一次 / 多来源分组 / 分隔符统一）。
- **效果**：技能章节 4104 → 2633 字符（-1471），能力零损失。

### 1.2 规则去重（4 个文件）

- `.agents/rules/README.md`（2226→1899）、`project.md`（1562→1137）、`subagent-dispatch.md`（1444→1181）、`.cuckoo/CUCKOO.md`（4538→3812）。
- 删除同一纪律的多份副本（验证四件套、交付报告、开工读 handoff、需求流程），保留单一真相源。
- `subagent-dispatch.md` 删除幻觉「并发派发规范」（引用不存在的 `invoke_subagents_parallel` / `agnes-3.0-flash`），替换为真实 `runAgents` 用法。

### 1.3 技能停用（`~/.agents/skills/_disabled/`）

- `using-superpowers`、`find-skills`、`dispatching-parallel-agents`、`subagent-driven-development`（依赖不存在的 superpowers 生态）、`taste-skill`（与 `impeccable` 重叠）。
- 项目级示例 `hello` 同步移入 `.agents/skills/_disabled/`。

### 1.4 全局规则精简（项目外，需手动同步）

- `~/.agents/rules/rule.md`：2234 → 1554 字符。
- 删除「自动加载 Skills 套件」段（指向不存在的 superpowers，且与 Cuckoo 渐进式技能机制冲突）、「修改后验证要求」写死的 npm/Makefile/Cargo 三选一、「交付前自检清单」重复项。
- 原始备份：`~/.agents/rules/rule.md.bak-20261112`。

---

## 2. 关键上下文

- 根目录：`d:\Desktop\Super-File\cuckoo-code`
- 需求档案：`docs/requirements/119-context-slim.md`
- 改动前快照：`snap-1794555766748-0z5ktb`（1213 文件）
- 核心文件：
  - `src/skills/prompt.ts`：`buildSkillsSection` / `groupBySource` / `commonRoot` / `formatSkillLine`
  - `test/skills/skills.test.js`：技能章节路径压缩断言
  - `.agents/rules/{README,project,subagent-dispatch}.md`
  - `.cuckoo/CUCKOO.md`

## 3. 历史遗留待办（上一轮 handoff 转入）

- **真机验证待补（v0.10.222 修复）**：附件通道被 debugger 常驻占用导致失效的问题已代码修复，但"启用代理/指纹时附件通道恢复"需真机复验。
  - 启动：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& npx electron . --remote-debugging-port=9444`
  - 验证要点：开启代理后发一条 >4000 字符的工具回传，确认日志出现 `长文本已走附件通道` 而非 `附件通道失败，回退 insertText: debugger-busy`。
  - ⚠️ 注意：v0.10.223 已把 `shouldAttach` 改为纯文本恒返回 `false`（停用纯文本自动转附件），该验证的前提已变化，需先确认当前策略再决定验证方式。
- **附件失败静默降级**：附件失败目前静默回退 `insertText`，建议后续至少记录显式告警。

## 4. 后续建议

- `recentPrefixes` 可加容量上限测试（边界：池子被抽空时的回落路径）。
- 长暂停状态机分支较多（start/stop/自停/中止），可补"暂停中用户主动中止"回归测试。
- 全局 `rule.md` 不进项目 git，换机器需手动同步；可考虑抽成一份可版本化的模板。
- `_disabled/` 可加 `README.md` 写明每个技能的停用理由，避免以后误删。
