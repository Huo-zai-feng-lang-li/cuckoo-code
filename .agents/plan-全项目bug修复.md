# 计划：cuckoo-code 全量 Bug 修复（59 条确认 + 推测项复核）

> 创建时间：2026-10-17
> 依据：`docs/audit/2026-10-17-全项目bug审计报告.md` + 5 份分片报告（每条 bug 的证据与修复建议）
> 用户决策：**"按照最优的全部修复"**——产品取舍由执行方按本计划定死的方案执行
> 分支：`fix/security-bug-sweep`（从 master 开出；审计产物未跟踪，不影响）

## 一、产品取舍决策（已定死，执行中不得擅自变更；如发现方案不可行，停下来记录并上报）

### X-001 信任模型（核心卖点 vs 安全的平衡）——三层防线，不做"每条命令都问"

1. **第一层：host 白名单硬校验（主进程）**
   - 所有执行面 IPC（`execute-tool`、`execute-js`、`execute-command` 及其他会触达工具/命令/文件的 handler）在主进程入口校验：
     `event.sender` 必须能在 windowState 中找到 ctx；`event.senderFrame.url` 的 host 必须命中当前已注册 provider（providers/registry 的域名列表）或本应用自有窗口（harness/shell/overlay 的 file:///自定义协议）。
   - 不命中一律拒绝并记日志。**无感、硬安全**，防第三方页面/导航逃逸页面。
2. **第二层：绝对高危投递特征硬闸（主进程，任何模式都弹）**
   - 扩充 `infra/dangerous-commands.ts`：新增"投递/反弹/持久化"特征族（PowerShell `-enc/-EncodedCommand`、`iex`/`Invoke-Expression`（含 `iwr|iex`、`curl|iex`）、`certutil -urlcache`、`bitsadmin /transfer`、写注册表 Run 键/启动文件夹、`powershell -w hidden`、`nc/ncat` 反弹、`wget/curl` 下载后立即执行的组合、`mshta`、`wscript/cscript` 跑远程脚本等）。
   - 命中特征族：无论什么策略，**bash/pwsh 工具执行前必须在主进程弹 `dialog.showMessageBox`**（复用 command.ts 的确认样式，警告文案写明具体命中特征），用户拒绝则不执行。
   - 误判代价：AI 正常下载安装也会弹——这是可接受的，此类动作本就该让用户知情。
3. **第三层：自动执行策略开关（设置页，默认"智能"）**
   - 设置新增"工具执行策略"：
     - `smart`（默认）：只读工具（read/read-lines/grep/glob/list 类）自动；项目目录内 write/edit 自动；bash/pwsh 仅命中第二层特征时弹；其余自动——保持当前核心体验。
     - `workspace`（按项目信任）：未信任项目首次执行命令/项目外写入时弹一次，信任后记住（信任记录 `~/.cuckoo/trusted-workspaces.json`，原子写，可在设置里撤销）。
     - `strict`：所有命令与写入每次询问。
   - 策略判定在**主进程**（渲染层开关可被网页绕过，不能作为闸）。
4. preload 暴露面：`api.ts:261` 兜底赋值保留（复核确认 contextIsolation 下不泄漏主世界），不做删除；只在注释里说明。不破坏 harness 功能。

### 工作区信任门（D-002 + D-004 合并为一次确认）
- 用户选择/新建项目目录后，若该项目存在 `.agents/mcp.json`、`.agents/rules/`、`.agents/skills/`：
  弹一次主进程对话框（列表展示：将要启动的 MCP server 名及命令、规则 N 个、技能 N 个），选项：
  **[信任并启用] [仅本次会话] [不信任（保持禁用）]**。
- 信任记录按项目目录路径持久化（复用 trusted-workspaces.json）。
- 不信任/未选择时：项目级 MCP 不 spawn（修 `mcp/config.ts:190` 默认启用 → 项目级默认 `false`，用户级保持默认启用）；项目级规则/技能不注入 prompt（用户级不受影响）。
- 信任门前任何项目级内容不得提前生效（检查启动加载顺序）。

### 插件策略（D-001）
- 安装前弹主进程警告框（展示包名、来源 registry/npm、"插件包含在你电脑上运行的任意代码"），需二次确认。
- 安装后**默认禁用**（`installAndLoad` 里 `setCuckooPluginEnabled(inst.id, true)` → `false`），UI 明确提示"已安装，需手动启用"；当次安装不再自动加载执行。
- 市场 curated 列表外的包名安装必须手输包名确认（防误装近似名）。
- 签名/校验和生态不具备，不做假签名；以"警告 + 默认禁用 + 白名单"为界。

### marked 消毒（E-002）
- **不引入新依赖**：在 harness 侧（脚本真源，注意 shell.html/harness.html 生成物由 build 流程产出）新增一个严格白名单 sanitizer（共享给 overlay 复用）。
- 允许 markdown 常规标签与 class（h1-6/p/br/hr/ul/ol/li/strong/em/del/code/pre/blockquote/a/table/thead/tbody/tr/th/td/span/div/img/kbd/sup/sub/细节按现状）；删除 script/iframe/object/embed/form/link/style/meta/svg 事件面；所有 `on*` 属性删除；href/src 只放行 http/https/相对路径与 anchor（#），删 `javascript:/data:/vbscript:`；a 强制 `rel="nofollow noopener"`；img 必须有 alt 且限制 src 协议。
- **KaTeX 兼容**：先查清 harness 公式渲染管线（marked→katex 的顺序），sanitizer 必须在 katex 渲染**之前**跑，且放行 class/aria-* 属性，不能杀公式；用项目里现有含数学公式的回复构造测试。
- E-009 CSP：给自有 HTML（harness/shell/overlay/notification/alert/confirm/platform-select）加合理 CSP meta（script-src 'self' 等；注意 overlay/harness 与 AI 页面的关系，CSP 加在自有窗口，不碰 AI 提供方页面）；若某窗口因内联脚本无法加 strict-dynamic，则用 nonce 或明确标注降级原因。

### A-005 JsRunner
- 改 Electron `utilityProcess`（主进程 fork 独立子进程，超时可 kill）或 Node `worker_threads`；JsRunner 现在在主进程 vm 内跑，必须迁出主进程事件循环。
- 保持对外 API（`jsRunner.run(code, dir, windowId, opts)` 签名与返回结构不变），只换执行载体；超时后进程/线程必须真死（PoC 验证 PID 消失）。
- 注入浏览器相关能力（CDP attach）的部分要在新载体里重新接通，这是本次最易回归的点，需对照现有 run-agent/inject-js 工具链路逐一验证。
- 单独批次（批 3），不与其他改动混。

### 版本与发布
- 修完后 package.json 版本 → **0.10.0**（安全模型变更 + 行为变更，0.x 阶段 minor 升级）；CHANGELOG `[Unreleased]` 改写为 `[0.10.0] - 2026-10-17`，按 Keep a Changelog 分 Security/Changed/Fixed，覆盖全部 59 条（可按类归并描述）。
- **不打 git tag、不 push、不发版**（tag 触发 CI 发布），由用户最终决定。

## 二、分批执行（每批结束必须：typecheck 0 + 全量 test 通过 + lint 0 error + compile 通过；PoC 对应项复跑确认失效）

### 批 0：准备
- [ ] 开分支 `fix/security-bug-sweep`；确认基线（typecheck/test 1012/lint）
- [ ] 建共享测试夹具目录约定（test/ 下就近放）

### 批 1：P0 止血（4 条）
- [ ] A-001 `web-fetch.ts`：`redirect:'manual'` + 逐跳 Location 过 `assertUrlAllowed`（限跳 ≤5），或 follow 后对 response.url 复检；补重定向测试
- [ ] A-002 `ssrf-guard.ts`：IPv6 归一化（Node `node:net`/自写解析，IPv4-mapped 取低 32 位判定；顺带覆盖 `::ffff:0x7f000001` 等）；补十六进制 mapped 测试
- [ ] E-001 `mcp-manager.ts:46-47` 及 `src/mcp/config.ts` 全链路：内容位/属性位转义（与 shell 侧 pages/mcp.ts 现有转义对齐）；补 server 名注入测试
- [ ] X-001：按上述三层防线（host 白名单 infra/app 层、dangerous-commands 投递特征族、主进程策略判定模块 + 设置页开关）；补：伪造 sender/host 拒绝测试、特征族拦截测试、三档策略测试

### 批 2：P1 安全（9 条）
- [ ] A-003 `protected-paths.ts`：Windows 下比较前路径大小写归一（`path.resolve` 后按平台 toLowerCase），保留大小写敏感平台行为；补大小写变体测试
- [ ] A-004 `dangerous-commands.ts`：补 PowerShell 别名（`rm -r -fo`、`Remove-Item -Recurse -Force` 缺失变体）、`cmd /c` 包装剥除、`--interactive=never` 类绕过、`iex`/`iwr` 变体；与 X-001 第二层特征族合并设计避免重复；补 6 类绕过回归 + 4 类正常命令不误伤测试
- [ ] D-001：插件安装警告 + 默认禁用 + 市场外手动确认；改 installAndLoad/index.ts 与 UI 提示；补安装流程测试
- [ ] D-002 + D-004：工作区信任门（见上）；新模块建议放 `src/app/workspace-trust.ts`（或与现有 project ipc 同层），信任记录复用原子写工具；补信任门测试
- [ ] D-003 `mcp/client.ts:189-192`：HTTP server URL 走 SSRF 守卫（与 A-001 同一函数）；补内网 URL 测试
- [ ] E-002：marked sanitizer（见上）+ harness 接入；补 onerror/javascript:/katex 回归测试
- [ ] E-003 `window-manager.ts:32-42`：窗口名/昵称转义；补测试
- [ ] E-009：各窗口 CSP（如时间紧张可挪批 5，但 sanitizer 必须在批 2）

### 批 3：P1 可靠性（7 个编号，8 处文件）
- [ ] A-005 JsRunner 迁移 utilityProcess/worker（见上，独立完成验证）
- [ ] A-006 bash/pwsh 进程树回收：Windows `taskkill /T /PID`（注意现有 task-manager 封装与 A-016 pid 复用问题一并修），Unix 进程组 kill；补 PoC 回归
- [ ] B-001 `retry.ts:191-201`：定时器发送前复核当前会话仍是发起会话（对齐 watchdog.ts:56-62 现有复核），不符则作废；补测试
- [ ] B-002 Claude hook 断流：无完成标志的流终态走 error/重试，不派发 finished；补断流测试（参照 hook 可测试部分，纯逻辑下沉）
- [ ] C-001/002/003：infra 新增 `writeJsonAtomic`（tmp 同目录 + rename + fsync 尽力；损坏时 .bak 回退；Windows rename 冲突用 retry），替换 store.ts/profile.ts/window-groups/token-stats/snippets/ui-prefs/recent-tools/theme-manager 共 8 处；PoC 回归
- [ ] C-004 `compaction.ts:207-250`：回退分支按 parent 链过滤 branch 消息，保证 user→assistant 配对；补配对测试

### 批 4：P2 中危（17 条，清单见总报告第六节）
- A-006 已在批 3；按 A-007/A-008、B-003/004/005/006、C-005/007/008、D-005/006/007/008、E-004/005 分片报告逐条修，每条配回归测试（解析边界类进 poc-parser-boundaries 同目录测试）。

### 批 5：P3（23 条）+ 推测项（17 条）
- P3 按 A-009~A-016、B-007~B-011、C-009~C-012、D-009/D-010、E-006~E-009 逐条修。
- 17 条推测项逐条回源复核：属实→修并转正；不属实→在修复报告里写明排除理由。
- E-009 CSP 在此批兜底完成。

### 批 6：收尾
- [ ] 全量验证：typecheck/test/lint/compile；**全部 12 个 PoC 复跑，确认攻击型 PoC 全部失效、防御型（如 zip-slip 10/10 挡住）仍通过**
- [ ] CHANGELOG 0.10.0 完整条目；package.json 版本；不 tag 不 push
- [ ] 同步更新 `.agents/handoff.md`（接续上下文）；检查 README 若描述了旧行为（如插件安装即启用、MCP 默认启用）同步修正
- [ ] 独立复核子 agent 按 checklist 全量审计修复

## 三、硬性纪律（用户规则 + 项目规则）

1. **禁止为过测试而弱化断言、跳过测试、硬编码结果**；新逻辑必须有对应测试（安全纯函数、解析边界、原子写、信任门、策略判定）。
2. 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`——改真源后跑 compile 生成。
3. 架构铁律：`infra ← providers ← tools ← bridge ← session ← app`；host 白名单、策略判定这种通用逻辑放 infra/app，不反向依赖。
4. 所有安全闸（确认/策略/白名单）必须在**主进程**；renderer/preload 只做展示与转发。
5. 圈复杂度 < 9；单文件新增代码遵守 ≤700 行（entry.ts 历史 1547 行不在本次重构范围，但不往里塞新复杂逻辑，新逻辑独立模块）；公开接口写 JSDoc。
6. Windows + pwsh 7 环境；复杂文本/JSON 处理写临时 Python/Node 脚本；文件搜索用 rg/Grep；后台进程用完即杀。
7. 每个修复都要"走一步验证一步"：批内小步提交（可按条 commit，信息含 bug ID 如 `fix(A-001): ...`），每批末尾跑全量。
8. 不真机启动（无登录态）；hook/CDP 类无法单测的改动，把逻辑下沉为可测纯函数，真机待验项在报告中显式列出。
9. 发现审计报告有误（代码实际不存在该问题或修复方案不可行），**先回源取证、记录上报**，不将错就错、不悄悄跳过。
10. 不删除审计 PoC 与报告；修复后在报告中补"已修复/验证结果"列。

## 四、完成标准（闭环）

- 59 条确认 bug 全部修复（或极少数有充分理由不改的，逐条写明原因与替代缓解措施）；17 推测项全部有结论。
- typecheck/test/lint/compile 全绿；新增测试全过；攻击型 PoC 全部失效。
- 独立复核通过（测试无弱化、改动最小、边界/并发/安全/文档/性能 checklist）。
- 交付：更新后的总报告（标注修复状态）、CHANGELOG、handoff、最终验证记录；工作区 diff 清晰可审。
