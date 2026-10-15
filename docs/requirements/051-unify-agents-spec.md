---
id: 051
type: refactor
title: 统一技能/MCP/规则目录到 .agents/ 标准规范并移除旧路径回退
status: done
branch: refactor/051-unify-agents-spec
created: 2026-10-15
updated: 2026-10-15
---

## 背景

在多 AI 协同体系中，业界通用以 `.agents/` 为标准目录根规范：
1. **技能（Skills）**：标准位于 `~/.agents/skills/` 和 `<project>/.agents/skills/`（如 `npx skills add`、Antigravity、Claude Code 等生态工具）。而此前 Cuckoo Code 将技能硬编码在 `.cuckoo/skills/`，导致外部安装的技能（如 archify、superpowers、rea 等）无法自动被 Cuckoo Code 扫描并注入提示词。
2. **MCP 工具**：项目级 MCP 配置此前存放在 `<project>/.cuckoo/mcp.json`，用户级在 `~/.cuckoo/mcp.json`，与团队多工具共用 `.agents/mcp.json` 的标准脱节。
3. **规则（Rules）**：虽然此前在 036 需求中引入了 `.agents/rules/`，但用户级规则仍在 `~/.cuckoo/rules/`，且项目级代码中仍残留对 `.cuckoo/rules/` 的回退逻辑（fallback），造成路径分裂和双重维护。

用户要求：
深度分析项目缺陷，统一技能/MCP/规则路径到 `.agents/`，删除合并旧路径，不需要回退旧路径。

## 目标

1. **统一路径规范**：
   - **技能（Skills）**：
     - 项目级：`<project>/.agents/skills/<name>/SKILL.md`
     - 用户级：`~/.agents/skills/<name>/SKILL.md`
   - **MCP 工具**：
     - 项目级：`<project>/.agents/mcp.json`，本地状态 `<project>/.agents/mcp-state.json`
     - 用户级：`~/.agents/mcp.json`，状态 `~/.agents/mcp-state.json`
   - **规则（Rules）**：
     - 项目级：`<project>/.agents/rules/*.md`
     - 用户级：`~/.agents/rules/*.md`
2. **零回退（No Fallback）**：
   - 彻底删除代码中针对 `.cuckoo/skills`、`.cuckoo/rules`、`.cuckoo/mcp.json` 的 fallback 逻辑。
3. **存量迁移合并与清理**：
   - 本项目自身：将 `.cuckoo/skills/hello` 合并迁移至 `.agents/skills/hello`，删除 `.cuckoo/skills/`。
   - 用户主目录：将 `~/.cuckoo/rules/`、`~/.cuckoo/mcp.json`、`~/.cuckoo/mcp-state.json`、`~/.cuckoo/skills/` 安全合并至 `~/.agents/`，清理对应旧文件/旧目录，保留其他专有运行时数据（如 memories/snapshots/plugins）。
   - 代码中增加健壮的自动迁移逻辑（一次性无缝转移），防止旧用户或不同环境数据丢失。
4. **验证指标**：
   - `npm run typecheck`、`npm test`、`npm run lint`、`npm run compile` 全绿。
   - 所有测试用例（包括 rules, skills, mcp）更新并 100% 通过。
