# 最新接续状态 (2026-11-24 需求 131 API Key 直连 v0.10.239)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`master`
> 当前版本：`0.10.239`（版本号任意位置禁含数字 4）

---

### 发版结果（已核验）

- 需求 131 实现提交 `f4ab41e`（`feat(api): 新增 API Key 直连与多会话管理 (v0.10.238)`），tag `v0.10.238` 已发布。
- **v0.10.238 安装包启动崩溃 `Cannot find module 'sharp'`**：`sharp` 误放 `devDependencies`，打包时未进入安装包；已由 `a46db85` 修复并发布 `v0.10.239`。
- 修复提交 `a46db85`（`fix(release): 修复 sharp 打包缺失并收敛平台选择 (v0.10.239)`），tag `v0.10.239` 已推送；Build and Release 全部 success。
- Release `v0.10.239` 资产：`cuckoo-code-win-v0.10.239.exe`(217,887,700 字节)、`cuckoo-remote-android-v0.10.239.apk`(29,860,665 字节)、`latest.yml`。
- 全量门禁：`npm test` 168 文件 / 1672 用例通过；`npm run typecheck`、`npm run lint`（0 error / 75 warnings）、`npm run compile` 通过。
- 本地打包验证：`dist/win-unpacked` 内 `app.asar.unpacked/node_modules/sharp`、`@img/sharp-win32-x64` 均在；用打包后的 `attachments.js` 实际物化测试图片成功（`data:image/png;base64,...`）。
- 推送环境：本机 VPN `127.0.0.1:51081` 开启时默认代理可用；GitHub 直连此前会被 reset。



## 0. 总览

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| 130 preload 控制台日志降噪 | ✅ 已发布 v0.10.237 | 生产静默 log/info/debug；开发态 `--cuckoo-debug` 保留；8 条单测 + Electron 探针 + dev 实跑；本机已安装 0.10.237，待 Console 验收 |
| 129 Chrome UA-CH 品牌 GREASE / 顺序 | ✅ 已发布 v0.10.233 | 单测 14 条 + Electron CDP 探针；真机已验证 brands/headers |
| 127 登录/运行环境特征修复（阶段 1+2） | ✅ 已发布 v0.10.232 | 四门禁全绿；登录页探针通过，完整 app 待回归 |
| 128 长暂停结束后的发送状态顺序 | ✅ 已发布 v0.10.232 | 153 文件 1556 用例全绿；真机三帧顺序待复验 |
| 纯净模式初始化投递 / 焦点隔离 / 附件链路 修复 | ✅ 已发布 v0.10.231 | 长度校验归一化 + 发送前闸门 + 停止宽限轮询 |
| 125 技能/MCP 菜单删除 + 子代理卡片展开修复 | ✅ 已发布 v0.10.230 | 后端白名单删除 + 事件委托；四门禁全绿，CI coverage 修复 |
| 124 手机端宠物延迟状态同步 | ✅ 已发布 v0.10.229 | 补齐 send-pause 上报链路 + 宠物 pausing/waiting 映射；四门禁全绿 |
| 123 提示词/回填 4 万字上限防护 | ✅ 已发布 v0.10.229 | 36k 总预算 + 四级降级；回填 26k 总预算 + 头尾截断 |
| 122 系统提示词工具段去重 | ✅ 已发布 v0.10.228 | 工具段 18,029 → 15,036（省 2,993） |
| 121 纯净模式代码块增强 | ✅ 已发布 v0.10.227 | |
| 120 CHANGELOG 按月拆分 | ✅ 已合并 master | |

---

## 0C. 需求 130（v0.10.237 已发布）

详见 `docs/requirements/130-preload-console-noise.md`。

- **背景**：v0.10.233 已把 `brands` 修对，但用户打开 DevTools 仍看到 `[Cuckoo Code]` 普通日志，误以为旧版没退出。已确认安装包版本 0.10.233、进程启动时间晚于安装时间。
- **改动**：新增 `src/bridge/console-filter.ts`；`console-filter-install.ts` 作为 preload 最早副作用 import；生产静默 `log/info/debug`，保留 `warn/error`；页面主世界日志不受影响。开发态由主进程经 `additionalArguments` 传 `--cuckoo-debug`（`src/app/bridge-args.ts`），preload 读 `process.argv` 保留日志；`CUCKOO_DEBUG` 真值大小写归一化。
- **验证**：`console-filter` 5 条 + `bridge-args` 3 条单测；全量 155 文件 1569 用例通过；Electron 隔离探针确认 preload 的 log/info 被静默、warn/error 保留、页面 `PAGE_LOG/PAGE_WARN` 正常；`npm run dev` 实跑确认开发态日志恢复。
- **残余**：打开 DevTools 仍可能被 debugger 计时探测；本需求只降噪。
- **本机状态**：`D:\cuckoo-code\resources\app.asar` 已升级到 `0.10.237`；已核验安装包内 `bridge-args`、`console-filter`、preload 最先 import 过滤器的链路都在。剩余只差在 AI 页面打开 Console 做最终肉眼验收。

## 0D. 需求 131 API Key / OpenAI 兼容接入（v0.10.238 已发布）

详见 `docs/requirements/131-api-key-transport.md`。

- **目标**：在平台列表新增独立 `API Key / OpenAI 兼容` transport；只影响 API 平台，网页 Provider、窗口自动化、DeepSeek SSE 解析、129/130 修复全部不动。
- **实现**：内置 `api-key` Provider；按 profile 隔离 Base URL/Key/模型；系统提示词复用现有规则/技能/记忆/MCP；token 预算裁剪；图片/文本附件落盘后物化；原生 `tool_calls` 复用 ToolRegistry 权限闸；API 多会话与 history/plan/goal 按 profile+session 隔离。
- **实测（2026-11-24）**：Agnes 官方 `/v1/chat/completions` 直连支持图片与工具调用；给 `read` 工具后返回 `finish_reason=tool_calls`、工具名 `read`。API 模式可用 Agent 工具循环；`runAgent/runAgents` 与网页自动化仍按设计排除。
- **状态**：代码、测试、真机验证完成；已合入 `v0.10.238` 并推送 tag。

## 0E. v0.10.239 发布修复（已发布）

- **现象**：v0.10.238 自动安装后主进程启动即弹 `Cannot find module 'sharp'`，整个应用无法进入。
- **根因**：`sharp` 在 `devDependencies`，electron-builder 打包生产依赖时把它排除；`attachments.ts` 又在模块顶层 `require('sharp')`，主进程加载即崩。
- **修复**：`sharp` 移入 `dependencies`；`asarUnpack` 增加 `**/node_modules/sharp/**` 与 `**/node_modules/@img/**`；`attachments.ts` 改为延迟加载，缺失时只降级图片物化，不阻断启动。
- **平台选择**：新建窗口只展示 DeepSeek 与 API Key；Claude / ChatGPT 保留在 registry 供旧窗口兼容，不再出现在选择页。
- **验证**：168 文件 / 1672 用例；typecheck、lint、compile 全绿；本地 `win-unpacked` 已确认 sharp 原生模块解包，打包后的 `attachments.js` 实际生成图片 data URL 成功。
- **发布**：`a46db85` + tag `v0.10.239`，GitHub Actions 全部 success；资产 `cuckoo-code-win-v0.10.239.exe`、`cuckoo-remote-android-v0.10.239.apk`、`latest.yml`。
- **注意**：v0.10.238 启动即崩，内置 updater 无法运行；需手动下载安装 v0.10.239 一次，之后自动更新恢复。

## 0B. 需求 129（v0.10.233 已发布）

详见 `docs/requirements/129-ua-ch-brand-grease.md`。

- **现象**：DeepSeek 页面 DevTools 里 `brands` 只有 `Not?A_Brand` + `Chromium`，缺 `Google Chrome`；控制台已打印「主世界指纹修正已注入」。
- **根因 1**：`Not_A Brand` 和品牌顺序写死；Chrome 152 真值是 `Not?A_Brand` 24，顺序 `[Chromium, Not?A_Brand, Google Chrome]`。按 Chromium GREASE 算法改为随 `process.versions.chrome` 计算，`Sec-CH-UA` / `userAgentMetadata` / JS 补丁三处共用。
- **根因 2**：`applyUad()` 见原生 `brands` 已含 `Google Chrome` 就跳过安装 getter；CDP 在 DevTools 打开时 detach，原生值重新露出。现改为无论原生是否含 `Google Chrome` 都安装补丁。
- **根因 3**：高熵只补 `fullVersionList`，不补 `r.brands`，且会给未请求的调用凭空加 `fullVersionList`。现两者都按响应自有字段修正，不再新增未请求字段。
- **验证**：`test/infra/user-agent.test.js` 14 条全绿；Electron 探针在注入 / CDP override / detach 三个阶段都返回 `[Chromium 152, Not?A_Brand 24, Google Chrome 152]`，且 `getHighEntropyValues(['platformVersion'])` 不含 `fullVersionList`。待用户真机复验。
- **残余**：打开 DevTools 本身仍可能被 debugger 计时探测；控制台日志非本次根因，生产静音未做。

## 0A. 需求 127 阶段 1+2（v0.10.232 已发布）

详见 `.agents/plan-登录环境与运行环境异常修复.md` v3 与 `docs/requirements/127-env-fingerprint-hardening.md`。

- **A1**：AI view `webPreferences.plugins: true`，补 `navigator.plugins`。
- **A5**：`user-agent.ts` 脚本内 WeakMap + 全局 `Function.prototype.toString` 补丁；`getBrands` / `getHighEntropyValues` / `getWd` 统一 `markNative`。
- **B2**：`maskAsNative` 不再无条件加自有 `toString`；10 个 hook 包装函数改对象方法简写（去 `prototype`）。
- **B1**：删 `__cuckooFpInjected` / `__cuckooShieldInjected`；`CdpState` 按「文档代次 + 脚本全文」幂等，`did-navigate` 调 `resetNetIdentityDoc`。同文档配置变更仍会重新 `evaluate`，不会漏新盾。
- **阶段 2（P0）**：新增 `src/bridge/auth-page.ts`；`entry.ts` 的 hook 注入改为 `injectProviderHook()`（顶层执行但先判 auth），`init()` 加 `overlayInitialized` + auth 守卫，`watchAuthExit()` 用 Navigation API/popstate/hashchange + 1.5s 轮询，不 patch history。登录页不跑 overlay/插件/监听器，登录后补注入。`/sign_in`、`/signup`、微信/Google 登录页已覆盖。
- **阶段 2（P1-B）**：`platformVersion` 改读 Windows 注册表 `Windows.Foundation.UniversalApiContract`（与 Chromium `GetUniversalApiContractVersion()` 同源），缓存一次；失败才按 build 兜底。本机 22631 编译产物实测 `15.0.0`。
- **阶段 2（P1-A）否掉**：真 Chrome 实测 `window.hasOwnProperty('fetch')=true`、`Window.prototype.hasOwnProperty('fetch')=false`；任务书说反，不改。
- **验证**：typecheck ✓ / 153 文件 1556 用例 ✓ / lint 0 error ✓ / compile ✓ / docs:index 114 需求 ✓。新增 auth 判定 6 条、auth 接线 3 条、platformVersion 映射/注册表解析 3 条。真实 preload 探针：`/sign_in` overlayIds=0 且无 hook 注入日志；正常页 overlayIds=6 且 hook 成功；同文档 pushState 退出 auth 后 2s 内 overlay 补上。
- **未做**：真机回归；A2/A4/B3/B4/C/D 未动；登录页同源 `localStorage` 的 `cuckoo-*` 历史键仍在。`window.fetch` 是 `window` 自有属性，已实测与真 Chrome 一致。同文档 SPA 从正常页进入 auth 时已注入的 hook 无法撤回；auth 作为文档入口、auth 退出补注入均已验证。
- **附带修复 128（真机测试中发现）**：长暂停结束后宠物先「生成中」后「结果发给模型」。根因是 `tool-end` 为保活 sendTick 把 `generating` 置 true，暂停结束 `syncPet()` 命中生成分支；且 `harness-bridge` 先报 `ai-state` 再报 `framework-send`。已改为暂停结束先显示「正在发送…」+ 宠物 waiting/「把结果发给 AI…」，bridge 先报 `framework-send` 再报 `ai-state`。新增 2 条回归用例，四门禁全绿（153 文件 1556 用例），真机待复验。详见 `docs/requirements/128-harness-send-state-order.md`。

## 1. 最近一轮改动（纯净模式投递/焦点/附件，v0.10.231）

详见 `.agents/plan-纯净模式投递焦点附件修复.md`（含根因、逐文件改动、未覆盖风险）。

**三个用户现象 → 三条根因**（证据：`%APPDATA%\cuckoo-ai-pro-session\wyp\log\volcengine.log` 03:31 段、`temp_log.txt` 11-11 段）：

1. **初始化提示词空转 5.37s**：`chat-input.ts` 的 `waitMs = tag === 'harness' ? 4000 : 0`，系统提示词等待窗口为 0，靠外层 500ms×30 硬重试；且 `project-context.ts` 在「下发」时就发 `framework-send('系统提示词')`，界面立刻显示「已发送，等待 AI 响应」。现：冷启动首次 10s 就绪窗口、重试收敛 8 次、`alreadyFilled` 幂等跳过重复灌注、提前事件改 `framework-preparing`（界面显示「正在准备…」，不建空气泡）。
2. **附件偶发失败 + 两份**：`cdp-attach` 已 `setFileInputFiles` 成功但 12s 内没认出缩略图时返回 `success:false` → `harness-attach` 无条件 `attachFn` 兜底再注入一次。现：`AttachResult.injected` 契约（`injected:true` 一律不再兜底）+ `attachFn` 同名附件幂等守卫（查输入框向上 12 层、跳过可编辑元素）+ file input 打 `data-cuckoo-attach-input` 标记，用「站点已清空该 input」作通用就绪信号 + UI 附件超时改 `20000 + 18000 * files.length`。
3. **打字串进原版输入框**：纯净模式**没有真正隐藏** AI 网页（`entry.ts` 保持 `setVisible(true)`，只把 bounds 移到 -20000），所以仍可被 focus。三条抢焦点路径：`renderer.ts` 的 `chat-insert-text` 注入前 `sender.focus()`、`harness.ts` 停止后 `wc.focus()`、`project-context.ts` 选目录后 `view.webContents.focus()`。现：`renderer.ts` 新增 `isHarnessActive()`（读 `win.__ckHarnessVisible`），纯净模式下两条注入 IPC 直接返回 false；`stopGeneration` 纯净模式不聚焦、Escape 改页面内合成 `KeyboardEvent`；选目录后焦点优先给 harness；`chat-input` 只在 `document.hasFocus()` 时才走 `insertTextToChat` 且才 `input.focus()`。

**验证**：typecheck 0 错 / 151 文件 1538 用例 ✓（新增 3 条 `chat-input.test.js` 用例）。中途一次回归：把非系统提示词统一提到 1200ms 导致 `observer.test.js` 超时，已回退为 0ms。

**真机验证（已完成）**：初始化提示词 1 秒内发出；附件上传不再报 Upload failed；停止能在按钮切换后点中。**遗留**：附件链路仍依赖 `webContents.debugger`，单测无法覆盖，回归靠真机日志（`stopGeneration 定位结果` / `CDP 上传结果` / `附件就绪`）。

## 1A. 需求 125（v0.10.230）

详见 `docs/requirements/125-skill-mcp-menu-delete.md`。

**三件事**：① 技能/MCP 菜单补删除；② 子代理卡片完成后点击不展开；③ CI（coverage / ubuntu）稳定失败。

**③ CI 根因**：`src/skills/prompt.ts` 用平台相关的 `path.dirname/relative`，Linux 把 `C:\root\w\SKILL.md` 当单段文件名，输出带反斜杠。现统一 `toPosix` + `path.posix`，`posix.dirname('')` 的 `'.'` 归一为空串。

**② 展开根因（两处）**：`harness.html` 逐卡 `addEventListener`，历史恢复/动态补卡会丢监听；点击守卫用「当前有没有选区」，而 `.tool-head` 是 `user-select:none`，点它不清旧选区 → 后续点击全被吞。现改 `#stream` 统一委托（`closestIn` 手工上溯兼容 SVG）+ `mousedown` 选区快照；`agents.ts` 运行中卡片同款守卫。

**① 删除能力**：技能走 `src/skills/delete-guard.ts` 白名单（绝对路径 / 直接子目录 / 含 SKILL.md / 非软链）+ `shell.trashItem` 回收站（失败直接报错，不降级 rm -rf）；MCP 按 `source` 精确删（`removeServer(name, projectDir)` 返回实际作用域）+ `disconnectServerByName` 单点断连（不再 `disconnectAll` 掐别的项目）。

**验证**：typecheck ✓ / 151 文件 1535 用例 ✓ / lint 0 error 73 warning ✓ / compile ✓ / docs:index 112 需求 ✓；真实 `~/.agents/skills` 白名单实测通过。

## 1B. 需求 124（v0.10.229）

详见 `docs/requirements/124-mobile-pet-delay-sync.md`。

**用户报告**：手机端宠物没同步"随机延迟"相关状态。

**根因（两处，都不在渲染层）**：
- `src/bridge/remote-bridge.ts` 从未订阅 `onSendPause` → 30~75s 随机长暂停事件根本没到手机端；
- `src/remote/pwa/app.js` 的 `onToolEvent` 在 `sending`（工具跑完的 6~16s 回传延迟）分支不调 `petEvent` → 宠物停在 `working`。

**改动（6 处，净新增约 60 行）**：
- `remote-bridge.ts`：新增 `onSendPause` 订阅 → `report({type:'send-pause', active, durationMs})`，带 enabled 门控（与 `onToolCall` 同款）；
- `app/ipc/remote.ts`：`remote-report` handler 加 dispatch 分支；
- `remote/manager.ts`：新增导出 `onSendPause`，广播带 `profileId`（多窗口隔离）；
- `remote/pwa/app.js`：`sending` 分支补 `petEvent('waiting')`；新增 `case 'send-pause'`——active=true 先 `stopSendTick`（`SEND_TICK_MAX_MS` 45s 硬超时挡不住 75s 暂停）+ `stopToolTick`（防多工具交错覆盖文案）再显示暂停文案；active=false 走收尾四件套对齐 `ai-stop`；
- `remote/pwa/mobile-pet.js`：`MOOD_BY_STATE` 增 `pausing`；`waiting`/`pausing` 均 `setState('idle')` 只换情绪组（与 `pet-window.html` 映射一致）。

**复用而非新造**：情绪文案用 `pet.js` 的 `MOODS.pausing`；事件源用 `chat-input.ts` 的 `onSendPause`；管道用既有 `report → remote-report → broadcast → handleServerMessage`。

**测试**：新增 `test/remote/mobile-pet.test.js`（10 用例，vm 跑真实适配层源码，5 条失败路径）+ `test/remote/pwa-app-pet.test.js`（5 用例接线守卫）。四门禁：typecheck 0 错 / 150 文件 1526 用例 / lint 0 error / compile 通过。

**未做**：真机验证（由用户自行完成）。

**已知遗留（不夹带）**：
- 手机端生成中映射 `thinking`，桌面内嵌宠物用 `writing`、桌面浮窗用 `thinking`——桌面端自身两处就不统一，需单独评估对齐哪一边。
- 手机端宠物不显示功能状态文案（工具运行中 Ns 等），由 `exec-status` 胶囊承担，属既有窄屏取舍（`mobile-pet.js` 文件头有说明）。

---

## 1C. 需求 123（同版本发布，v0.10.229）

详见 `docs/requirements/123-prompt-budget.md`。

- `prompt-builder.ts`：总预算 36,000 字符 + 4 级降级；分段上限 CUCKOO.md 6,000 / 规则 7,000 / 技能 4,000 / 子代理 1,200 / 记忆 2,500 / DSH 3,000；工具契约永不裁剪。
- `overlay/result-budget.ts`：单条 15,000，多段按 26,000 均分；截断改头尾保留（65/35）+ 自救标记。
- `infra/text-clip.ts`：头尾截断共用实现；`JsRunner` 的 20,000 源头截断同步改为头尾保留。
- `chat-input.ts`：发送前 39,000 硬拦截；DOM 回退读回长度校验。

**未做**：真机 `npm start` 验证首条提示词完整填入、无长度告警。

---

## 2. 待办

- **v0.10.231 真机验证（优先）**：① 新建对话，观察 harness 状态先显示「正在准备…」再切换，日志确认 `initial-prompt` 到「已点击发送按钮」间隔不再有 4~5 次「找不到输入框」；② 纯净模式连续上传 2~3 张图，日志里 `CDP 上传结果` 带 `injected:true` 且每个文件只出现一条上传结果，页面只出现一份附件；③ 纯净模式输入框连续打字 + 中途点停止生成，确认字不再串进原版输入框。
- **需求 124 真机验证**：手机端连远程后，触发一次工具循环，确认「延迟发送」期间宠物切到「等出字」类文案；确认随机长暂停期间宠物显示「走个神 / 去倒杯水」等，执行条显示「随机长暂停中 约 Ns…」。
- **需求 123 真机验证**：新建对话确认首条提示词完整填入；多段工具结果确认总长度与截断提示。
- **真机验证待补（v0.10.222）**：启用代理/指纹时附件通道恢复需真机复验（v0.10.223 已改 `shouldAttach` 纯文本恒 false，前提已变）。
- **附件失败静默降级**：建议至少记录显式告警。

## 3. 已知限制

- `changelogs/2026-10.md` 2716 行，超 `readLines` 默认 2000 行上限。查历史用 `node scripts/changelog-locate.mjs <ver>`。
- `changelogs/2026-11.md` 等历史文件里存在非标准分类（如「### 优化」「### 变更」，0.10.226 及更早），新条目一律用 Keep a Changelog 标准六类。

## 4. 环境注意

- 探针脚本（`temp_probe_*.mjs`）已被 `.gitignore` 忽略。
- 全局 `~/.agents/rules/rule.md` 不在项目 git 内，换机器需手动同步。
- `android/app/src/main/assets/public/` 是 PWA 构建产物的副本，被 `android/.gitignore:98` 忽略；改 `src/remote/pwa/` 后无需手动同步（Android 构建时复制）。
