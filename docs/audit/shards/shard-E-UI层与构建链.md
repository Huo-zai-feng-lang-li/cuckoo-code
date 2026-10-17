# Shard E：UI 层与构建链 —— 只读 Bug 审计报告

- 审计范围：src/overlay（11 TS + 1 生成物）、src/ui/shell/scripts（19 通用 + 18 pages TS）、29 个 HTML、scripts/（13 个）、start.js、release.bat、eslint-rules、templates/
- 审计方式：只读通读 + 定点 PoC；未改任何源码/构建脚本/生成物
- 日期：2026-10-17

---

## 一、已审文件清单（无遗漏）

### E1 overlay（src/overlay/）—— 12 个文件全部通读
- state.ts ✅
- fab.ts ✅
- project-dir.ts ✅
- session-list.ts ✅
- panel.ts ✅
- tps.ts ✅
- events.ts ✅（678 行全读）
- chat-input.ts ✅
- panels/window-manager.ts ✅
- panels/mcp-manager.ts ✅
- panels/settings.ts ✅
- template.generated.ts ✅（生成物，真源 panel.ts OVERLAY_HTML，对照一致）

### E2 shell scripts（src/ui/shell/scripts/）—— 37 个全部通读
通用（19）：shared.ts ✅、shell-api.ts ✅（纯类型）、main.ts ✅、sidebar.ts ✅、toolbar.ts ✅、tooltip.ts ✅、modal-guard.ts ✅、newconv-loading.ts ✅、activitybar-drag.ts ✅、activitybar-overflow.ts ✅、activitybar-visibility.ts ✅、platform.ts ✅、theme-presenter.ts ✅、update-progress.ts ✅、window-switch.ts ✅、recent.ts ✅、plugin-shell.ts ✅、preview.ts ✅、preview-monaco.ts ✅
pages（18）：about.ts ✅、mcp.ts ✅、memories.ts ✅、snapshots.ts ✅、conversations.ts ✅、snippets.ts ✅、skills.ts ✅、rules.ts ✅、agents.ts ✅、files.ts ✅、git.ts ✅、plugins.ts ✅、windows.ts ✅、token.ts ✅、remote.ts ✅、settings.ts ✅、tasks.ts ✅、workspaces.ts ✅

### E3 HTML（29 个）—— 全部审查
独立窗口：alert-window.html ✅（无 innerHTML sink）、confirm-window.html ✅、harness.html ✅（4800 行，重点 sink 逐处读）、notification-window.html ✅、platform-select.html ✅
shell 真源：index.html ✅、partials/{activitybar,modals,statusbar,toolbar}.html ✅（静态骨架）、partials/pages/ 18 个 ✅（静态骨架）
生成物：src/ui/shell.html ✅（一致性结论见第五节）

### E4 构建脚本（scripts/）—— 13 个全部审查
build-docs-index.mjs ✅、build-hooks.mjs ✅、build-shell.mjs ✅、build-tool-api.mjs ✅、copy-monaco.mjs ✅、copy-remote-pwa.mjs ✅、create-plugin.mjs ✅、fetch-runtime.mjs ✅、patch-electron-icon.mjs ✅、runtime-versions.json ✅（静态版本号）、sync-market.mjs ✅、sync-version.js ✅、try-dsh-plugin.mjs ✅

### E5 根文件
start.js ✅、release.bat ✅、eslint-rules/no-restricted-requires.js ✅、templates/ 8 个文件 ✅（plugin.json/README×2/dsh/example/ui/example/provider.template/intercept/simple，grep 无 innerHTML/eval/child_process 危险模式）

### 跨片取证（为定级而读，不属本片交付）
- bridge/api.ts（electronAPI 暴露面：executeJs/executeTool/executeCommand 存在，main world 可达）
- bridge/entry.ts（overlay 注入点、setIsSubagentWindow 调用点）
- src/app/entry.ts:260-269（harness 窗口 webPreferences）、src/app/harness-preload.ts（harnessAPI 暴露面）
- src/mcp/config.ts:40-220（项目 .agents/mcp.json → listConfiguredServers 数据流）
- src/updater/index.ts:184-223（release notes 转义路径）

---

## 二、确认 Bug 条目

### P0

#### E-001 overlay MCP server 名未转义注入 innerHTML → XSS 可触达 IPC
- **级别**：P0
- **类别**：DOM XSS（不可信数据流入 + IPC 可达）
- **位置**：`src/overlay/panels/mcp-manager.ts:46-47`
  ```js
  return '<div class="cuckoo-window-item cuckoo-mcp-item" data-mcp-name="' + s.name + '">' +
    '<span class="cuckoo-window-name">' + s.name + '</span>' +
  ```
- **功能**：MCP 面板列出 `listMcpServers()` 返回的全部 server（含 `source==='project'` 项目级）。
- **触发链路**：项目目录内 `.agents/mcp.json` 的 JSON key（server 名）→ `src/mcp/config.ts` readServersAt 原样作为 `name`（config.ts:155-175 全链路无转义）→ IPC `list-mcp-servers` → overlay `renderMcpList` 原样拼进 innerHTML。`.agents/` 就在项目工作目录下，AI 有文件写权限（其本职就是改代码），克隆恶意仓库/prompt 诱导 AI 写入该文件即可植入；项目级 server 默认 enabled，面板一打开即渲染。overlay 跑在 AI 网页渲染进程，而 `window.electronAPI` 经 contextBridge + 兜底直挂暴露到 main world（bridge/api.ts:255-260），innerHTML 注入的 `<img onerror>` 在 main world 执行 → 可调 `window.electronAPI.executeJs(code)` / `executeTool` / `executeCommand`。
- **复现/PoC**：`.agents/audit-poc/poc-overlay-mcp-name-xss.cjs`，载荷 `x"><img src=x onerror="window.electronAPI.executeJs(...)"><span data="` 经模板产出原始 `<img onerror>`（未转义）。手动复现：项目 `.agents/mcp.json` 写 `{ "mcpServers": { "x\"><img src=x onerror=alert(1)><span data=\"": {} } }`，打开 Cuckoo 悬浮窗 MCP 面板即触发。
- **影响**：恶意仓库/AI 诱导写文件 → 用户打开 MCP 面板 → main world 任意 JS → 触达主进程 IPC（executeJs 主进程侧执行）。
- **置信度**：9（数据流逐环取证 + PoC 验证模板产出；executeJs 的主进程权限细节属 Shard D，未展开）
- **现有测试**：`test/overlay/panels/mcp-manager.test.js` 只覆盖保存校验，不覆盖渲染转义 → **盲区**
- **修复建议**：`s.name` 两处均改 `escapeHtml(s.name)`（内容位）与 `escapeAttr(s.name)`（data-mcp-name 属性位），与 shell 侧 `pages/mcp.ts:24-33` 的正确做法对齐。

### P1

#### E-002 harness 渲染 AI 回复：marked.parse 无消毒 → DOM XSS
- **级别**：P1
- **类别**：DOM XSS（不可信数据流入；IPC 可达但仅 harnessAPI 有限面）
- **位置**：`src/ui/harness.html:2571-2573`
  ```js
  src = window.marked.parse(src, { gfm: true, breaks: true });
  ...
  body.innerHTML = renderMarkdown(text);   // :2849 / :2907 / :2930 / :2952
  ```
- **功能**：纯净模式渲染 AI 助手回复（markdown）。
- **触发链路**：AI 回复正文（不可信：prompt injection / 恶意仓库诱导模型输出含原始 HTML 的回复）→ renderMarkdown → marked v18.0.14 默认放行原始 HTML → innerHTML。harness 窗口 contextIsolation:true、preload 把 `window.harnessAPI` 暴露到 main world（harness-preload.ts:101-105），`<img onerror>` 在 main world 执行 → 可调 `harnessAPI.sendMessage/attach/newConversation/...`。
- **复现/PoC**：`.agents/audit-poc/poc-harness-marked-xss.cjs`：输入 `<img src=x onerror="...">` → 输出原样保留（PoC 实测确认）；`[x](javascript:...)` → `<a href="javascript:...">`（PoC 实测确认）。
- **影响**：AI 回复诱导 → harness 渲染即触发自动向 AI 发消息/附文件/切窗口组；不能 executeJs/命令（harnessAPI 无此面），故不定 P0。
- **置信度**：9
- **现有测试**：无（test/ 下无 harness 渲染测试）→ **盲区**
- **修复建议**：marked 输出过 DOMPurify（或自写白名单 sanitize），至少剥掉 onerror/onload 等事件属性与 `javascript:` href。

#### E-003 overlay 窗口管理器 p.name 未转义（自伤型 XSS）
- **级别**：P1
- **类别**：DOM XSS（自伤型，可触达 electronAPI）
- **位置**：`src/overlay/panels/window-manager.ts:32-42`
  ```js
  return '<div class="cuckoo-window-item" data-profile-id="' + p.id + '">' +
    ...
    '<span class="cuckoo-window-name">' + p.name + '</span>' +
    '<span class="cuckoo-window-status">' + pname + '</span>' +
  ```
- **功能**：overlay 窗口组面板列出 profile。
- **触发链路**：profile 显示名 = 用户在 platform-select 手输，或 `update-window-name` IPC 把 AI 网页 `extractUserInfo()` 抓到的用户昵称自动写回（app/windows.ts:120-146）。两者都属用户本人可控 → 自伤型；但一旦注入即在 AI 网页渲染进程 main world 执行，同 E-001 链路触达 electronAPI。
- **复现/PoC**：新建窗口时名称输入 `<img src=x onerror="alert(1)">`，打开悬浮窗窗口面板即触发（静态推演，置信度已含）。
- **影响**：自伤型提权 XSS；昵称来源若被页面侧污染则面扩大。
- **置信度**：8
- **现有测试**：无 → **盲区**
- **修复建议**：`escapeHtml(p.name)`、`escapeAttr(p.id)`、`escapeHtml(pname)`。

### P2

#### E-004 showConfirmDialog 文案原样进 innerHTML（潜伏）
- **级别**：P2
- **类别**：DOM XSS 潜伏点
- **位置**：`src/overlay/panel.ts:143-153`
  ```js
  dialog.innerHTML = '<div class="cuckoo-modal-title">' + title + '</div>' +
    '<div class="cuckoo-modal-text">' + text + '</div>' + ...
  ```
- **功能**：overlay 通用确认框。
- **触发链路**：当前唯一调用方 `mcp-manager.ts:188` 传静态字符串，暂无不可信流入；但函数签名接受任意 text/okText/cancelText，后续任何调用方传入动态串即 XSS。
- **影响**：潜伏，当前无实际触发。
- **置信度**：8
- **现有测试**：无渲染测试。
- **修复建议**：title/text/okText/cancelText 改 textContent 赋值。

#### E-005 overlay escapeHtml 不转义引号 → 属性位潜在注入（推测）
- **级别**：P2（推测区条目，置信度 5）
- **位置**：`src/overlay/panel.ts:73-77`（`div.textContent=text; return div.innerHTML` 只转义 & < >）；使用点 `session-list.ts:37` `data-session-id="${escapeHtml(s.sessionId)}"`、`panel.ts:306` `data-id="${escapeHtml(item.id)}"`。
- **触发链路**：若 sessionId/callId 含 `"` 即属性逃逸。当前 sessionId 由本地 store 生成（UUID），callId 内部序号，无外部注入路径。
- **置信度**：5（推测）
- **修复建议**：overlay 的 escapeHtml 与 shell 的 escapeAttr（转引号）对齐，属性位统一用 escapeAttr。

### P3

#### E-006 子代理窗口仍写共享 localStorage token 缓存（统计串数据）
- **级别**：P3
- **类别**：存储竞态/跨窗口串数据
- **位置**：`src/overlay/events.ts:61-62`（定义 `isSubagentWindow` 与 setter）；`events.ts:185` `saveTokenForSession` → `addDailyToken` 未读该标志；调用点 `bridge/entry.ts:154` 子代理窗口会 `setIsSubagentWindow(true)`。
- **触发链路**：events.ts:60 注释明确"子代理共享父窗口 localStorage，不应参与 token 统计"，但 onInterceptedResponse（events.ts:385+）与 saveTokenForSession 全程不检查该标志 → 子代理窗口的 token 也写进 `cuckoo-token-*` 共享键 → 今日累计/图表双计。
- **影响**：token 统计偏高（UX 数据准确性）。
- **置信度**：7
- **现有测试**：无。
- **修复建议**：saveTokenForSession/addDailyToken 入口加 `if (isSubagentWindow) return;`。

#### E-007 设置页主题 id 未转义（插件可信边界内）
- **级别**：P3
- **位置**：`src/ui/shell/scripts/pages/settings.ts:121-122` `themeSelect.innerHTML = opts.map(([v, label]) => '<option value="' + v + '">' + label + ...)`；`settings.ts:191-203` 活动栏开关 label 来自 DOM title（插件挂载）。
- **触发链路**：theme id / 插件图标 label 均来自用户显式授权安装的插件（plugin-shell 同信任边界），无仓库级不可信路径。
- **置信度**：7
- **修复建议**：仍按 escapeAttr/escapeHtml 处理，防止插件配置失误放大。

#### E-008 fetch-runtime 下载二进制无校验和
- **级别**：P3
- **位置**：`scripts/fetch-runtime.mjs:54`（curl 直下 github.com/nodejs.org 的 uv/node 二进制，无 hash/签名校验）。
- **触发链路**：构建期拉取，HTTPS 但无完整性校验；CDN/中间人投毒可替换运行时二进制。
- **置信度**：8（静态推演）
- **修复建议**：runtime-versions.json 增 sha256，下载后校验。

#### E-009 渲染层无 CSP（加固项）
- **级别**：P3
- **位置**：全部 29 个 HTML 无 `<meta http-equiv="Content-Security-Policy">`（Grep 全 src 零命中）。
- **影响**：一旦出现 XSS（如 E-002/E-003），无 CSP 兜底；local file 加载面小，但 harness/shell 窗口均无 CSP。
- **置信度**：9
- **修复建议**：shell.html / harness.html 加 `default-src 'self'; script-src 'self'`（注意 harness 需 vendor katex/marked 白名单）。

---

## 三、推测区（置信度 ≤6）
1. **E-005**（上述）：sessionId/callId 若未来改为外部来源，属性注入即刻成真；当前无路径。置信度 5。
2. start.js:84 `debugArg` 来自环境变量 `CUCKOO_DEBUG_PORT`，以 `shell:true` 拼进命令行——环境变量本身等价本机权限，非攻击面，仅记录不报告。置信度 6。
3. overlay chat-input.ts 延迟发送窗口（fixedDelay/randomDelay 最长约 1s）内用户切会话，triggerSend 可能点到新会话输入框——发送队列串台已由 manualSendToken（harness.html:3199-3243）在 harness 侧修复（已核实在位），overlay 侧 sendToChat 直接作用于当前 AI 页面 DOM，切会话后输入框 DOM 已变，风险低。置信度 5。

## 四、本片测试盲区清单
- overlay mcp-manager 渲染转义（现有 test 只覆盖保存校验）
- harness renderMarkdown → innerHTML 的 sanitize（无测试）
- overlay window-manager/profile name 渲染（无测试）
- showConfirmDialog 文案转义（无测试）
- 子代理窗口 token 写共享 localStorage 的抑制（无测试）
- shell.html 生成物与真源一致性（无构建后校验测试；本次人工 rebuild 验证通过）

## 五、生成物 shell.html 与真源一致性结论
- 执行 `node scripts/build-shell.mjs` 后 `git status --short src/ui/shell.html` 无输出 → 生成物与 src/ui/shell/ 真源逐字节一致，无手改漂移。
- build-shell.mjs 本身：静态路径拼装（SRC_DIR/OUT 固定），esbuild 打包入口固定 scripts/main.ts，无用户输入/环境变量拼接，无命令注入面。

## 六、DOM XSS sink 全量清点表

| 位置 | sink | 数据来源 | 是否转义 | 结论 |
|---|---|---|---|---|
| overlay/panel.ts:27 | injectOverlay | 静态 OVERLAY_HTML | — | 安全 |
| overlay/panel.ts:143 | showConfirmDialog innerHTML | 调用方文案 | **否** | E-004 潜伏 |
| overlay/panel.ts:305 | renderHistory | callId/command（AI 工具参数，truncate 60） | escapeHtml | 安全（内容位） |
| overlay/session-list.ts:36 | 会话列表 | sessionId/title（AI 生成标题） | escapeHtml | 安全（属性位引号见 E-005） |
| overlay/panels/mcp-manager.ts:46-47 | MCP 列表 | **项目 .agents/mcp.json server 名** | **否** | **E-001 P0** |
| overlay/panels/window-manager.ts:38,40 | 窗口列表 | profile name（用户/网页抓取昵称） | **否** | **E-003 P1** |
| shell 各 pages（37 文件全部逐处核对） | innerHTML | 会话标题/文件名/git 输出/插件市场字段/任务输出/MCP 名/快照名等 | 全部 escapeHtml/escapeAttr 或 textContent | 安全（唯 settings.ts:121 主题 id 见 E-007） |
| shell/plugin-shell.ts:68,89,105,135,147,158,190 | new Function / spec.html / icon | 插件 spec | 插件授权后信任执行 | 设计内，非 bug |
| shell/preview.ts:194 | bar.innerHTML | 静态文案 | — | 安全 |
| shell/token.ts:83 | data-date 属性 | 主进程日统计日期 | 主进程可信 | 安全 |
| harness.html:2849/2907/2930/2952 | renderMarkdown(text) | **AI 回复正文** | **marked 无消毒** | **E-002 P1** |
| harness.html:2983-2996 | 工具卡 innerHTML | 工具名/参数/代码 | esc(&<>) | 安全 |
| harness.html:3020 | outPre.textContent | 工具输出 | textContent | 安全 |
| harness.html:3303-3311 | 发送队列 row | 用户待发消息 | textContent | 安全（manualSendToken 修复在位） |
| harness.html:2238/2245 | 计划条 innerHTML | AI plan content | esc(&<>) | 安全 |
| harness.html:3650/3660 | sys-text | 系统文案 | esc | 安全 |
| harness.html:3810/3837 | chip innerHTML | 技能/附件元数据 | esc / fileIcon 静态 | 安全 |
| confirm-window.html:421 | li.innerHTML=String(n) | GitHub release notes | updater extractReleaseNotes 已 escapeHtml（updater/index.ts:209） | 安全 |
| notification-window.html:224-225 | title/body | 通知正文 | textContent | 安全 |
| platform-select.html:223,249,324 | 平台列表 | providers 清单（内置+插件） | 静态结构，name 仅取首字母 | 安全 |

## 七、构建链高风险项静态推演/PoC 结论
- fetch-runtime.mjs：execSync 拼接的 dest/url 均来自 runtime-versions.json（入库常量），无用户输入 → 无命令注入；仅缺完整性校验（E-008）。
- sync-market.mjs：execFileSync 数组参数（无 shell），repo/branch 进 gh api 参数串 → 无注入。
- build-shell.mjs / build-hooks.mjs / build-tool-api.mjs / create-plugin.mjs（id 正则 `^[a-z0-9][a-z0-9-]{0,63}$`）/ copy-*.mjs / patch-electron-icon.mjs（spawnSync 数组）/ try-dsh-plugin.mjs（new Function 执行内置样例）：均无外部输入注入面。
- start.js：npx/electron 启动命令参数静态；release.bat：NEW_VER 经 `^[0-9]+\.[0-9]+\.[0-9]+$` 严格校验后才进 node -e / git 命令行 → 无注入；无硬编码凭据。
- eslint-rules/no-restricted-requires.js：纯静态分析规则，无执行面。

## 八、handoff 历史修复复核
- manualSendToken 发送队列回填串台：已核实 harness.html:3199-3243 令牌作废逻辑在位，row 渲染用对象引用 it 而非 idx（:3320 注释）→ 修复在位，无回归。
- tooltip 遮挡 / 新建对话 loading 遮罩 / 通知浮窗高度：本片对应文件（tooltip.ts、newconv-loading.ts、notification-window.html）代码与修复描述一致，未发现回退。

## 九、PoC 清单
| 文件 | 验证目标 | 结果 |
|---|---|---|
| .agents/audit-poc/poc-overlay-mcp-name-xss.cjs | mcp-manager.ts:46-47 模板对载荷原样输出 | 通过（<img onerror> 原样保留） |
| .agents/audit-poc/poc-harness-marked-xss.cjs | vendor marked v18.0.14 对原始 HTML/javascript: 链接的放行 | 通过（两类载荷均原样进输出） |
