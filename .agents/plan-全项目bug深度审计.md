# 计划：cuckoo-code 全项目 Bug 深度审计（输入→输出，从里到外）

> 创建时间：2026-10-17
> 性质：**只读审计**，不修改任何源代码；产出分级 bug 报告，修复与否由用户后续决定。

## 概述

对 cuckoo-code（Electron + DeepSeek/ChatGPT/Claude 网页内嵌、AI 命令/工具调用自动执行桌面应用）全部自有代码逐文件审计：237 个 TS 文件（约 6 万行）+ 31 个 HTML + 13 个构建脚本 + eslint-rules/templates。按"输入 → 解析 → 决策 → 执行 → 输出"端到端链路挖掘全部 bug，每条发现必须带文件:行号代码证据、触发链路、影响、置信度与修复建议。

## 默认决策（用户未在交互时限内选择，按最安全可逆方案执行）

- 处置方式：**只出审计报告，不改代码**
- 范围：**全量 17 个模块**
- 验证深度：静态逐文件读码 + 现有测试基线（100 个测试文件 / 1012 用例）+ 高风险问题写最小 PoC 脚本实证；不启动 Electron 真机

## 审计分片（5 路并行，每路独立闭环：读规则 → 通读代码 → 取证 → 分级 → 标准化输出）

### Shard A：安全基座与工具执行层（src/infra + src/tools）
- infra（12）：dangerous-commands、protected-paths、ssrf-guard、paths、decode-output、eol、markdown、memories、task-manager、tool-error-log、user-agent、with-log
- tools/core（3）：Tool、ToolRegistry、ToolResult
- tools/impl（23）：bash、pwsh、edit、write、read、read-lines、glob、grep、delete-file、web-fetch、mysql、inject-js、open-browser-window、browser-window-manager、attach-file、mcp-call/query、remember、run-agent、snapshot、todo-write、goal-done、name-conversation
- tools/runtime（JsRunner）、tools/index、browser-preload
- 重点：命令注入与参数转义、危险命令黑名单绕过、路径穿越/软链、SSRF、SQL 注入、任意 JS 执行沙箱、子进程/僵尸进程、超时与取消、输出编码、大文件/二进制、竞态、TOCTOU

### Shard B：解析注入与平台适配层（src/bridge + src/providers）
- bridge：api、entry、harness-bridge、intercept/observer、loop/executor、loop/retry、loop/watchdog、parser/js-detector、parser/json-detector、plugin-system、probe、remote-bridge、subagent
- providers：deepseek、chatgpt、claude、registry、validate、types、custom/loader、hooks/{deepseek,chatgpt,claude}、hooks/shared/sse
- 重点：AI 输出解析误判/漏判（漏执行、错执行、重复执行）、JSON/JS 提取边界、流式 SSE 断帧与重连、重试/看门狗死锁活锁、MutationObserver/事件监听泄漏、hook 注入时序、页面 XSS、平台 DOM 变更脆弱性

### Shard C：主进程 / IPC / 会话层（src/app + src/session + src/agents）
- app：entry.ts(1547 行)、ipc 23 个（command/session/shell/harness/plugin/git/task/tool/remote/webserver/window-groups/snapshot/snippets/memory/settings/theme/recent/rules/project/cdp-attach/renderer/subagent）、window、window-groups、subagent、cuckoo-host、shell-preload、harness-preload、alert/confirm/notification 三窗口族、snapshots、snippets、prompt-enhancer、token-stats、ui-prefs、profile、goal、recent-tools、plugin-commands、plugin-tools、theme/theme-manager
- session：store、compaction(584 行)、prompt-builder、project-context
- agents：index、prompt、scanner、types
- 重点：IPC handler 输入校验/越权（renderer → 主进程任意命令）、监听器泄漏与重复注册、状态机竞态（新建/切换/停止/队列）、会话存储原子写与损坏、压缩丢数据、窗口生命周期与空指针、JSON 序列化边界、路径校验、单实例锁、权限提升

### Shard D：扩展生态与对外服务（src/plugins + src/mcp + src/remote + src/skills + src/rules + src/updater）
- plugins（约 35）：index、installer、market、market-state、manifest、paths、roots、state、types、plugins-config、github、gitee、http、auto-update、cuckoo-plugins 7 个、dsh-compat 6 个、runtime 14 个
- mcp：client、config；remote：server、manager、tunnel、config、pwa；skills 5 个；rules 9 个；updater/index
- 重点：插件沙箱逃逸与任意代码执行、zip-slip/路径穿越、市场与更新签名校验/中间人、HTTP 服务与 WebSocket 鉴权/CSRF、tunnel 暴露面、SSRF、MCP 恶意 server、规则/技能 frontmatter 解析与 prompt injection、路径遍历读文件

### Shard E：UI 层与构建链（src/overlay + src/ui/shell + src/ui 独立窗口 + scripts + 根配置）
- overlay 9 ts + template/overlay.html：chat-input、events、fab、panel、state、tps、project-dir、session-list、panels 3 个
- ui/shell：19 个通用脚本 + 18 个 pages 脚本 + 24 个 html partial + 3 css + index.html
- ui 根独立窗口：harness、alert、confirm、notification、platform-select、shell.html（生成物）
- scripts 13 个 mjs/js、start.js、eslint-rules、templates、release.bat
- 重点：DOM XSS（innerHTML/insertAdjacentHTML）、preload contextBridge 暴露面、IPC 响应伪造、事件监听/DOM 泄漏、localStorage/全局存储竞态、拖拽缩放边界、定时器节流、消息队列/发送队列时序、构建脚本路径与命令注入、生成物与真源一致性、release.bat 硬编码

## 每条 Bug 的标准记录格式（强制）

```
- ID：A-001（分片字母-序号）
- 级别：P0 致命 / P1 高 / P2 中 / P3 低
- 类别：安全 / 并发竞态 / 数据正确性 / 资源泄漏 / 错误处理 / 边界条件 / 性能 / 兼容性 / UX
- 位置：src/xxx/yyy.ts:行号（给出关键代码片段）
- 功能：所属功能点
- 触发链路：输入（什么数据/操作）→ 中间经过 → 错误输出/后果
- 复现/PoC：最小复现步骤或脚本（能实证必须实证）
- 影响：范围与后果
- 置信度：0-10（低于 7 明确标注"推测"）
- 现有测试是否覆盖：是/否（否=盲区）
- 修复建议：最小修复方向
```

## 验收标准

1. 覆盖完整：237 TS + 31 HTML + 13 脚本全部有通读记录，无遗漏文件；每个分片产出"已审文件清单"
2. 证据强制：每条 bug 必须有 文件:行号 + 代码片段；禁止"可能/大概"式条目，推测项置信度 ≤6 并单列
3. 三种索引：按 P0-P3 级别、按模块、按输入→输出链路均可检索
4. 测试基线：记录 `npm run typecheck`、`npm test`、`npm run lint` 当前结果，列出测试盲区清单
5. 不改任何源代码；报告全部用简体中文
6. 最终交付：
   - `docs/audit/2026-10-17-全项目bug审计报告.md`（总报告，含执行摘要/分级统计/Top 问题/修复优先级建议）
   - `docs/audit/shards/shard-{A-E}-*.md`（各分片原始发现）
7. 独立复核：复核 agent 抽检不少于 30% 条目，核对证据真实性，揪出臆造条目

## 执行流程

- [x] 现状盘点、分片方案、本计划落盘
- [ ] 5 路分片并行审计（各片先读 `.agents/rules/` 对应专项规则确立"预期行为"基准）
- [ ] 各片 PoC 实证高风险发现
- [ ] 汇总去重、校准级别、端到端链路串联
- [ ] 独立复核（证据真实性 + 覆盖完整性 + 级别合理性）
- [ ] 总报告交付，用户圈选修复范围后再开修复阶段

## 关键约束（审计纪律）

- 环境 Windows + pwsh 7；禁止 Bash 语法；复杂文本处理写 Python/Node 临时脚本，不内联
- 架构铁律：`infra ← providers ← tools ← bridge ← session ← app`；overlay 不依赖 bridge/session
- 窗口结构：AI 页面在 `ctx.view.webContents`，不是 `ctx.win.webContents`
- 生成物：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html` 只对照真源查一致性，不手改
- 事实必须可核验，数字/行号必须来自真实文件，信心评分规则生效
- 外网代理：`http://127.0.0.1:51081`（查 CVE/官方文档时用，代理不通则跳过并标注未查证）
- 审计基线：v0.9.24，handoff 记录 typecheck/lint(0)/test(1012)/compile 全绿
