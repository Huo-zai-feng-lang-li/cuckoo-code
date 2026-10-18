# harness 性能与模型降质 - 对抗性代码审计报告

> 审计对象：**Cuckoo Code 纯净对话模式（harness）当前 HEAD**（1d95c39）
> 审计姿态：外部白帽攻防视角（作者自审降级协议）
> 取证工具：read/grep/bash（每条结论附文件:行号）

## 1. 门禁裁决

- **裁决结果**：⚠️ **CONDITIONAL PASS**（无 🔴，但有 🟡 性能隐患 + 澄清一处误判）
- **审计范围**：工作区无改动（`git status -s` 为空）→ 按 SKILL 回退审计当前 HEAD 的 harness 全体系
  - 涉及文件：`src/ui/harness.html`（3990 行）、`src/bridge/harness-bridge.ts`（171 行）、`src/app/ipc/harness.ts`（635 行）、`src/app/entry.ts`（harness 挂载）、`src/bridge/loop/watchdog.ts`（134 行）
- **裁决理由**：
  1. **回答核心问题：harness 性能不会导致模型降质**。harness 是独立 WebContentsView，独立渲染进程（entry.ts L256-281），与 AI 页面（ctx.view）完全隔离，其渲染/IO 重活**不阻塞 AI 推理/流式**。
  2. **可见历史 vs 模型上下文明确分离**——harness localStorage 存的是 UI 展示层，实际发模型的是 `api.sendMessage → harness-user-message → bridge sendToChat`，两者设计上就不同（框架系统消息仅 UI 可见，不进模型），**不是分叉 bug**。
  3. 存在 🟡 长会话下 `saveHist` 全量同步 stringify + localStorage.setItem 阻塞 harness UI 自身的风险；但不影响 AI。

## 2. 改动链路与闭环核验

- **harness 数据流**：
  - 起点（AI 页面）：`src/bridge/harness-bridge.ts:77-93`（onStream / onInterceptedResponse 上报）
  - 中转（主进程）：`src/app/ipc/harness.ts` 的 `harness-event-report` handler → `hv.webContents.send` 转发给 harness 视图
  - 终点（harness UI）：`src/ui/harness.html:2666-2759` 的 `api.onEvent` 分发 → onStream / onAssistantDone / pushHist / addUser
- **用户消息反向流**：
  - 起点：`src/ui/harness.html:3123-3125`（pushHist + addUser）→ L3156-3195 `api.sendMessage`
  - 终点（AI 网页）：`harness-user-message` → `src/bridge/harness-bridge.ts:141-154` → `sendToChat`
- **Untracked 漏提风险**：无（工作区 clean）

## 3. 缺陷与风险取证清单

### [🔴→澄清] **可见历史 ≠ 模型上下文，但不是缺陷**（先破一个可能的误判）
- **定位**：`src/ui/harness.html:885-896`（pushHist）、`src/ui/harness.html:3113-3125`（sendText vs bubbleText 分流）
- **事实证据**：
  - 用户消息：`pushHist(userHistItem)` 与 `api.sendMessage(sendText)` **一一对应**（L3124/L3159）。bubbleText 与 sendText **故意不同**（如 /goal 时 bubble="[目标] xxx"，send 携带完整框架提示）。
  - 框架系统消息（"目标已设定"L1616、计划就绪 L2013 等）：**仅 pushHist**，**不**经 api.sendMessage，**不进模型**。
  - AI 回复：`onInterceptedResponse` 上报的 assistant-done **也 pushHist**（L2692），AI 回复本身已在网页模型上下文里，不重复发。
- **潜在危害**：**无**。这是设计意图（UI 层反馈 ≠ 模型上下文），不是 bug。**信心评分：9/10**。

### [🟡 中] **saveHist 全量同步序列化 + localStorage.setItem，长会话下阻塞 harness UI**
- **定位**：`src/ui/harness.html:867-896`（saveHist + pushHist）
- **事实证据**：
  - `saveHist` 每次调用都对**整个 history 数组**做 `JSON.stringify(history)` + `localStorage.setItem`（**同步 API**）。
  - `pushHist` 在**每次**工具 start/end（L2733/L2745）、每次 assistant 回复（L2692/L2725）、每次 system 消息都调用 → `saveHist` 全量执行。
  - 数据规模推演：`HIST_FIELD_MAX = 6000`（L852），最多 6 个字段/条 → 单条最大 ~36KB；`history.length > 400` 时截断（L869）。**典型 400 条会话 1-3MB**，长文本密集时可接近 localStorage 5-10MB 上限。
  - 长会话 + 高频工具调用（每轮可能十几次 pushHist）时，单次 stringify 可能耗时 **50-200ms**（估算），且**同步阻塞 harness 渲染进程主线程**。
- **潜在危害**：
  - **不影响 AI 页面**（独立进程，见 §1 裁决）。
  - 影响 harness 自身 UI 流畅度（长会话 + 密集工具事件时可能卡顿）。
  - **不影响模型上下文正确性**（发送路径独立于 localStorage）。
- **修复方案**：
  1. **节流 saveHist**：改为 `setTimeout(() => 实际写盘, 500)` 合并短时多次 push（500ms 内多次 push 只写一次）。
  2. **或改增量**：只 stringify 新增条目 append（需改存储结构，成本更高）。
  3. **或降 HIST_FIELD_MAX**（从 6000 → 2000），降低单条体积。
  - **建议**：优先方案 1（节流），改动最小，收益明显。
- **信心评分：7/10**（影响路径清晰；具体耗时需实测，扣 2 分）。

### [🟡 中] **renderMarkdown 全量解析 O(n²)，rAF 只降了系数**
- **定位**：`src/ui/harness.html:2243-2273`（renderMarkdown）、`src/ui/harness.html:2475-2501`（rAF 节流）、`src/ui/harness.html:2530`（流式帧调度）
- **事实证据**：
  - renderMarkdown 每次对**全量文本**做 2 次全局正则 + `marked.parse` + 1 次全局正则（L2256-2267）。
  - 流式帧已 rAF 节流（L2493-2499），但**每帧仍对增长中的全量文本全量解析** → 单轮回复累计 O(n²)。
  - rAF 把系数从 ~60 帧/秒降到 1 帧/秒（合并同一帧多次更新）—— 但长回复（数千字）末段单次 renderMarkdown 已可感知卡顿。
- **潜在危害**：harness 流式渲染期**长回复末段可能卡顿**（每帧 1 次全量 markdown 解析）。
- **修复方案**：
  1. **流式期间纯文本 append**（同 053 远程修复思路）：`textNode.textContent += delta`；结束帧才 renderMarkdown 全量一次。**注意**：会失去流式期间 Markdown 实时样式。
  2. **或**：抽稀 rAF（如 ≥100ms 一次，对齐 remote 的 STREAM_FLUSH_MS）。
- **信心评分：8/10**。

### [🟢 轻] **restoreHist 全量 DOM 重建，切会话偶发卡顿**
- **定位**：`src/ui/harness.html:1270-1302`
- **事实证据**：恢复 400 条历史时逐条 `appendChild`（含工具卡片展开渲染），一次性重建 ~几百到上千 DOM 节点。
- **潜在危害**：切会话/重载时 harness UI 可能卡顿 1-2 秒（取决于历史规模）。**不影响 AI**。
- **修复方案**：虚拟化（只渲染可视区）或分帧懒加载。**当前规模可接受，建议列入待办**。
- **信心评分：7/10**。

### [🟢 轻] **watchdog 与 harness setInterval 兜底误判风险低**（澄清）
- **定位**：`src/bridge/loop/watchdog.ts:52-75`、`src/ui/harness.html:2419-2439`
- **事实证据**：
  - watchdog：只在 hook 派发 `cuckoo-stream-idle` 时触发（阈值默认 300000ms=5min，L11），有会话校验（L56-62）、次数上限（默认 3），**不会跨会话误触发**。
  - harness setInterval 兜底：只在 `toolRunningCount>0 且 idle>600000ms` 或 `generating 且 idle>60s/120s` 时复位（L2423-2438），阈值宽松。**不会误杀正常生成**。
  - `maybeFlushQueue`（L2344）只在 `state!=='busy' && !isBusy()` 时 setTimeout 30ms 后调；bridge 有 `aiGenerating` 心跳（harness-bridge.ts:72-74）+ 主进程 busyProfiles TTL 双保险（manager.ts:41-48）。
- **潜在危害**：**未发现确凿误触发路径**。
- **信心评分：8/10**（极端情况下：限流自动重试期间 SSE 完全静默，但**会被 watchdog 的会话校验和次数上限兜住**；harness 兜底 60s 内不可能触发，因为正常生成会持续 lastActivityAt）。

### [🟢 轻] **harness 上报未做门控，理论上增加 IPC 开销**
- **定位**：`src/bridge/harness-bridge.ts:1-20`（注释解释为何不做门控）
- **事实证据**：注释明确：曾用主进程下发 `harness-mode` 开关做门控，但"AI 页面导航/重载会丢广播 → 静默丢弃上报 → 哑界面 + 状态永久卡住"。故改为**一律上报**，代价是"多几次 IPC"，换掉一整类哑界面故障。
- **潜在危害**：**极低**。IPC 量（每秒几次）相对昂贵操作可忽略。
- **信心评分：9/10**。

## 4. 五维核查矩阵回执

- [x] **架构契约与安全红线**：✅ 已取证核查，未发现异常。harness 是独立 WebContentsView（entry.ts:256-281），符合窗口结构铁律；不逆向依赖（bridge 通过 IPC 上报，不 import app/session）。**但需注意**：harness 是"UI 层"，其 localStorage 存的历史不含敏感密钥（只有用户输入的对话文本 + AI 回复 + 工具输出）。

- [x] **端到端功能闭环**：✅ 已取证核查，未发现异常。用户消息 pushHist + api.sendMessage 一一对应（L3124/L3159）；AI 回复经 bridge 上报后 pushHist（L2692）；工具 start/end 双向同步（L2733/L2745）。

- [x] **对抗性 Bug 与并发安全**：✅ 已取证核查，未发现 🔴。rAF 挂起取消到位（cancelStreamRender L2501）；`cur` 有效性校验（L2488）；watchdog 会话校验（watchdog.ts:56-62）；`clearTransientState` 覆盖附件/提示/工具计数（L1309-1327）。

- [x] **性能与代码复杂度**：⚠️ 见问题 #2（saveHist 全量 stringify）和 #3（renderMarkdown O(n²)）。

- [x] **领域专项（AI Agent / 前端 / 后端）**：
  - **激活项：专项 A（AI Agent 运行时）+ 专项 B（前端状态机）**
  - **专项 A 核查结果**：
    - 忙态准入：harness 侧 `isBusy` 双保险（L2308）+ bridge `aiGenerating` 心跳 + 主进程 `busyProfiles` TTL。✅
    - 可见历史 vs 实际上下文：**已取证确认设计上明确分离，非 bug**（见问题 #1）。✅
    - 流式终态收敛：task-idle（bridge L97-100）+ onAiState（L2399-2412）+ setInterval 兜底（L2419-2439）三层保证。✅
    - 多会话隔离：localStorage key 带 sid（L835-839）；onSessionChanged 保存旧会话 + 加载新会话（L1379-1414）。✅
  - **专项 B 核查结果**：
    - 组件卸载后异步回调：rAF 回调里检查 `body.isConnected && cur && cur.body === body`（L2488），✅
    - 乐观 UI 失败回滚：`api.sendMessage` 返回 `success:false` 时 appendSystem + setStatus('就绪') + clearPendingBubble（L3183-3193），✅

## 5. 给用户的直接结论

**Q: harness 性能是否会导致模型降质？**

**A: 不会。** 三条硬证据：

1. **进程隔离**：harness 是独立 WebContentsView（entry.ts:258-267），有自己的渲染进程和 preload，其渲染/IO/卡顿**不进入 AI 页面的渲染进程**，不影响 AI 推理/流式/工具循环。

2. **上下文路径独立**：发给模型的文本走 `api.sendMessage → harness-user-message → bridge sendToChat`，**不经过 localStorage**。harness 的历史仅作 UI 展示（"可见历史 ≠ 模型上下文"是设计意图）。`saveHist` 只阻塞 harness 自身。

3. **主进程不会被反压**：harness 上报走 `ipcRenderer.invoke('harness-event-report')`（异步），主进程 handler 转发到 harness 视图（`hv.webContents.send`），**不阻塞 AI 页面的 IPC 处理路径**。

**真正的性能隐患**（改进建议，均不影响模型）：
- 🟡 `saveHist` 长会话全量 stringify（`src/ui/harness.html:867-896`）
- 🟡 `renderMarkdown` 流式全量解析（`src/ui/harness.html:2243-2273`）
- 🟢 `restoreHist` 全量 DOM 重建（`src/ui/harness.html:1270-1302`）

**门禁结论**：⚠️ CONDITIONAL PASS —— 可提交（非阻断）；建议把 3 项性能优化列为后续独立需求（053 已确立"流式纯文本 append"模式，可直接复用到 harness）。

## 6. 审计纪律自检

- [x] 作者不得自审：本报告基于纯代码取证，无开发历史预设
- [x] 证伪优先：主动寻找"harness 会不会真影响模型"的反例，结论是**不会**（破除非证据的担忧）
- [x] 注释 = 供词：核查了 harness-bridge.ts 的"为什么不做门控"注释（L14-19），验证与实现一致
- [x] 硬取证：所有结论附 文件:行号，无脑补
- [x] 双端输出：落盘本报告 + 对话窗口精简摘要
