# 最新接续状态 (2026-10-12 14:06)

## 核心进展
- **v0.8.13 已发版**：tag `v0.8.13`（commit `9791fc5`）已 push，CI 自动构建 Win+Mac Release（`.github/workflows/release.yml`）。HEAD 已与 origin/master 同步。
- 本会话完成：纯净模式发送队列/导航、全局自定义 Tooltip、项目文件可编辑、工作区删除、停止双向同步、多轮 tooltip 修复、性能优化、CHANGELOG 补写 + 发版规则。

## 核心动机与背景 (Motivation & Background)
- **纯净模式体验**：busy 时发消息被丢弃 → 加发送队列；长对话难定位 → 加右侧导航。
- **Tooltip 统一**：原生 title 丑（系统黄框）→ 全局自定义引擎接管；后按反馈收敛规则：**仅"图标型按钮(≤2字)"或"内容被溢出裁剪"时才弹**。
- **项目文件只读**：用户要能编辑保存 → 加写入 IPC + 未保存拦截。
- **停止不同步**：网页模式点停止，纯净模式卡"运行中" → 加 `onUserStop` 事件同步。
- **性能**：滚动高亮 O(N) reflow、tooltip isClipped 重复遍历 → 审计优化。

## 关键设计与实现 (Implementation & Decisions)
- **发送队列**：`harness.html` — `sendQueue`/`tryEnqueue`/`maybeFlushQueue`；busy 入队、空闲自动发；编辑/删除**锁对象引用**(防 flush 移队首后 idx 错位)；goal/plan 不入队。
- **对话导航**：`updateConvNav`（横线+悬停展开）、`fastScrollTo`(180ms 令牌防连点)、`textOverflowsPanel`(复用探针测宽)、`updateConvNavActive`(rAF 节流)。
- **自定义 Tooltip**：三处实现（`src/ui/shell/scripts/tooltip.ts` + `harness.html` + `platform-select.html` 内联）；`handlePointerOver` 拦截 `[title]→data-ck-title`，`isIconLike||isClipped` 判定；延迟 120ms/20ms(warm)。
- **项目文件可编辑**：主进程 `write-project-file`(原子写入: 临时文件+rename, 防目录穿越) + `preview.ts`(dirty 标记/Ctrl+S/未保存拦截)。
- **停止同步**：`observer.ts` 加 `onUserStop` 监听器 → `harness-bridge.ts` 订阅 → `task-idle` 收尾。反向(纯净→网页)走 `harness-stop` IPC 点网页停止按钮(best-effort)。
- **发版规则**：`.cuckoo/rules/project.md` 新增「发版纪律」：打 tag 前必汇总上次 tag 后提交写 CHANGELOG。

## 待办事项 (Next Steps)
- [ ] **真机验收 v0.8.13**（主进程改动需重启）：① 网页点停止→纯净模式应"就绪" ② 纯净点停止→网页应停 ③ 项目文件编辑/Ctrl+S/未保存拦截 ④ 工作区删除 ⑤ tooltip 各场景
- [ ] 确认 GitHub Actions CI 构建成功（fork 权限）
- [ ] 遗留 3 项（backup/pre-ff 有、master 无）：子进程树 taskkill、IPC 白名单、删 fab.ts

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 主要文件:
  - `src/ui/harness.html`（纯净模式，手写源，含队列/导航/tooltip 内联）
  - `src/ui/shell/scripts/tooltip.ts`、`preview.ts`、`preview-monaco.ts`、`pages/workspaces.ts`
  - `src/app/ipc/session.ts`（read/write-project-file + delete-session/workspace）
  - `src/bridge/intercept/observer.ts`、`harness-bridge.ts`（停止同步）
  - `CHANGELOG.md`、`.cuckoo/rules/project.md`
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- CDP 调试：Electron `--remote-debugging-port=9333`（`/json` 列 target）
- 规则: 全局 `~/.cuckoo/rules/`；项目 `.cuckoo/rules/`
- 用户偏好: **改完代码不主动 commit/push**，等明确指示才提交
