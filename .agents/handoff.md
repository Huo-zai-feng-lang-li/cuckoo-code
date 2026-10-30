# 最新接续状态 (2026-10-31)

## 本轮改动（v0.10.197）：系统提示词末尾格式锚定 + 对话命名指令前移

### 用户反馈
1. 模型偶发输出 DSML 格式工具调用（`<|DSML|invoke>`）。用户补充关键规律：**新开对话第一次回复时频发**（非必现），因为用户级规则要求先读 `.agents/handoff.md`，第一次回复必然是一次工具调用。
2. AI 几乎不再调用 `nameConversation` 命名对话标题，对话从 A 功能切到 B 功能也不更新。

### 排查过程（重要，避免重走弯路）
- 本会话我（AI）自己触发了 3 次 DSML，逐轮复盘定位到两类触发：
  - **token 污染**：用户消息含 `dsml` 字样 + grep 结果满屏 DSML → 下一步输出被带偏（对应 CHANGELOG 928 已实证教训）
  - **失败补偿**：工具返回空/失败后，本能退回原生 tool-calling 通道重试
- 一度怀疑"提示词臃肿"（backlog #7），但用户确认**输入框不截断、首次发送完整**，该假设不成立，遂放弃瘦身方向（未改 `api.d.ts` / `build-tool-api.mjs`）。
- 最终定位新对话首次回复的根因：**历史里没有任何「assistant 用 cuckoo 块」先例**，而提示词最大块是 12K TypeScript 声明（形态近似 tools schema），cuckoo 示例埋在 104-111 行距生成点太远（recency 弱）。
- 命名失效根因：指令在 `name-conversation` 的 `getPromptSection`（order 114，系统提示词中部），距末尾 100+ 行被稀释，且与"先读 handoff"竞争注意力；系统提示词伪装成"首条 user message"模糊了"首条用户消息处理时命名"语义。

### 改动（4 文件）
1. `src/prompt/deepseek.md` / `claude.md` / `default.md` 三平台模板**最末尾**（生成前最后读到的位置）：
   - 原「需要调用工具时，直接输出 cuckoo 代码块；…」→ 加「（JavaScript）」+「工具调用只允许这一种格式。」**正向排他，不点名任何错误格式**（守住 CHANGELOG 928-940 的历史教训）
   - 新增一行「**新对话首次回复**：第一个动作是 `nameConversation("简短中文标题")`，再执行任务；对话主题实质切换时再调用一次覆盖旧标题。」
2. `src/tools/impl/name-conversation.ts`：`getPromptSection()` 6 行冗长文案精简为 1 行（只讲"标题怎么写"），与末尾"何时调"职责分离，消除重复噪音。

### 验证
- typecheck / compile / test（131 文件 1314 用例）/ lint（0 errors，65 warnings 基线持平）全绿
- 子代理 code-reviewer 独立审查：位置一致性、语义完整性、契约隔离（getPromptSection 不参与 apiMetas）、反向诱导（新增文案逐字无 DSML/XML 字样）、测试断言关联均通过，整体风险「低」，证据信心 9/10
- 采纳其建议：不改（补回"笼统首条兜底"会与"精简不造噪音"冲突，且该场景极罕见）
- 快照：snap-1793379347669-42tuot

### 待真机验证（重要）
- 改动只影响**新开对话**（模板在 initProject 时读取），当前会话不受影响
- 验证点：① 新对话第一次回复（读 handoff）是否稳定用 cuckoo 格式；② 首次回复是否先调 nameConversation；③ 主题切换时是否重命名
- **未解决**：token 污染（用户消息含 dsml 字样）与失败补偿（工具返回空）两类触发仍存在，靠 `observer.ts` 拦截器兜底，属模型概率行为

### 关键经验
- **"提示词臃肿导致模型行为异常"是未实证的假设**：必须先确认"输入框是否截断/信息是否完整送达"，否则会在错误方向上做高风险改动。
- **格式锚定放末尾而非开头**：模型生成受 recency 影响最大，21K 提示词开头的示例权重被稀释。
- **同一指令散落多处 = 噪音**：职责要分离（末尾管"何时调"、getPromptSection 管"怎么写"），不要两处重复讲同一件事。

## 上一条改动（v0.10.196）：刷新按钮与主页入口同步重置纯净视图

### 用户反馈
纯净模式下点工具栏「刷新」按钮感觉毫无反应，怀疑是否该去掉它。

### 根因
`shell-reload`（`src/app/ipc/shell.ts:338`）只做 `view.webContents.reload()` —— 刷的是底层 AI 网页。纯净模式是覆盖其上的独立 WebContentsView（`ctx.harnessView`），有自己的重载通道 `harness-reload`，两条链路完全独立。于是：底层网页重载、hook 重注入、上下文作废，纯净视图仍挂着旧气泡和旧状态 → 点刷新看起来没反应 + 状态脱节。

### 修复（2 文件，+26 −2）
- `src/app/ipc/shell.ts`
  - `shell-reload`：AI 网页 reload 后，取 ctx 并同步 `harnessView.reloadIgnoringCache()`
  - `shell-home`：导航回首页后，向 harness 发 `{ type: 'reset' }` 事件丢弃残留状态
- `src/app/entry.ts`
  - 菜单「重新加载」（`Ctrl+R`）：同步刷新 harnessView
  - 菜单「主页」：同步发 harness reset

### 子代理审查（code-reviewer）结论
可合并，无空指针、无泄漏、无遗漏 reload 入口。提出 1 个 [中] + 3 个 [低]：
- [中] 「主页」入口同类脱节 → **已当场补齐**
- [低] 两处销毁判断写法不一致 → 保持（均安全）
- [低] reloadHarness 调用散在 3 处无 helper → 暂不抽，等第 4 处入口出现再做
- [低] `before-input-event` 里 harness 聚焦时 Ctrl+R 只刷 harness 不刷 view → **刻意保留**（那是开发者重载 harness HTML 的便利入口，与用户点刷新按钮不是同一场景）

### 真机验证（CDP 9444）
在 harness 和 DeepSeek 页面各写内存探针 `window.__ckProbe`，CDP 真实点击 `#btn-reload`：
```
BEFORE: harness=C47C... deepseek=D7AA... shell=A7F9...
MARK:   harness=HARNESS_MARK  deepseek=DEEPSEEK_MARK
CLICK:  {"ok":true}
AFTER:  harness=C47C... deepseek=D7AA...      ← target id 未变（同一 webContents）
PROBE:  harness=undefined    deepseek=undefined ← 两页内存都被清空 = 都重载了
```
`undefined` 即成功证据：若 harness 未刷新，探针仍会是 `'HARNESS_MARK'`。

### 关键经验
- **"刷新"按钮的语义要按用户直觉定义**：用户点刷新 = 重置当前看到的界面，而不是"刷新看不见的底层"。底层与展示层分离的架构下（WebContentsView 叠层），任何"重载/重置"入口都必须两端一起处理。
- **同类入口要一次找齐**：子代理指出「主页」有完全相同的症状。如果只修用户报的那一个，下次还要再修一遍。修状态脱节类 bug 时，应把语义等价的入口（新对话/主页/刷新/切换会话）全部过一遍。
- **CDP 探针法验证页面重载**：写入 `window.__xxx` 内存标记 → 触发操作 → 读回。返回 `undefined` 就证明页面真的重新加载了，比看截图靠谱。同时对比 target id 可区分"重载"与"换了个 webContents"。

### 版本号
`0.10.195` → `0.10.196`（不含数字 4，无需跳过）。

## 上一条改动（v0.10.195）：纯净模式状态栏文案与就绪闪烁

### 用户反馈
状态栏文案看不懂（「框架：工具结果回传」），且怀疑其他状态是否准确。

### 三个问题与修复（仅 2 个文件）

**① 文案改人话**
- 「框架：工具结果回传」→「已发送，等待 AI 响应…（工具结果回传）」
- 隐患：原本 `onStream` 靠匹配「框架：」文案前缀判断过渡态，文案一改就失效。改为 `inFrameworkPhase` 状态位：`onFrameworkSend` 置位、`setStatus` 清零。
- **踩坑**：初版把 `inFrameworkPhase = true` 写在 `setStatus` 之前，被 `setStatus` 立刻清掉。必须写在之后。

**② 状态栏闪「就绪」**
- 根因：observer.ts 第 465-470 行，先通知 `responseListeners`（harness 收到 `assistant-done`），**之后**才调 `processInterceptedResponse` 执行工具（发 `tool-start`），中间还夹着 `await processInlineMarkers`。此刻 `toolRunningCount` 仍是 0 → 状态栏显示「就绪」→ 几百毫秒后才变「工具运行中…」。
- 修复：bridge 在 `assistant-done` 里判定本回合是否含工具调用，透传 `hasTool` 字段；harness 的 `onAssistantDone(text, hasTool)` 据此保持忙态。

**③ hasTool 判据误报（我自己引入又自己发现的）**
- 初版用 `HAS_TOOL_BLOCK_RE`（宽松正则），实测三种情况全返回 true：正常回答附 js 示例（不执行）、纯工具块（执行）、js 纯代码块无工具调用（不执行）。只有第二种会真执行。
- 后果：状态栏误显示「工具运行中…」，随后被静默兜底收尾。
- 改用 `extractJsToolBlocks(raw).length > 0` —— 这是 observer 执行工具时用的同一函数，判据天然一致。

### 真机验证（CDP 录完整状态序列）
```
生成中… → 工具运行中… → 结果待发送（延迟 0→5s）
  → 已发送，等待 AI 响应…（工具结果回传）
  → 生成中…
  → 就绪
```
**没有「就绪」闪烁**（1.4 秒区间内直接从「生成中…」跳到「工具运行中…」）。

### 关键经验
- **状态位必须放在 setStatus 之后置位**：setStatus 统一清理过渡态标记，先置后清等于没置。
- **新增判据要与执行路径共用同一函数**：用宽松正则另判一套，必然和执行侧漂移。本次若不实测三种 case，误报根本发现不了。
- **文案即契约是坏味道**：靠匹配状态栏文案判断状态机，改一个字就静默失效。应尽早换成状态位。

### 版本号
`0.10.193` → 跳过含 4 的 `0.10.194` → `0.10.195`。

## 上一条改动（v0.10.193）：纯净模式三处 UI 交互缺陷

### 用户反馈（真机截图 + 描述）
1. AI 正在思考输出时，右上角状态栏仍显示「框架：工具结果回传」，状态不真实。
2. 鼠标移向「回到底部」按钮，输入框顶部的拖拽手柄被误激活。
3. 点击「回到底部」按钮，输入框边框变蓝（误触聚焦）。

### 根因与修复（仅 src/ui/harness.html 一个文件）

**① 状态栏停在「框架：…」**
- 根因：`onStream` 切「生成中…」的条件是 `!finished && (text||think) && !isBusy()`。框架投递（onFrameworkSend）已把 isBusy 置 true，条件永远不成立，整轮回复期间状态栏冻结在「框架：工具结果回传」。
- 修复：拆成两分支——不忙时照旧 setStatus；忙且当前文案以「框架：」开头时，也切「生成中…」。其它忙态（「结果待发送」）不受影响。

**② hover 误触拖拽手柄**
- 根因：`.scroll-bottom` 视觉上 `bottom: calc(100% + 8px)` 浮在输入框外，但 DOM 上是 `.composer-inner` 的子元素，指针移过去时父容器 `:hover` 一并生效，命中 `.composer-inner:hover .composer-resize { opacity: .55 }`。
- 修复：改为 `.composer-inner:hover:not(:has(.scroll-bottom:hover)) .composer-resize`。

**③ 点击导致边框变蓝**
- 根因：按钮被点击后抢焦点 → 父容器 `:focus-within` 成立 → 命中项目既有规则 `.composer-inner:focus-within { border: 1px solid #3b82f6 !important }`（第 768-777 行，是有意设计的聚焦蓝框）。
- 修复：`scrollBtn.addEventListener('pointerdown', e => e.preventDefault())` 拦掉默认聚焦，click 逻辑不受影响。

### 关键经验（重要）
- **判断"谁导致样式变化"必须用 forcePseudoState 逐个隔离验证**，不能靠猜。本轮我先猜成「hover 冒泡导致变蓝」，实测数据直接推翻：hover 后是白色 `--border-strong`，蓝框来自 `:focus-within` 的 `!important` 规则。
- **测试假阳性比没测更危险**：第一次验证「点击不变蓝」时按钮处于 `display:none`，`focus()` 根本不生效，而 `activeElement` 恰好是 input（页面初始化时已聚焦），边框本来就是蓝的——"点击后没变化"被误读成"修复生效"。重做时必须先 `blur()` 清焦点 + 强制按钮可见，才拿到真数据。
- **CDP 改写 DOM 要保结构**：曾用 `.status` 的 `textContent = '...'` 模拟状态文案，直接把内层 `<span id="status-text">` 冲掉，后续全部测试报 null 错误。正确做法是改内层 span 的 textContent。
- **`:has()` 在本项目可用**（Electron 44 / Chromium 129+），项目已有多处使用，非新引入风险。

### 验证
- typecheck / compile / lint（0 error）/ test（131 文件 1308 用例）全绿
- 真机 CDP 三项逐一验证（含反向验证：非框架态不被误改、hover 手柄在按钮上不显示、真实点击后 :focus-within 不成立）

## 上一条改动（v0.10.192）：纯净模式限流重试耗尽后永久卡「运行中」

### 用户诉求
限流（HTTP 429）自动重试次数用尽后，纯净模式状态栏仍显示运行中、不自动停止。用户问「是否应该停止？是不是我说错了？」——属实，是 bug。

### 根因（两层）
1. **harness 侧（致命）**：`src/ui/harness.html` 的事件分发入口对所有事件无条件 `lastActivityAt = Date.now()`。bridge 每 2s 发一次 `ai-state` 心跳，心跳不断续命 → `onAiState(false)` 与 1.5s 兜底的静默判据（6s）**永远不成立** → 永不自动收尾。
2. **bridge 侧（真机复现时暴露）**：`aiGenerating` 只由事件驱动，任一关键帧丢失（页面重载 / hook 中断 / SSE 异常收尾）就永久停在 `true`，心跳持续上报 `g=true`，harness 收到 `onAiState(true)` 又不断续命 → 同样卡死。此路径与 429 无关，是通用故障面。
3. **次因**：retry 引擎只往 AI 页面 window 派发 `cuckoo-retry-state`（仅 remote-bridge 订阅），纯净模式是独立 `file://` 视图，对「等待重试 / 耗尽」完全无感。

### 修复（6 个文件，+162 −5）
- `src/ui/harness.html`
  - 事件入口：`if (payload.type !== 'ai-state') lastActivityAt = Date.now();`（ai-state 是状态同步而非活动；真生成时由 `onAiState(true)` 分支自己续命）
  - 新增 `retryUntil` + `onRetryState(state, delayMs)`：pending → 置忙「等待自动重试…」并设 `retryUntil = now + delay + 120s`；exhausted → 立即收尾「重试已达上限」；cancelled/success → 清 retryUntil
  - `onAiState` 与 1.5s 兜底 **两处**都加 `if (retryUntil > Date.now()) return;`
  - 事件分发新增 `case 'retry-state'`；`clearTransientState()` 补 `retryUntil = 0`
- `src/bridge/loop/retry.ts`：`emitRetryState(state, extra?)` 增加第二参数 + `ipcRenderer.invoke('harness-retry-state', detail)`
- `src/app/ipc/harness.ts`：新增 `harness-retry-state` handler，转发成 `harness-event { type:'retry-state' }`
- `src/bridge/harness-bridge.ts`：新增 `lastAiActivityAt` + `markAiActivity()`（挂在 onStream / onInterceptedResponse / onToolCall / onTaskIdle / onAiError / onUserStop）+ 心跳内看门狗（`AI_GENERATING_STALE_MS = 120s` 无活动即强制 `setAiGenerating(false)`）
- 两个测试文件各补守卫用例（含看门狗误杀/自愈两条）

### 真机验证（开发版 CDP 9444，单实例干净环境）
- 代码加载：`aiStateExcl=true, retryCase=true, guards=2`
- 场景 A：就绪 → 第1次429「等待自动重试…」→ 第2次429（耗尽）「重试已达上限」✅
- 场景 B：出字「生成中…」→ finished 帧「生成中…」→ 静默 9s（仅心跳）「就绪」✅（根因修复生效）
- 场景 C：pending 后静默 13s 仍「等待自动重试…」✅（不误杀）
- typecheck / compile / test（131 文件 **1308** 用例）/ lint（0 error）全绿

### 关键经验（重要）
- **「事件入口无差别刷新 activity 时间戳」是隐蔽杀手**：任何周期心跳都会让所有基于静默的兜底永久失效。给 activity 时间戳续命必须区分「状态同步」与「真实活动」。
- **双端状态机各有各的卡死面**：harness 侧修好了「收到 g=true 就不会收尾」，但 bridge 侧本身可能永久报 g=true。修复一个卡死点不代表闭环，必须真机跑出来才算数——本轮就是先修好 harness，真机一跑发现 bridge 也卡，才补齐看门狗。
- **CDP 验证前先确认窗口配对**：多实例/多窗口时 `/json/list` 里同 URL 条目有多个，必须先用一次探测事件确认哪个 harness 与哪个 AI 页面配对，否则测的是别人的窗口，结论全错（本轮踩过）。
- **子代理提的 [中] 项要重视**：code-reviewer 明确指出「bridge 侧 aiGenerating 卡 true 缺兜底」，当时判定为「非本次引入、不阻塞合并」，但真机立刻复现。经验：子代理标出的固有风险若与本次修复的同一故障面相关，应当场一并解决。

## 上一条改动（c4819f8，未发版）

## 核心进展
- 提交 c4819f8：「回到底部」按钮空闲态平滑滚动，流式时保持瞬移（isBusy 分流）。
- 提交 c163f3b：三处折叠容器（工具卡片/思考过程/侧边栏子代理预览）平滑过渡动画。
- 提交 95e75f9 / b3bc972：纯净模式状态栏秒数特殊展示（白字 + 主题蓝 16px/800 粗）+ 圆点垂直居中。
- 提交 c0ff691 / dc43687：子代理卡片点击展开修复（侧边栏 + 内容区整卡点击）。

## 本轮改动（c4819f8，未发版）

### 用户诉求
点击「回到底部」按钮时内容区平滑滚动，而非瞬间跳转。用户强调「不要引入问题，导致其他功能受伤，不好做可以不做」。

### 两次失败的历史（重要经验）
1. **第一次**：自造方案 `scroll-behavior: smooth` + 监听 `scrollend` 事件 + 600ms 兜底。被叫停回滚——外挂状态机与项目已有的贴底状态机（`settleScrollBottom`：代次控制 + `suppressPin` 防误判 + 8 次重试 + 三重用户意图监听）打架，时序无法保证。
2. **第二次**：直接复用 `smoothScrollToBottom()`（导航 hover 在用）但不分流。子代理指出两个风险：① `document.hidden` 可能让动画退化为瞬移；② 流式期间 `scrollBottom()` 的 rAF 与动画抢写 scrollTop 造成抖动。

### 最终方案：isBusy 分流
```js
scrollBtn.addEventListener('click', function () {
  pinBottom = true;
  updateScrollBtn();
  if (isBusy()) {              // 流式/工具运行中 → 完全走原瞬移路径
    settleScrollBottom(true);
    _lastScrollTop = stream.scrollTop;
    return;
  }
  // 空闲 → 复用导航 hover 的平滑滚动
  _settleGen++;
  if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
  if (_settleCleanup) { try { _settleCleanup(); } catch (_) {} _settleCleanup = null; }
  resetExpectVars();
  suppressPin = false;
  smoothScrollToBottom(stream, 220);
});
```

关键点：**流式期间两条路径互斥**，从源头消除抢写；空闲态复用已验证的 `smoothScrollToBottom`（rAF 逐帧 + WeakMap token 防并发 + hidden 降级）。

### 关键经验
- **改滚动/动画逻辑前先找项目里已有的实现**：`smoothScrollToBottom`（导航 hover）已经踩过所有坑（hidden 降级、token 防并发），直接复用比自造安全得多。
- **复用现有函数时仍要评估调用场景差异**：导航 hover 场景下内容通常已接近底部，与「回到底部」按钮的「离底很远」场景差异大，抢写风险不同。必须加分流条件。
- **判断「改动是否安全」不能只靠代码推理**：先让用户真机验证（本次空闲态丝滑滚动已确认生效，反证 `document.hidden` 为 false，L4344 那条"始终 hidden"的注释已过时）。

### 已知低危边界（子代理审查，建议维持现状）
1. 空闲点击后 220ms 内立刻发消息 → 两类 rAF 同帧竞争，理论上有约 200ms 中间值抖动，但最终必然收敛到底部。
2. 220ms 内内容异步撑高 → 动画停在旧 target，略高于真底；纯空闲态极少发生。
两条都要改共享的 `smoothScrollToBottom`，会影响导航 hover，风险不对等，故不改。

### 验证状态
- typecheck / test（131 文件 1304 用例）/ lint（0 error）/ compile 全绿。
- **真机已验证**：空闲态点击「回到底部」为丝滑滚动（用户确认）。
- 子代理 code-reviewer 审查通过（无高/中危，两条低危均为自收敛的极窄边界）。


## 上一条改动（c163f3b）：折叠容器平滑过渡动画

### 用户诉求
子代理卡片、工具卡片、思考过程的折叠/展开是瞬间跳变，要求加平滑过渡动画。

### 方案
启用 CSS `interpolate-size: allow-keywords`（Electron 44 / Chromium 129+），使 `height: 0 ↔ auto` 可直接过渡，无需写死 max-height、无需改 HTML 结构。

### 修改（5 个文件）
- `src/ui/harness.html`：`:root` 加 interpolate-size；`.think-body` / `.tool-body` 从 display 切换改为 height+opacity+border 过渡
- `src/ui/shell/styles/base.css`：`:root` 加 interpolate-size
- `src/ui/shell/styles/components.css`：`.ck-agent-running-preview` 改 class 控制的 height 过渡
- `src/ui/shell/scripts/pages/agents.ts`：style.display → classList.toggle('open')
- `src/ui/shell.html`：build-shell 生成物

过渡统一 `.25s cubic-bezier(.25,.1,.25,1)`，透明度 200ms。

### 关键经验
- **display: none 不能过渡**：必须用 height/opacity 等可动画属性。`interpolate-size` 是现代方案，不用写死 max-height。
- **伪元素在 height:0 + overflow:hidden 下会被正确裁掉**，不会露残影。
- `max-height` 与 `height: auto` 共存时，`height: auto` 的过渡目标会被 clamp 到 max-height，是预期行为（预览限高）。

### 验证
- typecheck / test（131 文件 1304 用例）/ lint（0 error）/ compile 全绿
- 子代理 code-reviewer 审查通过（9 项核验，3 条低危均为一致性建议，已确认不改）

## 本轮改动（95e75f9 + 4e55a43，未发版）

### 用户诉求
纯净模式（harness）状态栏「工具运行中 16s…」的秒数与正文同为琥珀细体不醒目；「框架：工具结果回传」整行黄色不好看；前置圆点未垂直居中。最终确认效果：正文白、数字加大加粗，颜色统一使用页面原本的主题蓝。

### 根因
1. v0.10.189 给状态栏加过 `.status b` 强调样式，但**只有「结果待发送」用了 `innerHTML + <b>`**（`escapeSecHtml()`）；「工具运行中」的 `startToolTick()` 用的是 `textContent` 纯文本，完全没吃到 `b` 样式。
2. 数字 16px 撑高行高，导致 6px 圆点在 `align-items: center` 下视觉偏上。

### 最终修改（仅 `src/ui/harness.html`）
- `.status.busy` / `.status.sending` 正文颜色改为 `--text`（高对比白）。
- `.status b`（数字）为 `--accent`（主题蓝）。
- 新增 `.status.busy:not(.sending) b { font-size: 16px; font-weight: 800; }` —— 运行中秒数 16px + 800 粗。
- `.status .dot` 增加 `flex-shrink: 0; position: relative; top: 1.5px;`，修复数字撑高行高导致的圆点偏上。
- JS：`startToolTick` 内 `textContent` → `innerHTML = '工具运行中 ' + escapeSecHtml(sec) + '…'`。

### 关键经验
- **「某个元素没吃到样式」先查是 textContent 还是 innerHTML**：`textContent` 写入的纯文本不含标签，`<b>` 的 CSS 规则对它完全无效。
- **中文字体 + 大字号数字会导致视觉重心偏移**：`align-items: center` 是盒模型居中，不是视觉居中，小圆点需要 `position: relative; top: 1~2px` 微调。

### 验证状态
- typecheck / test（131 文件 1304 用例）/ lint（0 error）/ compile 全绿。
- 子代理 code-reviewer 审查通过（8 项核验：CSS 优先级、:not 排除、XSS、HTML 残留、setStatus 混用等均无问题）。
- **未做真机验证**：纯 UI 视觉改动，建议 `npm start` 目视确认明暗两主题下的观感。

## 最新补充：侧边栏卡片点击无效修复

### 用户反馈
子代理卡片点击还是无法打开/折叠。

### 根因
1. **轮询覆盖**：侧边栏 2 秒轮询刷新时，如果子代理此时没有产生 preview（实时输出为空），更新逻辑里直接执行了 `previewEl.style.display = 'none'`，把用户刚点开的预览框强行关掉了，表现就是“点不开”或“闪一下就没”。
2. **没有视觉反馈**：卡片上没有箭头等展开指示，且预览为空时点开也是白板。

### 修复（`src/ui/shell/scripts/pages/agents.ts`）
- 增加展开/收起的下拉箭头 SVG，并带 180 度旋转动画。
- 轮询更新时，判断 `dataset.collapsed === '0'`（用户手动展开），如果是则不再强制 display='none'。
- 预览为空时，展开状态下显示占位文案「（暂无预览输出）」。

## 上一条改动（b10c233）

### 修复（用户反馈的三个问题）
1. **左侧主题色细线去除**：`harness.html` 的 `.tool-card-subagent` 与 `components.css` 的 `.ck-agent-running` 各删一行 `border-left: 0.5px solid ... !important`。（v0.10.191 刚加的，用户看过觉得不要）
2. **点击无法展开**：
   - 侧边栏（`src/ui/shell/scripts/pages/agents.ts`）的 `.ck-agent-running` 卡片**原本完全没有绑定点击事件**，渲染了 `<div class="ck-agent-running-preview" style="display:none">` 却无 toggle 入口，导致永远打不开。已补整卡点击切换 + `dataset.collapsed` 记录手动态（防 2 秒轮询重置）+ 文本选区时跳过（防误触折叠）。
   - 内容区 `harness.html` 本身有 `tool-head` 点击折叠，未破坏。
3. **剩余时间不一致（差 2 分钟）**：
   - 根因：侧边栏原代码 `(s.timeoutMs || 0)`，字段缺失时按 0 算 → 显示 `00:00`；内容区 `s.timeoutMs || 600000` → 显示真实剩余。若子代理已跑约 8 分钟，正好差 2 分钟。
   - 修复：侧边栏对齐为 `const tmo = s.timeoutMs || 600000`（= `SUBAGENT_TIMEOUT_MS`，见 `src/infra/timeouts.ts`）。
   - 附带：非运行态（done/error）侧边栏不再显示「剩余 00:00」，与 harness 的 `elapsed + 's'` 文案对齐。

### 顺带清理
- `.ck-agent-running` padding `12px 14px 12px 16px` → `12px 14px`（左侧 16px 是原 border-left 的补偿，删线后不对称）。
- `elapsed`/`remain` 复用同一个 `Date.now()`。

### 关键经验
- **侧边栏（shell）与内容区（harness）是两套独立渲染代码**：同一个数据字段，任何一处漏兜底或缺交互就会表现不一致。改子代理卡片必须两端同步核对。
- `shell.html` 是 `components.css` + `scripts/**` 的构建产物，改真源后跑 `npm run compile`，diff 里会出现 shell.html 变更，属正常。

### 验证状态
- typecheck / lint（0 error，65 warning 基线持平）/ test（131 文件 1304 用例）/ compile 全绿。
- 子代理 code-reviewer 审查通过（中危项已修：done/error 残留文案）。
- **未做真机验证**：本次改的是 UI 样式与交互，建议 `npm start` 真机确认——重点看侧边栏卡片点击能展开/折叠且 2 秒轮询后不回弹、两端剩余秒数一致、无左侧线条。

## 上一版（v0.10.191）

## 本轮改动（v0.10.191）

### 变更
- 子代理卡片左侧标识条：`3px solid #ef4444` → `0.5px solid var(--ck-primary)`（壳页面，`base.css` 已定义浅/深色两套）
- 纯净模式同款：`3px solid #ef4444` → `0.5px solid var(--accent)`（`harness.html` 的 `--accent` 已封装明暗切换）
- 状态徽章 `flex-shrink: 0` → `flex: 0 1 auto; min-width: 0` + 省略号，防止长文案挤掉代理名称

### 关键经验（重要）
- **DPI 缩放会影响 border 实际宽度**：开发机 `devicePixelRatio = 2.5`，CSS `1px` 会被计算为 `0.8px`、`0.5px` 会算成 `0.4px`。想要"细线"用 0.5px 更稳；如果用户报"有的粗有的细"，先查 DPR 而不是盲目调数值。
- **`harness.html` 没有 `--ck-primary` 定义**，它的主题色是 `--accent`（内部 `var(--ck-primary, fallback)`，但 `--ck-primary` 在该文件作用域内不存在，永远走 fallback）。纯净模式写颜色必须用 `--accent`。
- **不要用字符串 slice 拼接做大范围删除**：本轮曾两次因此误删 `harness.html` 5140 行、`components.css` 335 行，均靠 `git checkout HEAD` 恢复。正确做法是逐段 `edit` 精确文本替换。

### 验证状态
- typecheck / lint（0 error）/ test（131 文件 1304 用例）/ compile 全绿
- 真机 CDP 验证（DPR 2.5）：`borderLeftWidth: 0.4px`、颜色 `rgb(123,143,255)`（深色主题色）、名称宽 93px 正常、徽章宽 116px 不换行

## 上一版（v0.10.190）

## 核心进展
- 发布 v0.10.190：移除子代理宠物绕圈特性、移除子代理卡片流光，恢复静态红边框；修复卡片间距过大与代理名称不显示的问题。
- 上一版 v0.10.189：工具回传阶段计时语义拆分（工具耗时 / 拟人化延迟分开显示）。

## 本轮改动（v0.10.190）

### 移除
- 子代理宠物绕圈特性整体移除：主进程 IPC（`harness-list-pets`）、Base64 LRU 缓存、`userData/pets` 目录读取、自定义路径设置、设置页「子代理宠物」卡片、渲染层 `.ck-pet-orb` 节点与轮换定时器。
- `src/ui/assets/default-pet.png` 已删除。
- 子代理卡片流光边框（`conic-gradient` + `@property --ck-angle` 旋转）全部移除；壳页面与纯净模式双端恢复静态边框 + 左侧红色标识条，图标红色保留。
- `UiPrefs.subagentPet` 字段、`onPetsChanged` / `cuckoo-pets-changed` 广播链路一并清理。

### 修复
- **卡片左右间距过大**：移除宠物后 `margin` 由 `32px` 恢复为 `8px 10px`。
- **代理名称不显示**：`.ck-skill-name` 缺 `flex: 1; min-width`，被右侧长状态徽章挤成 1px。现改为 `flex: 1 1 60px; min-width: 60px` 支持省略号，`.ck-skill-top` 加 `flex-wrap: wrap`，徽章字号降为 10.5px 且允许换行。

### 关于同名代理并发
同一代理并发跑多次不会冲突：每次调用分配独立 `windowId` 与沙箱上下文，界面并列两张卡片独立计时。

### 验证状态
- 真机 CDP 验证：卡片 margin 为 `8px 10px`、无 `.ck-pet-orb`、动画为 none、名称宽度 237px 正常显示。
- 全仓 grep 无 `subagentPet|ck-pet|listPets|onPetsChanged` 残留。
- typecheck / compile / lint（0 error）/ test 全绿。

## 上一版（v0.10.189）

## 核心动机
工具跑完到结果发回 AI 之间有 6~16 秒拟人化延迟（由「发送节奏」设置决定）。
此前：
1. **原版遮罩**显示「正在回传结果 8s」——一个数字混了「工具耗时 + 干等延迟」，用户看不出时间花在哪。
2. **纯净模式**状态栏在这段显示「生成中…」，但 AI 页面根本没在生成（在等我们发消息），用户以为卡死。

## 关键设计
- **语义拆分**：进入发送阶段时把「工具耗时」定格，延迟从 0 单独计时。
  - 遮罩：`正在回传结果（工具 3s · 延迟 5s）`
  - 状态栏：`结果待发送（工具 3s · 延迟 5s）`
- **不重置计时**：保留「秒数连续不归零」的原有设计（避免"归零=卡住"误判），只做语义拆分。
- **阶段判定去字面量**：`startMaskTick` 不再靠 `label === '正在回传结果'` 判断，改用 `maskSendStartAt` 状态位。
- **纯净模式静默判据适配**：`onAiState` 的 6s 静默收尾会误杀默认 6~16s 延迟。改为 sendTick 活跃期间持续续命 `lastActivityAt`，另加 `SEND_TICK_MAX_MS = 120s` 硬上限兜底真卡死。
- **数字强调**：加大 + 加粗 + 等宽（tabular-nums），取消倾斜与荧光色。遮罩 16px 主题蓝，状态栏 15px 琥珀色（走 `var(--amber)`，随明暗主题自动切换）。
- **配色分层**：状态栏「结果待发送」态正文降为常规文字色（`.status.sending`），仅数字保持琥珀，避免整行同色糊成一片。

## 子代理审查（2 轮）
第一轮并行派 2 个 code-reviewer，分别审查纯净模式状态机与原版遮罩。共发现 4 个中危 + 3 个低危：

| 级别 | 问题 | 修复 |
|---|---|---|
| 中 | `clearTransientState` 未停 sendTick → 切会话后状态栏永久残留且秒数一路涨，两条兜底都因 `!isBusy()` 早退 | 补 `stopSendTick()` + 状态栏文案与指示器复位 |
| 中 | sendTick 自停判据依赖 DOM class（拿渲染结果当状态机） | 改为业务态 `(!generating && toolRunningCount <= 0)` |
| 中 | `panel.ts` 用字符串字面量判定阶段 | 改用 `maskSendStartAt` 状态位 |
| 中 | 降级态把两个数字糊回一个总时长 | 降级态也输出拆分数字 |
| 低 | `setStatus` 里 `stopSendTick` 在 `aborted()` 早退之后 | 提到早退之前 |
| 低 | 测试硬编码 `工具 1s`，CI 卡顿会假失败 | 改为 `[12]s` 区间断言 |
| 低 | `emphSec` 参数无 `Number()` 兜底 | 加 `Number.isFinite` 防御 |

第二轮复核确认 4 项修复全部落地，另指出 1 条 `syncBusyIndicators` 缺口（既有问题被本轮放大），已补。

## 修改文件
- `src/overlay/panel.ts`：`maskExecSec`/`maskSendStartAt` 状态位、`emphSec()`、`renderMaskText` 改 innerHTML、降级态阶段感知、阶段判定去字面量。
- `src/overlay/template/overlay.css`：`.cuckoo-tool-mask-text b` 强调样式（16px/700/tabular-nums/主题色，暗色与降级态分别适配）。
- `src/ui/harness.html`：`startSendTick`/`renderSendTick`/`stopSendTick`、`.status b` 与 `.status.sending` 样式、`setStatus` 统一停表、`onAiState` 续命逻辑、`clearTransientState` 补停表与复位。
- `test/overlay/panel.test.js`：新增 2 例（阶段定格 + 快照不残留），断言改区间容忍相位。
- `test/ui/harness-page.test.js`：`onAiState` 断言从固定 900 字符切片改为按函数边界切片（原断言会因加注释被挤出窗口）。

## 验证状态
- `typecheck` / `test`（131 文件 / 1304 用例）/ `lint`（0 error，65 warning，与基线持平）/ `compile` 全绿。
- 真机端到端（CDP 注入观察器抓取）：`工具运行中 1s…20s` → `结果待发送（工具 3s · 延迟 0→8s）`（工具定格、延迟递增、每帧 2 个强调标签）→ `框架：工具结果回传`。延迟跑到 8s 未被 6s 静默判据误杀。
- **未验证**：最终字号（16px/15px）仅经 CDP 读取 computedStyle 确认生效，未目测观感，需真机确认是否偏大。

## 下一步建议
- 若觉得 16px/15px 偏大，改 `overlay.css` 的 `.cuckoo-tool-mask-text b` 与 `harness.html` 的 `.status b` 的 font-size 即可，其余逻辑不受影响。
- 快照 `snap-1793289429968-bp5j1v` 可用于回滚本轮全部改动。



