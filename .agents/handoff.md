# 最新接续状态 (2026-11-22 v0.10.231 待发版)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`feat/126-volcengine-web-integration`（与 master 同 commit `fded1b1`；126 的 volcengine 改动已全部撤回，`git ls-files | grep volcengine` 无结果）
> 当前版本：`0.10.231`（版本号任意位置禁含数字 4）

---

## 0. 总览

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| 纯净模式初始化投递 / 焦点隔离 / 附件双发 修复 | 🟡 代码完成，待真机验 + 提交 | v0.10.231；typecheck ✓ 1538 用例 ✓ |
| 125 技能/MCP 菜单删除 + 子代理卡片展开修复 | ✅ 已发布 v0.10.230 | 后端白名单删除 + 事件委托；四门禁全绿，CI coverage 修复 |
| 124 手机端宠物延迟状态同步 | ✅ 已发布 v0.10.229 | 补齐 send-pause 上报链路 + 宠物 pausing/waiting 映射；四门禁全绿 |
| 123 提示词/回填 4 万字上限防护 | ✅ 已发布 v0.10.229 | 36k 总预算 + 四级降级；回填 26k 总预算 + 头尾截断 |
| 122 系统提示词工具段去重 | ✅ 已发布 v0.10.228 | 工具段 18,029 → 15,036（省 2,993） |
| 121 纯净模式代码块增强 | ✅ 已发布 v0.10.227 | |
| 120 CHANGELOG 按月拆分 | ✅ 已合并 master | |

---

## 1. 最近一轮改动（纯净模式投递/焦点/附件，v0.10.231）

详见 `.agents/plan-纯净模式投递焦点附件修复.md`（含根因、逐文件改动、未覆盖风险）。

**三个用户现象 → 三条根因**（证据：`%APPDATA%\cuckoo-ai-pro-session\wyp\log\volcengine.log` 03:31 段、`temp_log.txt` 11-11 段）：

1. **初始化提示词空转 5.37s**：`chat-input.ts` 的 `waitMs = tag === 'harness' ? 4000 : 0`，系统提示词等待窗口为 0，靠外层 500ms×30 硬重试；且 `project-context.ts` 在「下发」时就发 `framework-send('系统提示词')`，界面立刻显示「已发送，等待 AI 响应」。现：冷启动首次 10s 就绪窗口、重试收敛 8 次、`alreadyFilled` 幂等跳过重复灌注、提前事件改 `framework-preparing`（界面显示「正在准备…」，不建空气泡）。
2. **附件偶发失败 + 两份**：`cdp-attach` 已 `setFileInputFiles` 成功但 12s 内没认出缩略图时返回 `success:false` → `harness-attach` 无条件 `attachFn` 兜底再注入一次。现：`AttachResult.injected` 契约（`injected:true` 一律不再兜底）+ `attachFn` 同名附件幂等守卫（查输入框向上 12 层、跳过可编辑元素）+ file input 打 `data-cuckoo-attach-input` 标记，用「站点已清空该 input」作通用就绪信号 + UI 附件超时改 `20000 + 18000 * files.length`。
3. **打字串进原版输入框**：纯净模式**没有真正隐藏** AI 网页（`entry.ts` 保持 `setVisible(true)`，只把 bounds 移到 -20000），所以仍可被 focus。三条抢焦点路径：`renderer.ts` 的 `chat-insert-text` 注入前 `sender.focus()`、`harness.ts` 停止后 `wc.focus()`、`project-context.ts` 选目录后 `view.webContents.focus()`。现：`renderer.ts` 新增 `isHarnessActive()`（读 `win.__ckHarnessVisible`），纯净模式下两条注入 IPC 直接返回 false；`stopGeneration` 纯净模式不聚焦、Escape 改页面内合成 `KeyboardEvent`；选目录后焦点优先给 harness；`chat-input` 只在 `document.hasFocus()` 时才走 `insertTextToChat` 且才 `input.focus()`。

**验证**：typecheck 0 错 / 151 文件 1538 用例 ✓（新增 3 条 `chat-input.test.js` 用例）。中途一次回归：把非系统提示词统一提到 1200ms 导致 `observer.test.js` 超时，已回退为 0ms。

**未做**：真机验证三条现象（附件链路依赖 `webContents.debugger`，单测无法覆盖）。

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
