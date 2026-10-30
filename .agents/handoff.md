# 最新接续状态 (2026-10-30)

## 核心进展
- 提交 [最新] / 95e75f9：纯净模式状态栏秒数特殊展示（白字 + 主题蓝 16px/800 粗）+ 圆点垂直居中修复。
- 提交 b10c233：修复子代理卡片 UI 三问题（边框线 / 点击展开 / 剩余时间不一致）。
- 上一版 v0.10.191：子代理运行卡片左侧标识条改主题色 0.5px 细线，状态徽章改为可收缩，清理死代码。

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


