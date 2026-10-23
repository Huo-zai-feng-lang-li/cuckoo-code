---
trigger: always_on
description: Cuckoo Code 项目规则总入口，所有任务先读本文件再按场景读取专项规则
globs: '*'
---

# Cuckoo Code 规则总入口

> 本文件是**项目规则路由**：总红线 + 专项规则索引。
> AI 每次任务先读本文件，再按命中的路径/场景读取对应的专项规则。
>
> 系统层注入机制：
> - **本文件**（无 `paths`）→ 每轮始终注入
> - **专项规则**（有 `paths` frontmatter）→ 仅当操作命中对应文件路径时注入

## 一、总红线

1. **先读文档**：开工前读 `.agents/handoff.md`（会话接续）；改代码前读本文档 + 命中的专项规则。
2. **需求流程**：新功能/行为变更/多文件改动 → 建需求档案（`docs/requirements/<id>-<slug>.md`）+ 开分支（`<type>/<id>-<slug>`）；小改动（单文件单行/纯文案）免档案。
3. **生成物禁手改**：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html` —— 改真源 + 跑 `npm run compile`。
4. **依赖方向铁律**：`infra ← providers ← tools ← bridge ← session ← app`；overlay 不依赖 bridge/session；tools 不依赖上层（用注入）。详见 `project.md`。
5. **改后验证**：`npm run typecheck` + `npm test` + `npm run lint` + `npm run compile` **全绿**；改了运行时行为（IPC/hook/工具/UI）→ 真机 `npm start` 验证。
6. **交付报告**：做了什么 / 没做什么（及原因）/ 验证结果 / 后续建议；事实结论附信心评分。
7. **精准修改**：最小影响面、单一目标；圈复杂度 < 9；拒绝巨型单文件。

## 二、专项规则索引（按 `paths` 自动注入）

| 规则文件 | 作用域 | 何时必读 |
|---|---|---|
| `project.md` | 全局（无 paths） | 所有任务：工作纪律速查（开工/改前/改时/改后/交付/提交/发版） |
| `app.md` | `src/app/**` | 主进程：窗口结构（ctx.view）、Electron 惯用法（createRequire）、加 IPC 流程 |
| `tools.md` | `src/tools/**` | D12 工具契约（apiMetas + bootstrap，名字四处一致） |
| `bridge.md` | `src/bridge/**` | preload 层：不依赖 session/app，数据经回调推送 |
| `overlay.md` | `src/overlay/**` | 覆盖层：纯 UI，回调注入 |
| `infra.md` | `src/infra/**` | 最底层：只依赖 node 内置 |
| `providers.md` | `src/providers/**` | 加平台流程 + D14 运行时校验 |
| `hooks.md` | `src/providers/hooks/**` | hook 自包含 IIFE + 打包约定 |
| `shell-ui.md` | `src/ui/shell/**` | 壳页面生成物禁改 + 样式规范 |
| `test.md` | `test/**` | 测试哲学：只写真实集成测试，优先失败路径 |

## 三、关键约定速查

- **D12 工具契约**：名字四处一致（`apiMetas.name` = `super()` 首参 = `bootstrap` 的 `__call` 首参 = `globalThis.xxx`）
- **窗口结构**：操作 AI 页面用 `ctx.view.webContents`，不是 `ctx.win.webContents`
- **加 IPC**：`src/app/ipc/<领域>.ts` 导出 `register<领域>Ipc()` → 注册到 `ipc/index.ts` → preload 暴露 → shell-api 补类型
- **发版**：CHANGELOG 用 Keep a Changelog 格式；版本号三处一致（package.json / CHANGELOG 顶部 / git tag）；**版本号禁止含数字 4（遇 4 跳过）**；tag 触发 CI

## 四、任务交付清单

- [ ] 已读 `.agents/handoff.md`（如有）和本 README
- [ ] 已读命中的专项规则
- [ ] 需求流程走完（档案 + 分支）
- [ ] typecheck + test + lint + compile 全绿
- [ ] 运行时行为已真机验证（或说明未验证原因）
- [ ] 交付报告完整（做了什么/没做什么/验证/建议）
