# 全量修复 · 跨层契约（冻结，各修复子 agent 必须遵守）

> 目的：Wave 1/2/3 按层并行，文件不重叠、接口不漂移。任何一方需要改本契约的接口，先回报 Organizer，禁止私自改。
> 依赖方向（铁律）：`infra ← providers ← tools ← bridge ← session ← app`；overlay 不依赖 bridge/session；mcp/plugins/skills/rules 是低层纯 node 模块，可依赖 infra，不得依赖 app。
> 运行环境：Windows + pwsh；ESM；项目根 `D:\Desktop\Super-File\cuckoo-code`；分支 `fix/security-bug-sweep`。
> 基线：typecheck 0 error、test 1012 全过、lint 0 error（56 warning）、compile 0。

## 一、文件归属（避免并行冲突，硬边界）

- **A（infra+tools）只改**：`src/infra/**`、`src/tools/**`。新建 `src/infra/atomic-json.ts`、`src/infra/host-allowlist.ts`、`src/infra/workspace-trust.ts`；扩 `src/infra/dangerous-commands.ts`；修 ssrf-guard/protected-paths/web-fetch/task-manager 等。
- **B（bridge+providers）只改**：`src/bridge/**`（含 src/bridge/intercept/**）、`src/providers/**`。**不改** `src/bridge/api.ts` 的暴露面（X-001 闸门在主进程，api.ts 保持，仅可在 :261 行加注释说明 contextIsolation 下不泄漏）。
- **C（app+session+agents）只改**：`src/app/**`、`src/session/**`、`src/agents/**`。新建 `src/app/execution-policy.ts`、`src/app/ipc-guard.ts`、`src/app/workspace-trust-prompt.ts`；改 `src/app/ipc/tool.ts`、`command.ts`、`settings.ts`、`src/app/shell-preload.ts`、`src/session/project-context.ts` 等。
- **D（plugins+mcp+remote+skills+rules+updater）只改**：`src/plugins/**`、`src/mcp/**`、`src/remote/**`、`src/skills/**`、`src/rules/**`、`src/updater/**`。
- **E（overlay+ui+scripts）只改**：`src/overlay/**`（含新建 `src/overlay/sanitizer.ts`）、`src/ui/**`（含 harness.html、shell 真源 `src/ui/shell/**`、各独立窗口 HTML、`scripts/**` 构建脚本）。**不碰** `src/app/shell-preload.ts`（新通道由 C 在 preload 暴露，E 只消费）。
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`；改真源后跑 `npm run compile`。
- 新增测试就近放 `test/`（*.test.js，vitest），命名与被测模块对应。

## 二、新 infra 模块 API（A 实现，C/D 依赖；签名冻结）

### 1. `src/infra/atomic-json.ts`（原子写，C-001/002/003 用）
- 目录解析：`CUCKOO_HOME` 覆盖，否则 `~/.cuckoo`（与 protected-paths.ts getUserDir 一致）。
- 导出：
  - `writeJsonAtomicSync(file: string, data: unknown, opts?: { keepBackup?: boolean }): boolean`
  - `writeJsonAtomic(file: string, data: unknown, opts?): Promise<boolean>`
  - `readJsonRobustSync<T>(file: string, fallback: T): T`（先读原文件；JSON 损坏则回退同名 `.bak`，再退回 fallback；不得静默吞成"空"而丢失——记录 warning）
- 实现：同目录 tmp（`.basename.<pid>.<seq>.tmp`）→ 写完整 + `fsync`（尽力，Windows 异常吞掉）→ `fsyncSync` 目录（尽力）→ `renameSync`；Windows 遇 EPERM/EBUSY/EACCES 重试 ≤10 次、每次 50ms；keepBackup 时 rename 前把旧文件存为 `.bak`。

### 2. `src/infra/dangerous-commands.ts`（扩展，保留现有 isDangerous）
- 保留 `isDangerous(cmd)`（**硬拒绝**，破坏性命令；bash.ts 现有行为不变）。
- 扩充 `DANGEROUS_CMDS` / `CMD_WRAPPERS`（修 A-004），由 PoC poc-1-dangerous-bypass.mjs 六类驱动：
  - `CMD_WRAPPERS` 增加 cmd/powershell 包装剥除：`cmd(\.exe)?\s+\/[ck]\s+`、`(?:powershell|pwsh)(\.exe)?\s+(?:-command|-c|-enc...)?` 剥到内部真实命令；`start(\s+""|\s+\/b)?`、`call`。剥除后内层 `rmdir /s`、`del /f` 等仍被现有模式命中。
  - PowerShell：`rm -r -fo`、`ri -r -fo`、`Remove-Item -Recurse`（仅 recurse 也拦）、`-Force` 变体（不再要求 recurse+force 同时）。
  - GNU rm：`rm --interactive=never` / `-I` 绕过、`rm -rf` 指向 `/c/Users`、`$HOME` 等（适当加 Git-Bash 盘符/家目录变体）。
  - 必须保证 PoC 中 4 个"正常命令不误伤"用例仍不被 isDangerous 命中。
- 新增投递/持久化/反弹特征族（**X-001 第二层，主进程弹窗**，不是硬拒绝）：
  - 导出 `findDeliverySignature(cmd: string): string | null`：命中返回中文描述（如"PowerShell 编码执行(-enc/-EncodedCommand)"），未命中 null。特征族：
    - PowerShell `-enc`/`-e`/`-EncodedCommand`（base64 编码执行）、`-w hidden`+执行、`iex`/`Invoke-Expression`（含 `iwr|iex`、`curl|iex`、`irm|iex`、`... | iex`）、`-downloadstring`/`IWR`/`Invoke-WebRequest` 后紧跟执行。
    - `certutil -urlcache`、`certutil -decode`、`bitsadmin /transfer`、`mshta http`、`wscript/cscript` 远程 .js/.vbs、`reg add ...\Run`/`\RunOnce`、写启动文件夹（`Start Menu\Programs\Startup`）、`Add-MpPreference -DisableRealtimeMonitoring`、`Set-ExecutionPolicy Bypass`。
    - 反弹 shell：`nc -e`/`ncat -e`/`bash -i >& /dev/tcp`、`python -c ...socket`（取关键强特征，避免误伤）。
  - 检测既按分段（splitShellSegments/stripWrappers）也要看**整条命令**（管道/下载→执行跨段）。逻辑拆成可单测纯函数。
- 新增测试：6 类绕过 + 4 类正常命令；投递特征族每个特征 ≥1 命中 + 普通命令（如 `npm install`、`git status`、`node server.js`）不命中。

### 3. `src/infra/host-allowlist.ts`（X-001 第一层，纯函数）
- 导出：
  - `isOwnWindowUrl(url: string): boolean`：允许 `file:`、`data:`（overlay 用 data:text/html）、`about:blank`、以及应用注册的自定义 scheme（**C 负责核对** src/app 是否 protocol.register 自定义协议；若有加入；若无法确认则 file:/data:/about: 三项）。
  - `isProviderHost(url: string, matchers: Array<(u: string) => boolean>): boolean`：任一 provider.matchesUrl 命中即 true。
  - `checkSenderUrl(url: string, matchers: Array<(u: string) => boolean>): { ok: boolean; kind: 'provider'|'own-window'|'unknown'; host?: string; reason?: string }`
- 解析 URL 失败 / 非 http(s) 又非自有协议 → unknown。

### 4. `src/infra/workspace-trust.ts`（工作区信任，纯 node；D/C 依赖）
- 信任记录文件：`~/.cuckoo/trusted-workspaces.json`（CUCKOO_HOME 覆盖），用 writeJsonAtomicSync 写。
- 结构：`{ version: 1, trusted: { [normPath]: { path: string; since: string } } }`；normPath 在 Windows 大小写不敏感（path.resolve 后 toLowerCase），其他平台精确。
- 会话级信任：模块级内存 Set（不持久化），导出 `__resetForTests()`（仅供测试，命名带 reset）。
- 导出：
  - `type TrustScope = 'trusted' | 'session' | 'untrusted'`
  - `interface WorkspaceArtifacts { dir: string; mcp: Array<{name:string; command?:string; args?:string[]; url?:string}>; rules: string[]; skills: string[] }`
  - `normalizeProjectPath(p: string): string`
  - `isWorkspaceTrusted(dir: string | null | undefined): boolean`（持久或会话）
  - `isWorkspaceTrustedPersistently(dir): boolean`
  - `setWorkspaceTrust(dir: string, scope: TrustScope): void`
  - `revokeWorkspaceTrust(dir: string): void`
  - `listTrustedWorkspaces(): Array<{ path: string; since?: string }>`
  - `clearSessionTrustForTests(): void`
  - `scanWorkspaceArtifacts(dir: string | null | undefined): WorkspaceArtifacts`
    - 检测真实路径（已核对）：MCP `<dir>/.agents/mcp.json`（mcpServers 各 name/command/args/url）；规则 `<dir>/.agents/rules/*.md`（名称）；技能 `<dir>/.agents/skills/<name>/SKILL.md`（名称）。只读元数据，不读全文。
- 测试：信任判定/撤销/会话级/大小写/扫描（用 CUCKOO_HOME + 临时目录）。

## 三、新 app 模块 API（C 实现；依赖 A 的 infra；签名冻结）

### 5. `src/app/execution-policy.ts`（X-001 第三层 + 决策纯函数）
- 策略文件：`~/.cuckoo/execution-policy.json`（`{ mode: 'smart'|'workspace'|'strict' }`，默认 `smart`），原子写。
- 导出：
  - `type ExecutionMode = 'smart'|'workspace'|'strict'`
  - `getExecutionMode(): ExecutionMode`、`setExecutionMode(m: ExecutionMode): ExecutionMode`（非法值回退 smart）
  - `READ_ONLY_TOOLS: ReadonlySet<string>`（read、read-lines、glob、grep、list/目录类、todo-write、name-conversation、goal-done、list-snapshots、mcp-list-servers、mcp-get-tools、get-dir-info、mysql 只读等，C 据实补全）
  - `WRITE_TOOLS: ReadonlySet<string>`（write、edit、delete-file、restore-snapshot、remember、forget-memory 等）
  - `COMMAND_TOOLS: ReadonlySet<string>`（bash、pwsh）
  - `interface GateInput { toolName: string; params: any; projectDir: string|null; deliveryMatched: string|null; isWorkspaceTrusted: boolean }`
  - `type GateDecision = 'allow' | 'confirm' | 'deny'`
  - `decideToolGate(i: GateInput): { decision: GateDecision; reason: string; detail?: string }`
    - 只读 → 任意模式 allow。
    - 写：smart → 项目目录内 allow、项目外 confirm（projectDir 之外路径需确认）；workspace → 受信任 allow，否则 confirm；strict → confirm。
    - bash/pwsh：**deliveryMatched 非空 → 任何模式 confirm（detail 含命中特征）**；否则 smart → allow；workspace → 受信任 allow、否则 confirm；strict → confirm。
    - execute-js（在 ipc-guard 单独处理，不归此函数）：smart → allow（受第一层 host 闸保护）；workspace → 未信任 confirm；strict → confirm。
  - 决策纯函数，不 import electron；dialog 在 ipc-guard 调。

### 6. `src/app/ipc-guard.ts`（主进程统一闸；X-001 第一/二/三层落地）
- 导出：
  - `function classifySender(event: any): { ctx: any; kind: 'provider'|'own-window'|'unknown'; ok: boolean; reason?: string }`
    - 用 `windowState.getContextByWebContents(event.sender)` 找 ctx；找不到 → unknown（拒绝）。
    - `event.sender === ctx.view.webContents` → provider；取 `event.senderFrame?.url`（回退 `event.sender.getURL()`），必须 host-allowlist.checkSenderUrl 为 provider 命中（matchers 用 `getAllProviders().map(p=>p.matchesUrl.bind(p))`，用 ctx.providerId 优先，实际页面 URL 可能已被劫持，**以当前所有 provider 域为准**）。
    - 其余注册自有 webContents（ctx.win / ctx.harnessView / ctx.overlayView / 其它独立窗口）→ own-window；URL 必须 isOwnWindowUrl。
    - 不匹配 → ok=false 并 `console.warn` 记录（含 channel、url、原因）。
  - `async function guardExecutionCall(event, kind: 'tool'|'js'|'command', payload: any): Promise<{ pass: boolean; ctx?: any; error?: { code?: string; error: string } }>`
    - 先 classifySender，不过 → 返回 `{ pass:false, error:{ error:'来源校验失败，已拒绝该操作' } }`。
    - tool：用 decideToolGate；confirm 时用 `dialog.showMessageBox(ctx.win, { type:'warning', buttons:['取消','确认执行'], defaultId:0, cancelId:0, ... })`，文案写明原因/命中特征/命令；用户取消 → pass:false（canceled）。
    - js：按 §5 execute-js 规则。
    - command：保留现有"每条确认"（execute-command 是手动通道，不动），但仍要过 classifySender。
  - 高危投递特征：guard 对 COMMAND_TOOLS 先算 `findDeliverySignature(normalizeCommand(command))`，把 deliveryMatched 传入 decideToolGate。
- 改造 `src/app/ipc/tool.ts`：execute-tool / execute-js 入口先 `await guardExecutionCall(...)`，不过直接返回失败结果；通过才执行。注意 tool.ts 现有 projectDir/windowId 解析复用 guard 返回的 ctx。
- 改造 `src/app/ipc/command.ts`：入口加 classifySender（确认弹窗保留）。
- 对其它会触达文件/命令的 handler（write-project-file、task 启动、executeJs 经 task、inject-js 等）：C 排查后至少加 classifySender 硬来源校验（host 白名单无感），文件写入是否确认按策略。**不允许漏网的执行面**。
- 新增测试：host 白名单纯函数 + classifySender 决策（用伪造 ctx/wc 的最小桩，或把可单测部分下沉）；伪造 provider 域/第三方域/自有窗口三态。

### 7. `src/app/workspace-trust-prompt.ts`（信任门编排）
- 导出 `async function ensureWorkspaceTrust(parentWin: any, dir: string | null): Promise<{ trusted: boolean; scope: TrustScope }>`
  - 无 dir / 无 artifacts → `{ trusted:true, scope:'trusted' }`（不弹）。
  - 已信任（持久/会话）→ 直接返回。
  - 否则 `dialog.showMessageBox`，按钮：[信任并启用]（默认聚焦"不信任"，cancelId=2）、[仅本次会话]、[不信任]；detail 列出 MCP server 名+命令/url、规则数与名称、技能数与名称，并说明"这些内容将在你电脑上运行/注入提示词"。
  - 选择后 `setWorkspaceTrust`；不信任 → trusted:false。
- 挂接：`src/session/project-context.ts` 的 `initProject`，在 **selectedDir 确定之后、`buildPrompt` 之前**，且在 MCP 连接/规则技能注入之前调用；信任结果参与后续（数据层还有兜底，见 §8）。
- 子代理（noDialog）/压缩（presetDir）等自动场景：若项目未信任，按"不信任"处理（不弹），不得静默启用项目级内容；presetDir 若是同一已信任项目则正常。

### 8. IPC 通道（C 注册并在 `src/app/shell-preload.ts` 暴露 invoke；E 在壳设置页消费）
- `get-execution-policy` → `{ success:true, mode }`
- `set-execution-policy`（入参 `{ mode }`）→ `{ success:true, mode }`
- `get-trusted-workspaces` → `{ success:true, workspaces: [{path, since}] }`
- `revoke-workspace-trust`（入参 `{ dir }`）→ `{ success:true }`
- 这些壳通道仅限自有窗口（classifySender=own-window）。

## 四、D 层信任/SSRF 接入（Wave3，依赖 §4 infra）

- `src/mcp/config.ts` buildServerDef/getServers：`source==='project'` 的 server，`enabled = isWorkspaceTrusted(projectDir) && state[name] !== false`（用户级、插件级保持现状默认启用）。
- skills/rules 注入：在扫描/组装 prompt 处（`src/session/prompt-builder.ts`、`project-context.ts`、`src/skills/index.ts`、`src/rules/index.ts` 及 list-skills IPC 等）对 `source==='project'` 的规则/技能，在 `!isWorkspaceTrusted(projectDir)` 时过滤；用户级不受影响。**数据层兜底，不依赖弹窗顺序。**
- `src/mcp/client.ts:189-192`（StreamableHTTPClientTransport，http 类型）：建立连接前对 `server.url` 走 SSRF 守卫（复用 infra/ssrf-guard 的 assertUrlAllowed，与 web-fetch 同一函数）；不通过直接连接失败并提示。

## 五、E 层 sanitizer 契约（Wave2）

- 唯一真源：`src/overlay/sanitizer.ts`（DOM 实现，无第三方依赖），导出 `sanitizeHtml(html: string): string` 与 `escapeHtml(s): string`（转义 & < > " '，修 panel.ts 现有 escapeHtml 不转引号）。
- 白名单：放行 h1-h6/p/br/hr/ul/ol/li/strong/em/b/i/del/s/code/pre/blockquote/a/table/thead/tbody/tr/th/td/span/div/img/kbd/sup/sub/ul/input（仅 checkbox disabled，markdown 任务列表）等现状确实用到的标签；**删除** script/iframe/object/embed/link/style/meta/form/button/svg（math 不在此列，katex 输出在 sanitize 之后恢复）/math 等危险面。
- 属性：仅放行 `class`、`href`、`src`、`alt`、`title`、`colspan/rowspan`、`target`、`rel`、`aria-*`、`data-*`（data 仅字符串）；**删除所有 `on*` 事件属性**；`href/src` 只允许 `http:`、`https:`、`#`、相对路径、`mailto:`；删除 `javascript:`/`data:`（img src 不放 data:）/`vbscript:`；a 强制 `rel="nofollow noopener"`、外链 `target=_blank`。
- 用 `<template>` 解析，遍历 DOM 白名单重建；不要用正则去 HTML。
- harness `renderMarkdown` 管线顺序：提取数学占位 → `marked.parse` → **sanitizeHtml（占位 @@MATHn@@ 为纯文本，存活）** → 再恢复 KaTeX 受信 HTML。回退纯文本路径也必须 escape。
- 独立窗口（harness.html / shell partials / 各独立 HTML）共享同一份实现：通过构建脚本（esbuild，参考 build-hooks.mjs）从 `src/overlay/sanitizer.ts` 生成独立浏览器 JS（IIFE 挂 `window.CuckooSanitize`），**不允许手维护两份逻辑**；E 自行确定静态资源加载方式并保证 compile 产物可被 HTML 引用、跑通后用测试验证。
- overlay：mcp-manager（E-001，server 名/属性位全部转义）、window-manager（E-003，显示名/昵称）、panel.showConfirmDialog（E-004，text/按钮文案走 textContent 或 sanitize）、其他 E-005/E-008 innerHTML sink 全量整改。
- 测试：sanitizer 纯函数（onerror/<script>/javascript:/data:/svg onclick 全部移除；正常 markdown/表格/图片/代码/class/aria 保留）；katex 公式不被破坏（用含 `$...$` 样例）；server 名注入、窗口名注入回归。

## 六、每批/每片完成标准（硬）

1. `npm run typecheck` 0 error；`npm test` 全绿（只增不减，不允许弱断言/skip/硬编码）；`npm run lint` 0 error；`npm run compile` 0。
2. P0/P1 每项必须有回归测试；攻击型 PoC（.agents/audit-poc/）对应项复跑必须失效（防御型如 zip-slip 仍通过）。
3. 圈复杂度 <9；新公开接口写 JSDoc；新增单文件 ≤700 行；新逻辑不塞 entry.ts。
4. 小步 commit，message 含 bug ID：`fix(A-001): ...`、`fix(X-001): ...`；**Wave 内不要改其它层文件**。
5. 不起真机；hook/CDP 类无法单测的逻辑下沉为纯函数，真机待验项在返回里列出。
6. 发现审计结论有误或本契约不可行，立刻回报 Organizer，不将错就错、不静默跳过。

## 七、C 层补充勘察（Organizer 已核实，直接采信）

- **无自定义协议**：全项目未注册 protocol.register*/handle。自有窗口均 `loadFile`（file://）：壳 `ui/shell.html`（entry.ts:426）、harness `ui/harness.html`（:283）、选择页（:567）、alert/confirm/notification 窗口；插件 overlay 用 `data:text/html`（entry.ts:238）。故 `isOwnWindowUrl` 放行 **file: / data: / about:blank** 三种即可，无需自定义 scheme。
- **sender 校验要点**：overlay（bridge/entry.ts）与 AI 页同处 ctx.view（远程 provider 域），其正常调用（聊天、读写项目文件、任务、插件 UI 等）来自 `event.sender === ctx.view.webContents` 且帧 URL 为 provider 域；必须用 **`event.senderFrame.url`**（主帧与 iframe 都校验，回退 sender.getURL()）。非 provider 域（如 evil.com / about:blank / 外域 iframe）= unknown 拒绝。
- **必须过 guardExecutionCall（host 校验 + 策略 + 必要弹窗）的执行面**：
  - `execute-tool`、`execute-js`（src/app/ipc/tool.ts）；`execute-command`（command.ts，保留其每条确认）。
  - `task-start`（src/app/ipc/task.ts:56，会 spawn 命令）。
- **至少加 classifySender 硬来源校验（host 白名单，无感）的副作用面**：`write-project-file`、`create-project-entry`、`rename-project-entry`、`delete-project-entry`（session.ts）；`create-snapshot`/`restore-snapshot`（snapshot.ts，restore 是写）；`plugin-inject-main-world`（plugin.ts:556）、`plugin-overlay-eval`（:1010）、`plugin-host-call`（:465）、`plugin-command-invoke`（:701）、`cuckoo-plugin-install`/`plugin-install`（与 D 层安装确认联动）；`simulate-mouse`、`chat-send-enter`（renderer.ts，AI 页 overlay 合法调用，仅需 host 校验）。
- 其余只读/壳内 UI 通道（list/get/wg-/shell-窗口控制等）不强制；C 可在 ipc/index.ts 用统一包装降低重复，但不要大范围重写无关注册逻辑。

## 八、设置页落点（任务 #17，E 改真源、C 提供通道）

- 真源：`src/ui/shell/partials/pages/settings.html`（结构）+ `src/ui/shell/scripts/pages/settings.ts`（逻辑）；前端 API 封装在 `src/ui/shell/scripts/shell-api.ts`。`src/ui/shell.html` 是 build-shell.mjs 生成物，禁手改。
- 新增区块"安全 / 执行策略"：三档单选（smart 智能[默认] / workspace 按工作区信任 / strict 每次确认）+ 受信任工作区列表（路径、可撤销）。
- 数据流：shell-api.ts 调 shell-preload 暴露的 get/set-execution-policy、get-trusted-workspaces、revoke-workspace-trust（通道由 C 在 `src/app/shell-preload.ts` 注册，仅限 own-window）。
