# Shard A 审计报告：安全基座与工具执行层

- 审计对象：cuckoo-code v0.9.24（Electron 44）`src/infra/**` + `src/tools/**`
- 审计方式：只读逐文件通读（42 个 TS 文件，约 5.8k 行）+ 关键发现本机 PoC 实证
- 审计日期：2026-10-17
- 审计员：Shard A 独立审计子代理
- 基线参照：`.agents/rules/README.md`、`rules/infra.md`、`rules/tools.md`、`.agents/handoff.md`（handoff 记录 test 1012 全绿、typecheck/lint 0 error）

---

## 一、审计范围与方法

### 方法
1. 先读两份清单（`audit-manifest-A1/A2.txt`）锁定 42 个必须审完的文件；
2. 再读规则基准（infra/tools/handoff）确认"预期行为"；
3. 逐文件通读全文（非抽样），沿"输入 → 执行 → 输出"链路标注疑点；
4. 对高风险疑点写 PoC 到 `.agents/audit-poc/`，在本机（Windows / Node v22.23.2）实证；
5. 对照 `test/` 下相关测试判定盲区。

### 已审文件清单（42 个，全部通读，行数取自磁盘实际）

| # | 文件 | 行数 | 通读 |
|---|---|---|---|
| 1 | src/infra/dangerous-commands.ts | 83 | ✅ |
| 2 | src/infra/decode-output.ts | 61 | ✅ |
| 3 | src/infra/eol.ts | 35 | ✅ |
| 4 | src/infra/markdown.ts | 8 | ✅ |
| 5 | src/infra/memories.ts | 175 | ✅ |
| 6 | src/infra/paths.ts | 63 | ✅ |
| 7 | src/infra/protected-paths.ts | 36 | ✅ |
| 8 | src/infra/ssrf-guard.ts | 114 | ✅ |
| 9 | src/infra/task-manager.ts | 342 | ✅ |
| 10 | src/infra/tool-error-log.ts | 106 | ✅ |
| 11 | src/infra/user-agent.ts | 95 | ✅ |
| 12 | src/infra/with-log.ts | 61 | ✅ |
| 13 | src/tools/api.d.ts | 265 | ✅（生成物，对照真源一致） |
| 14 | src/tools/browser-preload.ts | 25 | ✅ |
| 15 | src/tools/core/Tool.ts | 76 | ✅ |
| 16 | src/tools/core/ToolRegistry.ts | 99 | ✅ |
| 17 | src/tools/core/ToolResult.ts | 25 | ✅ |
| 18 | src/tools/impl/attach-file.ts | 258 | ✅ |
| 19 | src/tools/impl/bash.ts | 194 | ✅ |
| 20 | src/tools/impl/browser-window-manager.ts | 132 | ✅ |
| 21 | src/tools/impl/delete-file.ts | 93 | ✅ |
| 22 | src/tools/impl/edit.ts | 267 | ✅ |
| 23 | src/tools/impl/glob.ts | 247 | ✅ |
| 24 | src/tools/impl/goal-done.ts | 79 | ✅ |
| 25 | src/tools/impl/grep.ts | 329 | ✅ |
| 26 | src/tools/impl/inject-js.ts | 57 | ✅ |
| 27 | src/tools/impl/mcp-call.ts | 95 | ✅ |
| 28 | src/tools/impl/mcp-query.ts | 149 | ✅ |
| 29 | src/tools/impl/mysql.ts | 192 | ✅ |
| 30 | src/tools/impl/name-conversation.ts | 76 | ✅ |
| 31 | src/tools/impl/open-browser-window.ts | 68 | ✅ |
| 32 | src/tools/impl/pwsh.ts | 167 | ✅ |
| 33 | src/tools/impl/read.ts | 229 | ✅ |
| 34 | src/tools/impl/read-lines.ts | 136 | ✅ |
| 35 | src/tools/impl/remember.ts | 123 | ✅ |
| 36 | src/tools/impl/run-agent.ts | 177 | ✅ |
| 37 | src/tools/impl/snapshot.ts | 161 | ✅ |
| 38 | src/tools/impl/todo-write.ts | 162 | ✅ |
| 39 | src/tools/impl/web-fetch.ts | 196 | ✅ |
| 40 | src/tools/impl/write.ts | 136 | ✅ |
| 41 | src/tools/index.ts | 86 | ✅ |
| 42 | src/tools/runtime/JsRunner.ts | 370 | ✅ |

清单外补审：无（42 个与清单一一对应）。

---

## 二、确认 Bug（按级别排序）

### P0-1：webFetch 的 SSRF 防护可被 HTTP 302 重定向完全绕过

- **ID**：A-001
- **级别**：P0
- **类别**：安全（SSRF 防线失效）
- **位置**：`src/tools/impl/web-fetch.ts:159-162`
  ```ts
  const response = await fetch(input.url, {
    method: 'GET',
    signal: controller.signal,
  });
  ```
  配合 `src/tools/impl/web-fetch.ts:141-146`（仅在 fetch 前对 `input.url` 调一次 `assertUrlAllowed`）。
- **功能**：webFetch（开启"拒绝访问内网地址"设置后）
- **触发链路**：用户在设置里开启 SSRF 防护（`ssrfGuard === true`）→ 攻击者控制一个公网 URL（例如被 prompt injection 诱导 AI 去抓取的网页）→ 该 URL 返回 `302 Location: http://169.254.169.254/latest/meta-data/` 或 `http://127.0.0.1:<内网端口>/admin` → `assertUrlAllowed` 只校验首跳公网域名（放行）→ undici `fetch` 默认 `redirect: 'follow'`，自动跟进重定向到内网地址 → **内网/云元数据内容被取回并回传给 AI**。代码全程没有 `redirect: 'manual'`，也没有对 `response.url` 二次校验。
- **复现/PoC**：`.agents/audit-poc/poc-2-ssrf.mjs` 第三组实测——本地跳板 9901 返回 302 指向 9902 内网服务，fetch 默认跟随，最终 `response.url = http://127.0.0.1:9902/internal`，body = `INTERNAL-SECRET: ...`。
- **影响**：用户主动开启的安全防线（防内网探测/云元数据窃取）完全失效；可探测本机与内网服务、窃取云元数据（IAM 临时凭据等）。
- **置信度**：9
- **现有测试是否覆盖**：否。`test/tools/WebFetchTool.test.js` 6 个用例全部只测 `parseFetchArgs`/`formatFetchOutput` 纯函数，无任何真实 fetch/ssrfGuard/重定向用例（盲区）。
- **修复建议**：fetch 加 `redirect: 'manual'`，对 `3xx` 的 `Location` 再调一次 `assertUrlAllowed`（允许有限跳数，如 3 跳）；或全局 `redirect: 'follow'` 后对 `response.url` 复检一次。

---

### P0-2：ssrf-guard 漏判 IPv4-mapped IPv6 的十六进制写法，直连 127.0.0.1 放行

- **ID**：A-002
- **级别**：P0
- **类别**：安全（SSRF 绕过）
- **位置**：`src/infra/ssrf-guard.ts:66`
  ```ts
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  ```
- **功能**：isBlockedIpv6 / assertUrlAllowed
- **触发链路**：开启 SSRF 防护后，AI/攻击者传入 `http://[::ffff:7f00:1]/`（= `::ffff:127.0.0.1`）或 `http://[::ffff:a9fe:a9fe]/`（= `::ffff:169.254.169.254`）→ `net.isIP` 判为 family=6 → `isBlockedIpv6` 的 mapped 正则只匹配点分式 `::ffff:127.0.0.1`，十六进制形式落到后面分支全部不命中 → 返回 false → `assertUrlAllowed` 放行 → fetch 实际连到回环/链路本地地址。
- **复现/PoC**：`.agents/audit-poc/poc-2-ssrf.mjs` 第一、二组实测：
  - `isBlockedIp('::ffff:7f00:1')` → false（应 true）
  - `assertUrlAllowed('http://[::ffff:7f00:1]/')` → **放行**（应拒绝）
  - 对照组：`::ffff:127.0.0.1`（点分式）正确拦截。
  - 同组实测 WHATWG URL 已自动归一 `0x7f000001` / `2130706433` / `0177.0.0.1` → `127.0.0.1` 并被拦截（这三种不是绕过，已排除误报）。
- **影响**：无需重定向、无需 DNS，一条带方括号的 IPv6 URL 直穿 SSRF 防护访问回环/云元数据地址。
- **置信度**：8（守卫放行已实证；undici 对 `[::ffff:7f00:1]` 的实际拨号为标准行为，未单独拨号验证）
- **现有测试是否覆盖**：否。`test/infra/ssrf-guard.test.js:24` 的 blocked 列表只含点分式 `::ffff:127.0.0.1`，无十六进制 mapped 形式（盲区）。
- **修复建议**：mapped 判定改为 `net.isIP` 语义归一——先尝试把 IPv6 地址解析为 32 位整数，取低 32 位当 IPv4 校验（或用 `ip6.arpa`/标准库把 `::ffff:x.x.x.x` 与 `::ffff:hex:hex` 统一还原成 IPv4）。

---

### P1-1：protected-paths 在 Windows 上因大小写敏感比较被绕过，可写/删快照存档与 memories.json

- **ID**：A-003
- **级别**：P1
- **类别**：安全（保护防线失效 / 数据破坏）
- **位置**：`src/infra/protected-paths.ts:31-34`
  ```ts
  if (normalized === snapshotsDir || normalized.startsWith(snapshotsDir + path.sep)) { ... }
  if (normalized === memoriesFile) { ... }
  ```
- **功能**：write/edit/deleteFile 的受保护路径检查
- **触发链路**：Windows NTFS 默认大小写不敏感，但 `isProtectedPath` 用 JS 字符串 `===`/`startsWith`（大小写敏感）比较 → AI 调用 `write('C:\\Users\\X\\.cuckoo\\Snapshots\\evil.txt', ...)` 或 `write('...\\.cuckoo\\Memories.json', '[]', ...)` → 守卫判定"不在受保护路径"放行 → NTFS 实际解析到 `snapshots/` 目录与 `memories.json` 本体 → 快照存档被污染 / 用户记忆被清空篡改。
- **复现/PoC**：`.agents/audit-poc/poc-3-protected-paths.mjs` 在本机临时 CUCKOO_HOME 实测：
  - `~home\Snapshots\evil.txt` 守卫放行，实际写入 `snapshots/` 目录（列目录见 `evil.txt`）；
  - `~home\Memories.json` 守卫放行，覆盖后 `memories.json` 内容 = `"pwned"`。
- **影响**：用户"改坏可回滚"的快照安全网与长期记忆可被（prompt injection 诱导的）AI 静默破坏。
- **置信度**：9
- **现有测试是否覆盖**：否。`test/infra/protected-paths.test.js` 6 个用例全部用与源码完全相同大小写的路径（`snapshots/...`、`memories.json`），无大小写变体用例（盲区）。
- **修复建议**：比较前对两侧统一小写（Windows：`normalized.toLowerCase()`），或用 `fs.realpathSync.native` 取真实路径再比较；跨平台可按 `process.platform === 'win32'` 做。

---

### P1-2：危险命令黑名单 6 类可绕过（PowerShell 别名 / cmd 嵌套 / iex / 带值选项）

- **ID**：A-004
- **级别**：P1
- **类别**：安全（黑名单防线可绕过）
- **位置**：`src/infra/dangerous-commands.ts:20,26,39` 及 `splitShellSegments:55`
- **功能**：bash/pwsh 执行前的危险命令拦截
- **触发链路**：AI（或被注入的 AI）在 Windows 上经 `pwsh`/`bash` 执行下列命令，全部被黑名单放行（实测于 `.agents/audit-poc/poc-1-dangerous-bypass.mjs`）：
  | 输入命令 | 结果 | 绕过点 |
  |---|---|---|
  | `powershell -Command "rm -r -fo C:\Users\victim\important"` | 放行 | `rm` 是 PowerShell 里 `Remove-Item` 的别名；`-fo` 连写且目标是 Windows 路径，既不匹配 Unix `^rm\s+.../(~)` 正则，也不匹配字面 `^remove-item` |
  | `Remove-Item C:\important -Recurse` | 放行 | 正则要求 `-recurse` **与** `-force` 同时出现（dangerous-commands.ts:39），删非只读文件时 `-Force` 非必需 |
  | `cmd /c "rmdir /s C:\Windows\System32"` | 放行 | 分段后第一段是 `cmd`，不在 CMD_WRAPPERS（dangerous-commands.ts:44）里，内部命令不被二次检测 |
  | `iex "Remove-Item -Recurse -Force C:\victim"` | 放行 | `Invoke-Expression` 字符串内执行，字面 `remove-item` 不出现在段首 |
  | `rm --interactive=never -rf /` | 放行 | `(?:-[a-z-]+\s+)*` 不匹配带值选项 `--interactive=never`，选项循环中断，后面的 `-rf /` 不再被消费 |
  | `rm -r -fo C:\Users` | 放行 | 同上，Windows 路径不匹配 Unix 根目录判定 |
- **对照**：`rm -rf /`、`sudo rm -rf /`、`echo hi && rm -rf /`、`Get-ChildItem C:\; Remove-Item ... -Recurse -Force` 均正确拦截（回归项未坏）。
- **复现/PoC**：`.agents/audit-poc/poc-1-dangerous-bypass.mjs`（逐字复刻源码逻辑，10 组用例）。
- **影响**：黑名单是命令执行前唯一的自动闸门；Windows 是本项目主目标平台，pwsh 又是默认工具之一，"PowerShell 别名删目录"是最贴近真实 AI 写法的绕过。文件头注释承认了 `cmd /c` 类局限，但 PowerShell 别名这类是更实际的缺口。
- **置信度**：9
- **现有测试是否覆盖**：部分覆盖但盲区明显。`test/main/dangerous-commands.test.js` 18 个用例只测 Unix 形态与复合连接符，无 PowerShell 别名（`rm -r -fo`）、无 `cmd /c` 嵌套、无 `iex`、无带值选项（`--interactive=never`）。
- **修复建议**：不追求黑名单完美（注释已承认），但可低成本补：① `CMD_WRAPPERS` 增加 `cmd`/`powershell`/`pwsh`/`iex`/`Invoke-Expression` 等包装器剥除后二次检测；② `remove-item` 正则放宽到 `-recurse| -r`；③ 对 Windows 目标，`rm` 别名同时按 `Remove-Item` 语义再匹配一次。

---

### P1-3：JsRunner 异步死循环在超时后仍驻留主进程，Promise.race 无法取消 async IIFE

- **ID**：A-005
- **级别**：P1
- **类别**：资源泄漏 / DoS
- **位置**：`src/tools/runtime/JsRunner.ts:313`
  ```ts
  const ret = await Promise.race([script.runInContext(context, { timeout: SYNC_TIMEOUT }), deadline]);
  ```
- **功能**：AI 生成 JS 脚本的超时控制
- **触发链路**：AI 脚本写 `while(true){ await Promise.resolve() }`（纯异步微任务死循环）→ `SYNC_TIMEOUT`（30s）只对**同步**死循环生效（vm 同步超时），异步循环不触发 → 60s"无活动"deadline 触发 `Promise.race` 拒绝、`finally` 清理 settleTimer 与 sandboxTimers → **但被 race 的 async IIFE 并未被取消**，微任务循环继续在主进程事件循环里排队 → Electron 主进程事件循环被微任务饿死，所有窗口/IPC 假死。同步死循环（`while(true){}`）有 vm timeout 兜底，无此问题。
- **复现/PoC**：未实机跑（JsRunner 依赖 electron + rules/plugins 模块，实机启动成本高）；代码链路明确。属"代码证据 + Node.js vm 语义"判定。
- **影响**：被 prompt injection 的 AI 可让整个桌面应用假死，只能杀进程重启；所有会话状态丢失。
- **置信度**：7
- **现有测试是否覆盖**：否（`test/tools/JsRunner.test.js` 若有超时用例也只测同步死循环；未发现异步死循环用例——盲区）。
- **修复建议**：超时后除 race 外，无法真正中断 vm 内异步代码；可行方向：把脚本放进独立子进程（worker/utilityProcess）执行，超时直接 kill 子进程；或至少在文档层接受残余风险并对"无活动"超时做更强的隔离。

---

### P2-1：bash 工具超时/返回后，`start /b` 孙进程孤儿化，无任何跟踪与回收

- **ID**：A-006
- **级别**：P2
- **类别**：资源泄漏
- **位置**：`src/tools/impl/bash.ts:171-173`
  ```ts
  exec(trimmed, { cwd: workDir, timeout, maxBuffer: 1024*1024, windowsHide: true, encoding: 'buffer' }, ...)
  ```
- **功能**：bash 命令执行
- **触发链路**：AI 调 `bash('cmd /c start /b ping -n 30 127.0.0.1')`（或任何 `start /b` / 后台派生命令）→ `exec` 的 cmd 父进程立即退出，工具向 AI 返回"成功"→ `ping.exe` 脱离父进程继续跑，既不在 task-manager（该路径没走 `startBackgroundTask`）、也没有 pid 记录 → 系统残留进程。同理，普通命令触发 timeout 时 Node 只 kill cmd.exe 本体，孙进程不连带死。
- **复现/PoC**：`.agents/audit-poc/poc-4-orphan-child.cjs` 实测：`exec` 回调后 0.5s，系统里 `PING.EXE (PID 24260)` 仍存活（脚本已自动清理）。
- **影响**：高频使用后台命令的用户会累积孤儿进程；`task-manager.ts` 的 `/T` 杀进程树只覆盖 `background:true` 路径，普通 exec 路径无此保护。
- **置信度**：8
- **现有测试是否覆盖**：否。`test/tools/BashTool.test.js` 不涉及进程树/孤儿验证。
- **修复建议**：bash 工具对已知会派生孙进程的场景提示 AI 用 `background:true`（有 taskkill /T）；或 exec 改用 `spawn` + `detached:false` + 退出时显式 `taskkill /pid <child.pid> /T /F`。

---

### P2-2：read / readLines / edit 无文件大小上限，`readFileSync` 整个载入内存

- **ID**：A-007
- **级别**：P2
- **类别**：边界条件 / 资源
- **位置**：`src/tools/impl/read.ts:225`、`src/tools/impl/read-lines.ts:113`、`src/tools/impl/edit.ts:244`
  ```ts
  const content = fs.readFileSync(resolvedPath, 'utf-8');   // read.ts:225
  ```
- **功能**：文件读取/编辑
- **触发链路**：AI 对一个 2GB+ 的日志/数据文件调 `read`（或 `readLines`/`edit`）→ 代码注释（read.ts:224）自述"读取整个文件内容"→ `readFileSync` 全量读入 → V8 堆压力激增，主进程 OOM 被系统杀掉。`READ_MAX_BYTES=50KB` 只约束输出窗口，不约束读入量。
- **复现/PoC**：未实测构造 2GB 文件；代码路径明确。
- **影响**：误操作大文件即可搞崩整个应用（主进程 OOM）。
- **置信度**：8
- **现有测试是否覆盖**：否（`test/tools/ReadTool.test.js` 用小文件）。
- **修复建议**：读前 `statSync` 取 `size`，超过阈值（如 200MB）拒绝并提示用 offset/分页或 shell 流式处理。

---

### P2-3：ssrf-guard 的 DNS 解析校验与实际连接存在 TOCTOU / DNS rebinding 窗口（代码注释已承认）

- **ID**：A-008
- **级别**：P2
- **类别**：安全（已知局限）
- **位置**：`src/infra/ssrf-guard.ts:106-120`
- **功能**：assertUrlAllowed 域名解析校验
- **触发链路**：恶意域名 TTL=0，第一次 `dns.lookup` 返回公网 IP（过校验），fetch 连接瞬间 DNS 解析返回 127.0.0.1 → 连到内网。文件头注释（ssrf-guard.ts:10-12）已自述此局限。
- **复现/PoC**：未联网搭建 rebinding 环境（需权威 DNS）。
- **影响**：理论可绕过 SSRF 防护；实际利用门槛高（需控制权威 DNS）。
- **置信度**：6（推测区外，但属已知设计局限，列 P2 跟踪）
- **现有测试是否覆盖**：否。
- **修复建议**：彻底方案是把已解析 IP 固定到连接层（undici custom dispatcher / agent），注释已列为后续增强。

---

### P3-1：memories.ts 并发 read-modify-write 丢更新

- **ID**：A-009
- **级别**：P3
- **类别**：并发竞态
- **位置**：`src/infra/memories.ts:124-142`
- **触发链路**：JS 脚本内并行两次 `remember()` → 两次 `listMemories()` 都读到旧数组，各自 push 后 `saveMemories` 覆盖写 → 后写覆盖先写，一条记忆丢失。
- **置信度**：8
- **修复建议**：内存内串行化 saveMemories（简单 promise 队列）。

### P3-2：decodeOutput 把含 U+FFFD 的合法 UTF-8 误判为 GBK 二次解码

- **ID**：A-010
- **级别**：P3
- **类别**：数据正确性
- **位置**：`src/infra/decode-output.ts:36-44`
- **触发链路**：命令输出本身是合法 UTF-8 但中间已含 U+FFFD 字符（例如文件里就有替换符）→ 被误判为"不是合法 UTF-8"→ 回退 GBK 解码 → 输出乱码更重。
- **置信度**：7
- **修复建议**：用"严格 UTF-8 解码是否抛错"判断，而非"结果里是否含 U+FFFD"。

### P3-3：normalizeCommand 会替换字符串字面量里的 `Get-Content`

- **ID**：A-011
- **级别**：P3
- **类别**：数据正确性
- **位置**：`src/infra/decode-output.ts:63`
  ```ts
  return command.replace(/Get-Content\b/g, 'Get-Content -Encoding UTF8');
  ```
- **触发链路**：AI 写 `powershell -c "Write-Host 'default Get-Content behavior'"` → 字符串内的 `Get-Content` 也被替换成 `Get-Content -Encoding UTF8`，改变命令语义（一般无安全后果，仅输出变化）。
- **置信度**：8
- **修复建议**：只替换"作为命令调用"的 Get-Content（前导空白/行首），或用 AST/分词。

### P3-4：tool-error-log 把 mysql 密码明文写入开发日志

- **ID**：A-012
- **级别**：P3
- **类别**：安全（本地敏感信息）
- **位置**：`src/infra/tool-error-log.ts:85`（`safeStr(args)` 全量记录工具参数）
- **触发链路**：mysql 工具失败时，`args` 含 `password` → 被整体追加到 `<userData>/wyp/log/tool-errors/mysql.log`。仅开发版写（`enabled()` 判断 `!app.isPackaged`），本地文件，影响有限。
- **置信度**：8
- **修复建议**：写日志前对 args 里的 `password`/`secret`/`token` 字段打码。

### P3-5：grep 先全量收集所有匹配再截断，超大结果集内存爆炸

- **ID**：A-013
- **级别**：P3
- **类别**：性能 / 资源
- **位置**：`src/tools/impl/grep.ts:322-332`
- **触发链路**：AI 用极宽正则（如 `.` 搜大仓库）→ rg --json 输出数十万行 → `parseGrepMatches` 全部 parse 进 `all` 数组后才 `slice(0, 250)` → 内存峰值 = 全量结果。
- **置信度**：7
- **修复建议**：流式 parse，攒够 250 条即停（kill child 或忽略后续）。

### P3-6：glob 的 spawn 未加 `--no-config`（grep 加了）

- **ID**：A-014
- **级别**：P3
- **类别**：一致性
- **位置**：`src/tools/impl/glob.ts:113-116` vs `src/tools/impl/grep.ts:118`
- **说明**：grep 的 runRipgrep 显式 `['--no-config', ...args]`，glob 没有。RIPGREP_CONFIG_PATH 环境变量或 home 目录配置可影响 glob 结果。低危。
- **置信度**：7

### P3-7：todoWrite 把列表写到主进程 `globalThis.__cuckooTodos`，跨窗口共享且无持久化

- **ID**：A-015
- **级别**：P3
- **类别**：UX / 状态隔离
- **位置**：`src/tools/impl/todo-write.ts:159-160`
- **说明**：多窗口并行时 todo 互相覆盖。
- **置信度**：8

### P3-8：task-manager Windows stop 忽略 taskkill 返回值 + pid 复用 TOCTOU

- **ID**：A-016
- **级别**：P3
- **类别**：健壮性
- **位置**：`src/infra/task-manager.ts:281`
- **说明**：taskkill 回调 `() => {}` 忽略结果；进程已退出后 OS 复用 pid 时，`/T /F` 可能误伤新进程（窗口极小）。
- **置信度**：6

---

## 三、推测区（置信度 ≤ 6，未实证，仅记录待查）

| 编号 | 内容 | 置信度 |
|---|---|---|
| S-1 | JsRunner vm 沙箱是否存在未知逃逸：已审 `codeGeneration:{strings:false,wasm:false}`、`Object.setPrototypeOf(sandbox,null)`、hostBridge 原型截断、JSON 序列化跨域，未发现具体逃逸路径；但 Node vm 历史 CVE 多，建议升级到 utilityProcess 隔离（与 P1-3 修复方向一致）。 | 5 |
| S-2 | browser-window-manager `new Function('return ('+jsCode+')')` 语法探测在主进程编译代码：只编译不执行，未发现注入面；但"编译即执行副作用"取决于 V8 版本，未深入验证。 | 5 |
| S-3 | attach-file `document.querySelector('input[type=file]')` 取第一个文件输入框：若页面有多个 file input，可能附错位置（UX），非安全问题。 | 6 |
| S-4 | mysql 工具未设置语句超时（只有 connectTimeout），AI 跑一个慢查询会挂住连接直到 Node 默认 10min。 | 6 |
| S-5 | open-browser-window 经 `restOptions` 展开任意 BrowserWindow 选项：当前调用方（open-browser-window.ts）只传 width/height，无实际注入面；若未来有别的调用方传用户输入，需复查。 | 5 |

---

## 四、本片测试盲区清单（测试说"全绿"但没覆盖到的地方）

1. `test/tools/WebFetchTool.test.js`：无真实 fetch / ssrfGuard / 重定向 / IPv6-mapped 用例 → A-001、A-002 的温床。
2. `test/infra/ssrf-guard.test.js`：blocked 列表只有点分式 IPv6-mapped，无十六进制 mapped；无 redirect 复检。
3. `test/infra/protected-paths.test.js`：全部用与源码同大小写的路径，无 Windows 大小写变体。
4. `test/main/dangerous-commands.test.js`：无 PowerShell 别名（`rm -r -fo`）、`cmd /c` 嵌套、`iex`、带值选项绕过。
5. `test/tools/BashTool.test.js`：无超时/孙进程孤儿化验证。
6. `test/tools/JsRunner.test.js`：无"异步死循环超时后是否驻留"用例。
7. `test/tools/ReadTool.test.js` / `EditTool.test.js`：无超大文件读入验证。
8. mysql / tool-error-log：无"密码打码"相关用例。

---

## 五、PoC 清单与运行结果（全部本机实测通过）

| 脚本 | 路径 | 对应 Bug | 结果摘要 |
|---|---|---|---|
| poc-1-dangerous-bypass.mjs | `.agents/audit-poc/` | A-004 | 10 组用例：6 类绕过复现，4 类回归项仍正确拦截 |
| poc-2-ssrf.mjs | `.agents/audit-poc/` | A-001、A-002 | `::ffff:7f00:1` 守卫放行；302 跳转后 fetch 拿到内网 secret body |
| poc-3-protected-paths.mjs | `.agents/audit-poc/` | A-003 | `Snapshots/evil.txt` 实际写入受保护目录；`Memories.json` 被覆盖为 "pwned" |
| poc-4-orphan-child.cjs | `.agents/audit-poc/` | A-006 | exec 回调后 0.5s PING.EXE(PID 24260) 仍存活，已自动清理 |

未联网查证 CVE（代理状态未验）；PoC 全部基于本机 Node v22.23.2 + Windows NTFS 实测。

---

## 六、汇总

- P0：2 条（A-001 SSRF 重定向绕过、A-002 IPv6-mapped 十六进制绕过）
- P1：3 条（A-003 受保护路径大小写绕过、A-004 危险命令黑名单 6 类绕过、A-005 JsRunner 异步死循环驻留）
- P2：3 条（A-006 孙进程孤儿、A-007 大文件全量读入、A-008 DNS rebinding TOCTOU）
- P3：8 条（A-009 ~ A-016）
- 推测区：5 条（S-1 ~ S-5）
