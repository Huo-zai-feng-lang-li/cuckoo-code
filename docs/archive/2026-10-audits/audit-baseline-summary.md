# 审计基线（2026-10-17，项目根 D:\Desktop\Super-File\cuckoo-code）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | npm run typecheck（tsc --noEmit + tsc -p tsconfig.hooks.json） | 退出码 0，0 error |
| 单元测试 | npm test（vitest run，v5.0.1） | 100 文件 / 1012 用例全部 passed，耗时 13.78s |
| Lint | npm run lint（eslint .） | 0 error，56 warning |

## Lint 56 warning 分布（均为 no-unused-vars，非 error）
- `.cuckoo/plugins-src/ai-gateway/**`（运行时已安装插件 JS，非本次 237 自有 TS 范围）：约 30 条
- `templates/**`、`examples/**`：约 12 条
- `scripts/copy-monaco.mjs`、`start.js`：4 条
- `test/**`（observer/task-manager/plugin-*/gitee/server 等）：约 10 条

说明：基线全绿不代表无 bug；lint 只抓未用变量，不抓安全/竞态/逻辑错误。测试为 vitest，测试文件位于 test/ 下 *.test.js（100 个）。
