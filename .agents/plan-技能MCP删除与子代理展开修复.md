# 计划：技能/MCP 删除 + 子代理卡片展开修复（v0.10.230）

## 目标

1. 修复 CI（coverage / ubuntu）失败：`buildSkillsSection` 路径分隔符跨平台不一致。
2. 技能菜单、MCP 菜单补齐「删除」（与记忆/提示词/子代理菜单一致）。
3. 修复子代理任务完成后卡片点击不展开。
4. 四门禁全绿后提交并推 Tag，确保 CI + 打包成功。

## 现状取证

| 事实 | 证据 |
|---|---|
| CI 失败点为 Windows 风格路径在 Linux 上求相对路径 | `test/skills/skills.test.js:133-138`、`src/skills/prompt.ts:61-63` |
| 记忆/提示词/子代理菜单已有删除 | `memories.ts:32-34,54-63`、`snippets.ts:35-37,60-70`、`agents.ts:183,238-248` |
| 技能无删除 IPC，`list-skills` 已返回 `skillPath` | `src/app/ipc/project.ts:45-64` |
| MCP 删除固定写用户级、且全量断连 | `src/mcp/config.ts:246-257`、`src/app/entry.ts:1828-1835` |
| 子代理卡片完成即被移出运行列表；纯净模式卡片完成后自动折叠 | `src/app/subagent.ts:263,274`、`harness.html:4222-4233` |

## 改动清单

1. `src/skills/prompt.ts`：路径统一 `toPosix` + `path.posix`，去掉平台依赖。
2. `src/skills/delete-guard.ts`（新）：`isDeletableSkillDir()` 白名单校验（限用户级/项目级 skills 根、必须是根的直接子目录、必须含 SKILL.md、禁符号链接逃逸）。
3. `src/app/ipc/project.ts`：新增 `delete-skill-dir`（走 `shell.trashItem` 可恢复）、`open-skill-dir`。
4. `src/app/shell-preload.ts` + `shell-api.ts`：暴露并补类型。
5. `src/ui/shell/scripts/pages/skills.ts`：hover 操作区（打开目录 / 删除），`stopPropagation` + 点击守卫 + 二次确认。
6. `src/mcp/config.ts`：`removeServer(name, projectDir)` 按来源删（项目级优先），返回删除作用域。
7. `src/mcp/client.ts`：`disconnectServerByName()` 精确断连（`user::name` / `project:dir::name`）。
8. `src/app/entry.ts`：`remove-mcp-server` 支持 `source`，精确断连，删除失败回错误。
9. `src/ui/shell/scripts/pages/mcp.ts`：hover 操作区（打开配置 / 删除），确认框写明作用域。
10. `src/ui/shell/styles/components.css`：`.ck-mcp-item:hover .ck-agent-actions` 显示规则。
11. `src/ui/harness.html`：工具/子代理卡片点击改事件委托 + 选区守卫按 mousedown 快照，修「完成后点击不展开」。
12. `src/ui/shell/scripts/pages/agents.ts`：运行中预览双重转义修正（`textContent` 不应写入已 escape 的串）。
13. 版本号 `0.10.230`（三处一致，禁含数字 4）+ `changelogs/2026-11.md` 条目 + `docs/requirements/125-*.md`。

## 验证

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿。
- 跨平台校验：模拟 posix 下 `C:\root\w\SKILL.md` → `w/SKILL.md`。
- 删除路径白名单负例：根目录本身、越权路径、无 SKILL.md、插件技能。

## 边界

- 插件级技能不提供删除（提示卸载插件），避免破坏插件目录。
- 项目级 MCP 只在当前项目内删除，不触碰用户级同名项。
- 不动 `shell.html`（生成物），改真源后 `npm run compile` 重建。
