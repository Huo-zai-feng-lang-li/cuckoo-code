# 跨模块串联复核笔记（Organizer 亲自核查，供总报告"风险图"用）

> 目的：记录单片看不到、跨模块接合处的端到端风险。行号均已 Read 核对（2026-10-17）。

## 链路 1（最高风险）：远程 AI 网页 JS → 静默任意命令执行（跨 B/C/A）
1. AI 页面视图 WebContentsView 挂 bridge preload（src/app/entry.ts:177-180），contextIsolation:true/nodeIntegration:false/sandbox:false。
2. 该 preload 暴露 `window.electronAPI`（src/bridge/api.ts:255；并在 261 行无条件兜底挂 window）。其中：
   - `executeTool(toolName,params)` → IPC `execute-tool`（api.ts:32-34）
   - `executeCommand` → IPC `execute-command`（api.ts:13-15）
   - `executeJs` → IPC `execute-js`（api.ts:44-56）
3. 主进程 `execute-tool`（src/app/ipc/tool.ts:24-36）：**无确认弹窗、无 event.sender/来源校验**，直接 `toolRegistry.execute(toolName, {...params, projectDir})`。
4. bash 工具（src/tools/impl/bash.ts:114-209）：**自动执行，无确认**；唯一门控是 `isDangerous(trimmed)`（bash.ts:128-130 命中即拒绝）。
5. 对比：`execute-command`（src/app/ipc/command.ts:14-59）对每条命令都弹 `dialog.showMessageBox` 确认；说明项目本有确认机制，但工具自动通道（execute-tool）没有。
6. 黑名单 src/infra/dangerous-commands.ts：仅约 20 个破坏性命令模式；文件头注释自承"无法可靠拦截 cmd /c、变量展开、脚本文件等间接方式，生产应叠加白名单或强制确认"。
   - 已见具体缺口（待 Shard A 补 PoC）：
     - 不拦下载/投递：curl/wget/certutil -urlcache/bitsadmin/`powershell -c iwr|iex`/`powershell -enc`。
     - 不拦间接执行：`cmd /c`、`node x.js`、`python x.py`、`powershell -File`、`nc -e` 反弹 shell、.NET `[IO.File]::Delete`。
     - 【订正 2026-10-17 复核】第 25 行 `/^del\s+\/[a-z]*[fsq]/i` 与第 26 行 `/^(?:rd|rmdir)\s+\/[a-z]*s/i` **均带 /i 标志**，早先"缺 i、大写 DEL 可绕过"的判断系误判，不成立。del/rd 大小写绕过不可用（黑名单绕过仍成立，见 A-004 的 PowerShell 别名/cmd 包装/值选项等 6 类）。
     - `rm -rf` 只拦根(/)与家目录(~)本身；Git-Bash 风格 `/c/Users/...`、`rm -rf $HOME/Documents`、非根目录递归删除不拦。
     - `Remove-Item` 要求同时含 -recurse 与 -force 才拦（第 39 行），单文件/递归不强制不拦。
     - 不拦 reg add（只拦 reg delete）、schtasks/sc/net user/wmic/takeown/icacls/Add-MpPreference（关 Defender）/Set-ExecutionPolicy 等。
   - 触发模型：AI 页面被 prompt-injection（让模型回显工具调用）/ 页面 XSS / 提供方被投毒或 MITM（若有 http）→ 页面直接调 `window.electronAPI.executeTool('bash',{command:'powershell -enc ...'})` → 无确认 RCE。
   - 待 Shard 确认：harness 侧是否有"自动执行开关/确认"设置能在主进程兜底（目前看 tool.ts 无，疑似仅渲染层 UX，可被绕过）。

## 链路 2：远程 HTTP/WS 控制（跨 D/C）
- src/remote/server.ts 绑 127.0.0.1（:244），由 CF 隧道转发公网（文件头注释）。
- token 校验：header `Authorization: Bearer <t>` 或 query `?token=`（:80-83）；**用 === 比较，非恒定时间**（时序侧信道，P3）；query token 会进访问日志/隧道日志（P3）。
- 待 Shard D 补：WS 升级是否同样校验 token（:227 有 401 分支，需确认所有路由/WS 都过 checkToken，是否有未鉴权路由）；鉴权后能否直接驱动 execute-tool/execute-command（→ 接链路1的无确认执行）。

## 链路 3：插件 → 主世界注入 / 覆盖层 eval（跨 D/C，api.ts 面）
- electronAPI 向（AI 页）暴露：injectMainWorld(`plugin-inject-main-world`,api.ts:158-160)、overlayEval(`plugin-overlay-eval`,:154)、overlayHtml(:156)、simulateMouse(:60)、webServerServe(:144)、plugin 工具/命令注册。
- 待 Shard C/D：这些 IPC 主进程侧是否校验调用方为合法插件 vs AI 页直接调用；AI 页是否可借这些通道获得比 execute-tool 更强的能力。

## 待各分片回报后我要做的交叉核对
- A 的危险命令绕过 PoC 是否覆盖 del/rd 大小写、下载投递、间接执行；与链路1合并定级。
- B 的解析器：模型输出在什么条件下触发 executeTool；是否存在"非工具普通文本也被执行"或漏执行。
- C：execute-tool/execute-js 是否对所有 sender 都无差别；projectDir 是否可被 params 覆盖越界（tool.ts:31 是 `{...params, projectDir}`，projectDir 在后覆盖 params，OK——但其它工具若读 params.projectDir 之前的字段需查）。
- D：远程鉴权后命令执行是否也无确认（与链路1合流）。
- E：渲染层是否存在"确认对话框"被伪造/被绕过（confirm 走独立窗口 confirmAPI，校验）。
