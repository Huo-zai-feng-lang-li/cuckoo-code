---
name: project
---

# Cuckoo Code 工作规则（项目特有）

> 通用工作纪律（取证、前置校验、自检、验证、沟通）见全局规则；本文只写**本项目特有**约定。
> 技术分层规则见同目录其它 `.md`（按 `paths` 注入）；架构与构建见 `.cuckoo/CUCKOO.md`。

## 开工前

- **先读 `.agents/handoff.md`**：会话接续状态、上次进展、未完成事项；以本地源码为准。
- 有疑问先问，禁止猜测；指令模糊立即暂停澄清。

## 需求流程

- 新功能 / 行为变更 / 多文件改动 → 建需求档案 `docs/requirements/<id>-<slug>.md` + 分支 `<type>/<id>-<slug>`。
- 小改动（单文件单行 / 纯文案）→ 免档案，直接改。
- 改需求文档后跑 `npm run docs:index`（INDEX 自动更新，pre-commit 钩子也会跑）。

## 生成物禁手改

- `*.generated.ts`、`src/tools/api.d.ts`、`src/tools/runtime/bootstrap.generated.ts`、`src/ui/shell.html`
- 一律改真源 + `npm run compile`。

## 提交纪律

- 工作区常混有多条功能线 → 提交前**分离无关改动**，别一把梭。

## 发版纪律

- **CHANGELOG 按发布月份归档**：完整历史在 `changelogs/YYYY-MM.md`（唯一真相源），根 `CHANGELOG.md` 只保留索引表 + 最近 5 版。
  - 发版时把新版本条目**追加到当月文件顶部**（看当天日期，无需决策轮转）；
  - 同步在根文件「最近 5 个版本」区更新，并维护索引表版本区间/版本数；
  - 查找历史版本用 `node scripts/changelog-locate.mjs <version>`，**不要**读根文件或全量检索。
- **内容粒度**：只写用户可感知的变更（功能、行为变化、性能、安全、依赖升级）；不写内部验证过程、重构细节、测试补丁、临时调试。单版本条目建议 ≤ 15 行，超出说明该拆版本。
- **分类只用 Keep a Changelog 标准六类**：`Added / Changed / Fixed / Removed / Performance / Security`，禁止自造分类与中英混用。
- 版本号三处一致：`package.json` / 当月 `changelogs/YYYY-MM.md` 顶部 / git tag（`vX.Y.Z`）。
- **版本号禁止含数字 4**（任意位置任一段）：`0.10.48` 之后为 `0.10.50`，`0.10.39` 之后直接 `0.10.50`。三处同步跳过。
- CI 已配好（`.github/workflows/release.yml`）：push tag（`v*`）→ 自动构建 Win+Mac → 创建 Release。

## 环境

- 外网代理：`http://127.0.0.1:51081`
- 任务结束 / 异常退出：关闭本次启动的服务进程（Electron、MCP 等）释放内存；需保留测试须显式告知。
