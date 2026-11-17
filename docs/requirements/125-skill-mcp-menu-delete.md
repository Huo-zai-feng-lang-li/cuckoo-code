# 125 技能/MCP 菜单删除与子代理卡片展开修复

- 状态：done
- 分支：master
- 日期：2026-11-17
- 版本：0.10.230

## 背景

1. 记忆 / 提示词 / 子代理菜单每张卡片悬停都有「编辑 / 删除」，技能与 MCP 菜单没有，用户感知为功能缺失。
2. 子代理任务完成后，纯净模式里的卡片自动折叠，点击却不再展开。
3. CI（coverage / ubuntu）长期红：`buildSkillsSection: 路径分隔符统一为 /` 失败。

## 根因

- **技能菜单**：`list-skills` 已返回 `skillPath`，但没有删除 IPC，UI 也就没做操作区。
- **MCP 菜单**：`remove-mcp-server` 固定写用户级（`config.ts` 旧实现注释自认「项目级同名的由用户手动处理」），并且 `disconnectAll()` 全量断连。直接加按钮会导致「项目级行删到用户级同名项」+ 掐断其它项目正在用的连接。
- **子代理卡片**：卡片点击靠逐卡 `addEventListener`，历史恢复 / 动态补卡路径容易漏绑；且点击守卫用「当前有没有选区」判断，而标题行 `user-select:none` 的点击不会清掉别处旧选区，导致后续点击被静默吞掉。
- **CI**：`buildSkillsSection` 用平台相关的 `path.dirname/relative` 处理路径，Linux 上把 `C:\root\w\SKILL.md` 当作单段文件名，输出原样反斜杠路径。

## 改动

| 文件 | 内容 |
|---|---|
| `src/skills/prompt.ts` | 路径统一 `toPosix` + `path.posix`，去除平台依赖 |
| `src/skills/delete-guard.ts`（新增） | 删除白名单：必须在技能根的直接子目录、含 SKILL.md、非符号链接 |
| `src/app/ipc/project.ts` | 新增 `delete-skill-dir`（`shell.trashItem` 回收站）、`open-skill-dir` |
| `src/mcp/config.ts` | `removeServer(name, projectDir)` 按来源删除，返回实际作用域 |
| `src/mcp/client.ts` | 新增 `disconnectServerByName`，只断单个 server |
| `src/app/entry.ts` | `remove-mcp-server` 支持 `source`，精确断连；新增 `open-mcp-config` |
| `src/app/shell-preload.ts` / `shell-api.ts` | 暴露并补类型 |
| `src/ui/shell/scripts/pages/skills.ts` / `mcp.ts` | 悬停操作区 + 二次确认（写明作用域） |
| `src/ui/shell/styles/components.css` | MCP 卡片悬停显示操作区 |
| `src/ui/harness.html` | 工具/子代理卡片改 `#stream` 事件委托 + 选区按 mousedown 快照 |
| `src/ui/shell/scripts/pages/agents.ts` | 运行中预览去二次转义；选区守卫同款修复 |
| `test/skills/delete-guard.test.js`（新增） | 9 条白名单用例（越权 / 根目录 / 深一层 / 缺 SKILL.md / 软链入口） |

## 边界

- 插件级技能不提供删除（提示到插件页卸载），避免破坏插件目录。
- 技能删除只进回收站，不 `rm -rf`；没有回收站的环境（部分 Linux）直接报错，不降级为永久删除。
- 用户级 MCP 删除会影响所有项目，确认框明确提示；项目级只删当前项目配置。

## 验证

- `npm run typecheck` / `npm run lint` / `npm test` / `npm run compile` 全绿。
- 新增 9 条删除白名单用例，全部通过。
- 跨平台：`prompt.ts` 中已无平台相关路径 API（`grep path.` 仅剩 `path.posix.*`）。
