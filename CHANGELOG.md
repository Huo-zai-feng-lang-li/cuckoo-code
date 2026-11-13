# Changelog

> 完整历史按**发布月份**归档在 `changelogs/`，本文件只保留索引与最近 5 个版本。
> **唯一真相源是 `changelogs/YYYY-MM.md`**；发版时把新条目追加到当月文件顶部。
> 查找任意版本：`node scripts/changelog-locate.mjs <版本号>`。

## 版本索引

| 月份 | 版本区间 | 版本数 | 文件 |
|---|---|---|---|
| 2026-11 | 0.10.203 ~ 0.10.226 | 21 | [changelogs/2026-11.md](changelogs/2026-11.md) |
| 2026-10 | 0.8.7 ~ 0.10.202 | 293 | [changelogs/2026-10.md](changelogs/2026-10.md) |
| 2026-09 | 0.2.5-beta.1 ~ 0.8.6 | 24 | [changelogs/2026-09.md](changelogs/2026-09.md) |
| 2026-08 | 1.0.0 ~ 0.2.0 | 2 | [changelogs/2026-08.md](changelogs/2026-08.md) |

## 最近 5 个版本

## [0.10.226] - 2026-11-12

### 优化

- **初始化提示词上下文瘦身（规则去重 + 技能路径压缩，整体减少约 3.9KB / -24%）**
  - `src/skills/prompt.ts`：技能章节改为「按来源分组 + 目录前缀只声明一次」，每条技能只输出 `<name>/SKILL.md` 相对路径（路径分隔符统一为 `/`），25 条技能从 4104 字符降到 2633 字符，能力零损失；
  - `.agents/rules/README.md`、`project.md`、`subagent-dispatch.md`、`.cuckoo/CUCKOO.md`：删除同一批纪律的多份副本（验证四件套、交付报告、开工读 handoff、需求流程等），保留单一真相源；
  - `.agents/rules/subagent-dispatch.md`：删除引用不存在工具（`invoke_subagents_parallel`）与模型（`agnes-3.0-flash`）的「并发派发规范」段落，替换为真实 `runAgents` 用法；三要素硬约束与真实事故反例完整保留。

### 变更

- 停用 6 个无效/冲突/重复技能（移入 `_disabled/`，可随时移回）：`using-superpowers`、`find-skills`、`dispatching-parallel-agents`、`subagent-driven-development`（均依赖不存在的 superpowers 生态）、`taste-skill`（与 `impeccable` 定位重叠）、项目级示例 `hello`。

### 验证

- `npm run typecheck` 0 错误；`npm test` 146 测试文件 / 1484 用例 100% 通过；`npm run lint` 0 errors；`npm run compile` 全量重建成功。
- 真实 `buildPrompt()` 实测系统提示词总长 38025 字符，技能章节 2633，项目介绍 3824。
- 新增测试：`test/skills/skills.test.js` 补充「同源技能只声明一次目录前缀」「不同来源分组」「路径分隔符统一为 /」三条断言。

## [0.10.225] - 2026-11-12

### 优化

- **工具结果回传话术池扩充并避开近期重复（降低固定句式指纹）**
  - `src/overlay/chat-input.ts`：单段前缀 5 条 → 18 条，多段前缀 5 条 → 18 条；
  - 新增模块级 `recentPrefixes` 记忆（容量 8，单段/多段共用），优先从"近 8 次未用过"的话术中抽取，抽空再回落到全量池，保证连续两轮回传不会撞同一句；
  - 判据去冗余：移除 `current.includes('跑完了，结果')` / `includes('执行结果：')` 两条与 `some(startsWith)` 重复的硬编码，改为以前缀列表为单一真相源，避免扩充话术时漏改；
  - 顺带修正语义：残留判定由"内容任意位置命中"收窄为"开头命中"，不再误删用户真实输入。

### 修复

- **纯净模式长暂停结束后显示幽灵「等待发送」计时**
  - 根因：`src/ui/harness.html` 的 `send-pause` 暂停结束分支把 `sendStartAt` 重置为当前时刻；而 `chat-input.ts` 在 `didLongPause` 分支已把 `reactionMs` / `hesitationMs` 清零，消息暂停一结束即填充发送，真实不存在"等待发送"窗口。UI 却从 0 重新计秒，显示一段并不存在的等待。
  - 修复：暂停结束分支改为 `stopSendTick()`，直接停表并移除 `sending` 配色类。

### 验证

- `npm run typecheck` 0 错误；`npm run lint` 0 errors（73 条历史 warning，均为未使用变量，非本次引入）；`npm test` 146 测试文件 / 1481 用例 100% 通过；`npm run compile` 全量重建成功。
- 新增回归测试：
  - `test/overlay/chat-input.test.js`：10 次连续回传应出现 ≥6 种不同前缀，且相邻两次不得相同；
  - `test/ui/harness-page.test.js`：暂停结束分支必须含 `stopSendTick()` 且不得含 `sendStartAt = Date.now()`。

## [0.10.223] - 2026-11-12

### 修复

- **DeepSeek 新开对话开关预设增强（关闭联网搜索，保留深度思考）**
  - DeepSeek 网页端搜索按钮实际文本为“联网搜索”（此前正则匹配偏窄未准确命中）；
  - `src/providers/deepseek.ts` 的 `setupNewSession` 扩展搜索按钮匹配正则为 `/联网搜索|智能搜索|搜索|联网|Search/i`；
  - 增强状态识别：综合判定 `aria-pressed === 'true'` 与类名 `ds-toggle-button--selected`；
  - 事件派发补齐 `el.click()` 兜底，防止指针事件在特定受控组件下未触发点击行为；
  - 就绪条件优化：深度思考与搜索两个开关按钮均被检测到且处于可见状态即判定就绪。
- **彻底根治长文本自动转附件引发的输入框双发（架构根因修复）**
  - **停用纯文本自动转附件**：此前纯文本超长（>4000 字符）时强行转为 `.txt` 附件挂载，导致 CDP 文件选择器注入与视觉卡片验证偶发超过 12 秒超时，静默回退至原生 `insertText`，造成输入框既挂载了附件又再次灌入相同文本的“双发”恶性 Bug。
  - **消除外挂特征与恢复人类自然交互**：真实人类用户在聊天框直接粘贴大段日志与代码；自动包装 `工具输出-MMDD-HHMM.txt` 及机械式引导文案属于典型的自动化外挂指纹，且会降低 DeepSeek 遵循指令的稳定性。现将 `src/overlay/chat-input.ts` 的 `shouldAttach` 改为纯文本恒定返回 `false`，全量走原生自然分块输入通道，从根源消除双发、12 秒超时盲等与外挂特征。

### 文档

- 归档 `docs/bugs/pure-mode-send-delay-timeout.md`：纯净模式「等待发送」超出配置上限偶发问题的技术取证与诊断分析。

### 验证

- `npm run compile` 全量重建产物。
- `npm run typecheck` + `npm run lint`（0 errors）+ `npm test`（146 测试文件 1479 用例 100% 通过）。
- 新增与更新测试：`setupNewSession` 联网搜索关闭与状态识别、长文本工具输出与提示词直接物理输入无附件。

## [0.10.222] - 2026-11-11

### 修复

- **附件通道被 debugger 常驻占用而全线失效（根因修复）**
  - 真机日志确证：`附件通道失败，回退 insertText: debugger-busy`。启用代理/指纹时 `net-identity.ts` 会 `wc.debugger.attach()` 后常驻不释放，而 `cdpAttach` 采用独占式判断，发现已附着即返回失败 —— 导致整个会话内长文本附件通道 100% 失效，全部静默回退为 `insertText` 全文注入（正是需求 115 要消灭的脚本特征）。
  - `src/app/ipc/cdp-attach.ts` 改为复用已存在的 debugger 连接，并以 `ownsDebugger` 标记确保只 detach 自己 attach 的连接，绝不抢断外部占用者的会话。
- **CDP 深层节点定位与前端状态唤醒**
  - 优先 `Runtime.evaluate` + `DOM.requestNode` 精确取 `nodeId`，兜底 `DOM.getDocument({ depth: -1 })`，解决浅层索引遗漏导致的 `input[data-cuckoo-attach-input]` 检索不到；
  - 文件注入后派发 `input` / `change` 事件，唤醒 React/Vue 受控状态机感知文件变更。
- **纯净模式发送状态栏与宠物气泡恢复**
  - 修复 `renderSendTick` 中 `sendSec` 未定义导致的 `ReferenceError`（状态栏与宠物气泡渲染被中断）；
  - 定时器自停判据补入 `&& !sendPauseActive`，随机长暂停期间不再被误杀定格。
- **长系统提示词与用户长输入改走附件**
  - 抽出 `shouldAttach(tag, len)`，放行系统提示词、工具结果回传与用户消息；节流仅作用于自动化工具循环（`JS汇总`），系统提示词与用户手动长输入豁免 60s 节流；
  - `lastAttachAt` 仅由工具结果刷新，避免系统提示词上传后把紧随的首轮工具结果挤回 `insertText`；
  - 文件名前缀按语义区分：`系统设定-MMDD-HHMM.txt` / `用户需求-MMDD-HHMM.txt` / `工具输出-MMDD-HHMM.txt`。
- **DeepSeek 附件就绪判定容错增强**
  - 输入框检索优先 `#chat-input`，附件卡片匹配范围放宽（`boxTop - 260` ~ `boxBottom + 120`），支持子串匹配与文件名后缀边界，减少误判未就绪。

### 验证

- `npm run typecheck` 0 错误；`npm test` 146 文件 / 1477 用例 100% 通过；`npm run lint` 0 errors；`npm run compile` 全量重建成功。
- 新增回归测试：系统提示词与用户长消息转附件通道、debugger 被外部常驻占用时复用连接且不擅自 detach。

## [0.10.221] - 2026-11-11

### 修复与优化

- **彻底根除工具回传重试导致的二次延时超标与内容翻倍（时序闭环）**
  - **300ms 快速重发通道**：`sendToolResultWithRetry` 在重试（`attempt > 1`）时给 `sendCombinedJsResultsToChat` 显式传入 `isRetry = true`，固定为 `300ms` 快速重发，彻底杜绝重试时再次叠加 10~20 秒拟人化延迟（解决用户配置 4~20 秒却等待 30 多秒的痛点）。
  - **输入框防自身拼接翻倍**：在向输入框填入内容前增加防御守卫，重试期间或输入框内容已包含工具回传前缀时，严禁当作用户新输入内容重复追加，杜绝 5061 字符翻倍为 10127 字符的恶性膨胀。
- **随机长暂停与常规发送延迟解耦**
  - 一旦触发并完成了随机长暂停，拟人与避风控效果已极其充分，直接将 `reactionMs` 与 `hesitationMs` 置 0，长暂停结束后直接分块填入输入框并发送，不再产生任何二次叠加等待。
  - 纯净模式 harness 在进入与退出随机长暂停时均立即重置 `sendStartAt`，隔离长暂停与常规延迟的计时域。
- **纯净模式顶部状态栏与宠物气泡同步**
  - 修复 `renderSendTick` 中的硬编码文案：长暂停激活时，顶部状态栏文本与气泡同步展示 `随机长暂停中（第X次 · 共Xs · 等待Ys）`；
  - 在接收到 `send-pause` 激活事件时，若定时器尚未运转，立即启动 `startSendTick(0)`，确保纯净模式在任何阶段进入长暂停都能实时每秒刷新倒计时。
- **原生页面遮罩对接随机长暂停状态**
  - `panel.ts` 引入 `updateMaskSendPause(active, durationMs, onCancel)`，原生网页顶部 ToolMask 浮层同步展示长暂停倒计时与取消入口。
- **DeepSeek 发送按钮真实事件序列强化**
  - 发送按钮点击由单一 `btn.click()` 升级为派发完整 `pointerdown -> mousedown -> pointerup -> mouseup -> click` 真实事件序列，全面提升受控组件响应率与输入框清空可靠性。
- **宠物气泡文本与高亮细节**
  - 恢复 `white-space: nowrap` 规则，消除中文在 flex 容器中被按字折叠竖排的问题；
  - 随机长暂停文案中的触发次数、总时长、等待秒数全部包裹 `<b>` 标签，统一呈现金黄色发光胶囊视觉。

### 验证

- `npm run compile` 全量重建生成物（`shell.html` 等）。
- `npm run typecheck` + `npm run lint`（0 errors）+ `npm test`（146 文件 1474 用例 100% 通过）。
- 新增回归测试：`sendCombinedJsResultsToChat 在重试时走快速通道并不重复拼接旧工具回传` 与 `工具结果长暂停结束后不再叠加常规发送延迟，直接填充并发送`。
