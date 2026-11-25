# 最新接续状态 (2026-11-24 11:50)

> 当前分支 `master`，版本 `0.10.250`。本轮提交后合并到 `master` 并打 tag `v0.10.250` 推送；版本号任意位置禁含数字 4。

## 核心进展

- 0.10.250 四项改动已完成并通过全量验证：① Claude / ChatGPT 网页平台物理移除；② API 会话菜单改为左侧入口，默认收起，`Ctrl+B` 展开/收起，`Ctrl+N` 新对话，去掉会话项左侧蓝边；③ API 窗口项目目录持久化，启动/切换会话自动恢复，不再每次显示“未选择”；④ API 编辑旧消息先截断主进程上下文再发送，避免“编辑变追加”。
- 文档已同步：README、根 CHANGELOG、`changelogs/2026-11.md`、`docs/architecture.md`、`docs/arch/01-structure.md`、`docs/arch/04-runtime.md`、`docs/arch/05-tasks.md`、`docs/backlog.md`、`docs/prompts/write-missing-tests.md`；补充了 API 模式运行时、项目目录持久化、编辑上下文截断、`api-transport` 目录职责、加新平台的接入判断。
- 架构结论已落文档：新平台有官方 API 走 API 模式；只有网页才做 Web Provider + hook；Provider 单独不够，自动回复采集依赖 hook；API 模式只兼容 OpenAI 风格协议，非兼容协议要加 adapter。

## 核心动机与背景 (Motivation & Background)

- v0.10.238 自动更新后启动即崩 `Cannot find module 'sharp'`：`sharp` 在 `devDependencies`，打包未带入；`attachments.ts` 顶层 `require('sharp')` 导致主进程加载即失败。v0.10.239 已修复并发布；0.10.250 继续沿用该修复。
- 用户明确要求删除 Claude / ChatGPT，只保留 DeepSeek 网页、API Key / OpenAI 兼容、自定义 Provider；接受旧 Claude / ChatGPT 窗口以后打不开，前提是不影响 DeepSeek 与 API 原有功能。
- API 窗口 UI 调整：顶部“会话”入口移到左侧；菜单默认收起；历史会话每条左侧蓝色边框去掉；确认 `Ctrl+B`、`Ctrl+N` 无冲突后应用。
- 用户确认 API 会话菜单只在 API 模式展示；网页模式仍走壳层「对话」页面（DOM 抓取网页会话），两条链路独立。

## 关键设计与实现 (Implementation & Decisions)

### 0F 移除 Claude / ChatGPT

- `src/providers/registry.ts` 只加载 `deepseek` + `apiTransportProvider`；`entry.ts` 去掉 `isSelectableProvider` / `selectable`；平台选择页直接展示 registry 返回列表。
- 删除 `src/providers/claude.ts`、`chatgpt.ts`、`src/providers/hooks/claude.ts`、`chatgpt.ts`、`shared/claude-status.ts`、`src/prompt/claude.md`、`chatgpt.md`、`src/ui/logos/claude.svg`、`chatgpt.svg`、`test/providers/hooks/shared/claude-status.test.js`。
- `scripts/build-hooks.mjs` 只保留 DeepSeek；`src/providers/generated/hook-sources.ts` 重新生成，仅 `DEEPSEEK_HOOK`。
- `src/ui/shell/scripts/pages/windows.ts` 的 `PROVIDER_COLORS` 改为 `deepseek` + `api-key`。
- 打包注意：`tsc` 不清理已删除源文件的旧 `out/*.js`；本次已手动删 `out/src/providers/claude.js`、`chatgpt.js` 及其 `.map` 后重新 compile / electron-builder。`app.asar` 已确认不再含 Claude / ChatGPT provider 文件。

### 0G API 会话菜单

- `btn-api-sessions` 从顶栏右侧移到顶栏最左侧、品牌之前，带侧栏图标和“会话”文字。
- 菜单默认收起；点击入口或 `Ctrl+B` 展开/收起；再按 `Ctrl+B` 或 `Esc` 收起。
- `Ctrl+B` 只在 API 模式（`apiTransportMode`）生效，调用 `setApiSessionMenuOpen(!apiSessionMenuOpen)`，并 `preventDefault` / `stopPropagation`；全仓无其他 Ctrl+B 绑定。
- `Ctrl+N` 沿用既有 `CmdOrCtrl+N` accelerator 与 harness/AI 页面 `before-input-event` 转发；API 模式最终走 `web-new-conversation` → `startNewApiSession`，无新增冲突。
- `.api-session-row.active` 的 `box-shadow: inset 2px 0 0 var(--accent)` 已删除，只保留浅色激活底。
- `body:not(.ck-api-mode) #btn-api-sessions { display:none!important }`；`ck-api-mode` 只在 `providerId === 'api-key'` 时设置。

### 0H API 项目目录持久化

- 根因：API 模式加载 `about:blank#cuckoo-api` 占位页，没有网页 URL 会话 ID，`session/store.ts` 的 `handleUrlChange()` 无法恢复 `selectedProjectDir`；API 会话快照原本没有 `projectDir`，所以每次窗口创建都是 `null`，首屏判定 `needInit: true`。
- `src/api-transport/session-store.ts`：`ApiSessionMeta` / `ApiSessionSnapshot` / `SaveApiSessionOptions` 增加 `projectDir`；新增 `getApiSessionProjectDir()` / `setApiSessionProjectDir()`；新建会话接受 `projectDir`，保存消息时未显式传目录则保留已有目录；旧索引按 `null` 兼容。
- `src/api-transport/runtime.ts`：`SessionState` 增加 `projectDir`；`persist()` 同步当前窗口目录；新建会话继承当前目录；切换/删除 active 会话时恢复目标目录并 `setApiSessionProjectDir()`；新增 `project-dir` harness 事件，壳页面同步 `shell-project-dir`。
- `src/app/entry.ts`：新增 `restoreApiProjectDir()`，API 窗口启动优先取 active API 会话目录，老会话无目录时回退全局 `last-project-dir.json`，且必须 `statSync().isDirectory()` 仍存在；恢复后回写当前 API 会话。
- `src/app/ipc/harness.ts` / `src/app/ipc/project.ts`：`initProject` 成功后把目录写入 active API 会话。
- `src/session/project-context.ts`：导出 `readLastProjectDir()` 供启动恢复使用。
- `src/ui/harness.html`：监听 `project-dir` 事件，重新拉取 `getState()` 决定首屏是否显示“首次对话需选择项目目录”。

### 0I API 编辑旧消息上下文截断

- 根因：`doTruncate()` / `doSubmitLatest()` 在 API 模式只改 DOM 与 localStorage；主进程 `api-transport/runtime.ts` 的 `st.messages` 没动，`sendApiMessage()` 继续在旧 user 后追加新 user，模型自然还能看到旧提问。
- `runtime.ts`：新增 `truncateApiHistory(ctx, userIndexFromEnd)`，按“从末尾第 N 条 user”定位，删除目标及其后的 assistant/tool，system 保留；`persist()` 立即落盘。
- `harness-preload.ts` / `app/ipc/harness.ts`：新增 `harness-api-history-truncate` IPC。
- `src/ui/harness.html`：新增 `truncateApiContextFromHistItem()` 与 `countUsersAfterHistItem()`；`doTruncate()` / `doSubmitLatest()` 先等主进程截断成功，再截断本地历史并 `send()`；生成中直接拒绝，避免旧回答写进新上下文。
- 回归：`test/api-transport/runtime.test.js` 覆盖中间消息、找不到目标不写盘；`test/ui/harness-page.test.js` 钉住“主进程截断先于本地截断”。

### 0J API 顶栏双竖线

- 根因：API 模式隐藏网页导航后，主题按钮后的第一个 `.divider` 与“加号”前的第二个 `.divider` 之间只剩 `display:none` 的按钮，两个 1px 分隔线视觉上紧挨。
- `src/ui/shell/styles/base.css`：`body.ck-api-mode #btn-theme-toggle + .divider { display:none!important; }`，只保留靠右那一个；`src/ui/shell.html` 重新生成。
- 回归：`test/ui/shell-api-toolbar.test.js` 钉住规则与生成产物；Dev CDP 探针确认 API 模式 toolbar 只剩 x=190 一个普通 divider（win-divider 在窗口控制区之前）。

### API transport 边界

- `src/providers/types.ts` 的 `Provider` 接口包含 `useIntercept`、`getHookSource()`、选择器、URL/会话识别、停止、附件、新会话等大量可选能力；网页端生产接入不是“一个 Provider 文件”。
- DeepSeek 规模：`src/providers/deepseek.ts` 约 463 行，`src/providers/hooks/deepseek.ts` 约 647 行，另有 `scripts/build-hooks.mjs` 与生成物。
- `src/api-transport/provider.ts` 只有约 27 行占位；真正请求在 `runtime.ts`（约 673 行）、`client.ts`（约 361 行）、`tool-loop.ts`（约 145 行）。
- `config.ts` 强制 `/chat/completions`；`client.ts` 使用 `Authorization: Bearer`、SSE、`choices/delta`、`tool_calls`。Anthropic 原生、Gemini 原生等非 OpenAI 协议不能只填 Base URL，需新增 adapter。
- 当前自动回复入口是 hook 派发的 `cuckoo-ai-response` / `cuckoo-ai-stream`；只写 Provider、不写 hook，窗口能开、消息能发，但收不到回复，Agent 循环起不来。`useIntercept: false` 不是完整生产路径。

### 文档更新

- `README.md`：多平台 Provider 改为“网页平台封装差异、API 平台走 `api-transport`”；自定义 Provider 明确必须提供 hook 才能自动采集回复。
- `docs/architecture.md`：补充 API 模式不创建网页 hook，主进程 `api-transport` 直接请求上游。
- `docs/arch/01-structure.md`：新增 `src/api-transport/` 目录职责表。
- `docs/arch/04-runtime.md`：新增 `3A. API 模式（api-key）` 数据流；补充 API 会话 `projectDir` 持久化与启动恢复规则。
- `changelogs/2026-11.md`：0.10.250 增加 API 项目目录修复、API 编辑上下文截断、API 顶栏双竖线条目。
- `docs/arch/05-tasks.md`：任务 2 加新平台改为“先判断官方 API / 网页端”，补全 Provider + hook + 构建 + registry + 提示词 + 图标/颜色 + 测试 + 真机清单。
- `src/providers/custom/provider.template.js`：注释改为“自动采集回复必须 hook”，不再宣称默认 DOM 抓取可用。

## 待办事项 (Next Steps)

- [ ] 本次提交后合并到 `master`，打并推送 tag `v0.10.250`；GitHub Actions `release.yml` 负责 NSIS 安装包与 Android 构建。
- [ ] `dist/win-unpacked` 已用最新源码重新打包（含 API 项目目录、编辑上下文截断、顶栏双竖线修复），并已启动验证；`electron-builder --win --dir --config.win.icon=build/icon.ico` 成功，但尚未生成 NSIS 安装包。正式安装包由 tag 触发 CI。
- [ ] 发布前确认 `package.json` / `package-lock.json` / `android/app/build.gradle` 三处版本一致（均为 0.10.250）。
- [ ] 若要接新网页平台，按 `docs/arch/05-tasks.md` 任务 2 执行；先判断能否走官方 API，避免直接写 Provider。

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 主要文件：`src/providers/registry.ts`、`src/providers/types.ts`、`src/providers/deepseek.ts`、`src/providers/hooks/deepseek.ts`、`scripts/build-hooks.mjs`、`src/api-transport/*`、`src/ui/harness.html`、`test/ui/harness-page.test.js`
- 当前版本：`0.10.250`；`android/app/build.gradle` versionCode `10250` / versionName `0.10.250`
- 验证：全量 `168 文件 / 1672 用例` 通过；`test/ui/harness-page.test.js` 68 条通过；typecheck、lint（0 error / 75 warnings）、compile 通过；Dev 实例 CDP 探针确认启动与重启后 `needInit: false`、壳顶栏显示 `cuckoo-code`，切换老会话也回填目录并落盘；API 模式 toolbar 仅保留单个普通 divider。
- `dist/win-unpacked`：最新 0.10.250 本地打包，`app.asar` 含 API 项目目录、编辑上下文截断、顶栏单分隔线修复与最新 harness UI；`sharp` 与 `@img/sharp-win32-x64` 在 `app.asar.unpacked`；无 Claude / ChatGPT provider；已启动验证 `needInit: false`、toolbar 仅一个普通 divider。只有目录包，无 NSIS 安装包。
- 上一版 Release：`v0.10.239`，`cuckoo-code-win-v0.10.239.exe`；0.10.238 启动即崩，内置 updater 无法运行，需手动安装 0.10.239 一次
- 环境：外网代理 `http://127.0.0.1:51081`；探针脚本 `temp_probe_*.mjs` 已被 gitignore
