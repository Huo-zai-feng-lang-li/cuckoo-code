---
id: 119
type: refactor
title: 初始化提示词上下文瘦身（规则去重 + 技能路径压缩）
status: doing
branch: refactor/119-context-slim
created: 2026-11-12
updated: 2026-11-12
---

# 119：初始化提示词上下文瘦身

> 状态：**doing**
> 分支：\`refactor/119-context-slim\`

## 一、用户原始目标与痛点

1. 每次新对话初始化时，系统提示词里的规则/技能区块过长，占用大量上下文（每轮复利成本）。
2. 希望在不降低模型能力（不降智）的前提下压缩。

## 二、根因分析

### 2.1 同一批纪律被抄了三份（项目内）

| 约束 | 出现位置 |
|---|---|
| 改后验证四件套 | 全局 rule.md / rules/README 红线5 / rules/project.md / CUCKOO.md 七 |
| 交付报告+自检 | 全局 rule.md / rules/README 红线6 / rules/project.md / CUCKOO.md 九 |
| 开工读 handoff | 全局 rule.md / rules/README 红线1 / rules/project.md / CUCKOO.md 五 |
| 需求档案+分支 | rules/README 红线2 / CUCKOO.md 八 |
| 依赖方向 | CUCKOO.md 四 / rules/README 红线4 |

### 2.2 全局 rule.md 含幻觉/过时内容（对所有项目生效）

- 「自动加载 Skills 套件」段：要求每次改码前扫 \`C:\\Users\\Administrator\\.agents\\skills\\\`，点名 **superpowers——该技能不存在**；与 Cuckoo 渐进式技能机制冲突，属主动误导。
- 「修改后验证要求」写死 npm/Makefile/Cargo 三选一，对其他语言项目是噪声（应由各项目规则/package.json 决定）。
- 「交付前自检清单」与项目 project.md 重复。

### 2.3 subagent-dispatch.md 含幻觉段落

「并发派发规范」引用 \`invoke_subagents_parallel\` MCP 工具与 \`agnes-3.0-flash\` 模型——本项目无此工具/模型，会诱导模型调用不存在的接口。

### 2.4 技能章节 43% 是重复绝对路径

\`buildSkillsSection\` 给每条技能都写完整绝对路径（如 \`C:\\Users\\Administrator\\.agents\\skills\\a-handoff\\SKILL.md\`），24 条技能合计 1632 字符。可改为目录前缀声明一次 + 每条只写 \`<name>/SKILL.md\`。

### 2.5 无效/冲突技能占用列表

\`using-superpowers\`、\`find-skills\`、\`dispatching-parallel-agents\`、\`subagent-driven-development\` 依赖不存在的 superpowers 生态；\`hello\` 为示例；\`taste-skill\` 与 impeccable 定位重叠。

## 三、方案

**原则：只删重复副本、幻觉、过时描述，不删任何约束语义；保留全部反例/事故记录。**

### P0 规则去重
1. 全局 \`~/.agents/rules/rule.md\`：删「自动加载 Skills 套件」段；「修改后验证要求」「交付前自检清单」「持久上下文规范中重复条款」压缩为指针/删除。
2. 项目 \`rules/subagent-dispatch.md\`：删「并发派发规范」整段，保留三要素 + 事故反例。
3. 项目 \`rules/project.md\`：删与全局 rule.md 重复的通用条款，保留项目特有（需求流程/生成物/D12/提交/发版/环境）。
4. 项目 \`CUCKOO.md\`：任务纪律、构建验证改为指针（指向 rules），保留技术栈/目录/依赖/常见任务。

### P1 技能瘦身
5. \`src/skills/prompt.ts\`：目录前缀声明一次，每条只写相对路径；同步更新测试。
6. 无效/冲突技能移入 \`~/.agents/skills/_disabled/\`（可回滚），扫描器天然跳过（无直接子目录 SKILL.md）。

### 不动的部分
- 工具 API d.ts（D12 契约，模型正确调工具依赖它）
- 技能正文 SKILL.md（渐进式披露，本就不进上下文）
- 专项规则 \`paths\` 路由（按需注入）

## 四、实施结果

| 文件 | 改前 | 改后 | 节省 |
|---|---|---|---|
| 全局 `~/.agents/rules/rule.md` | 2234 | 1554 | 680 |
| `.agents/rules/README.md` | 2226 | 1899 | 327 |
| `.agents/rules/project.md` | 1562 | 1137 | 425 |
| `.agents/rules/subagent-dispatch.md` | 1444 | 1181 | 263 |
| `.cuckoo/CUCKOO.md` | 4538 | 3812 | 726 |
| 技能章节（25 条 → 19 条 + 路径压缩） | 4104 | 2633 | 1471 |
| **合计** | **16108** | **12216** | **3892** |

- 真实 `buildPrompt` 实测：系统提示词总长 38025 字符，技能章节 2633，项目介绍 3824。
- 停用技能（移入 `_disabled/`，可回滚）：`using-superpowers`、`find-skills`、`dispatching-parallel-agents`、`subagent-driven-development`、`taste-skill`；项目级 `hello` 同样停用。
- 全局 `rule.md` 原始备份：`~/.agents/rules/rule.md.bak-20261112`（在项目快照外，单独备份）。

## 五、验证

- `npm run typecheck` 全绿
- `npm test`：146 个测试文件 / 1484 个用例 100% 通过
- `npm run lint`：0 errors（73 条既有 warning，与本次改动无关）
- `npm run compile` 成功（生成物已重出）
- 真实 `buildPrompt` 实测提示词字符数已下降（见上表）
