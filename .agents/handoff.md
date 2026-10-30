# 最新接续状态 (2026-10-30)

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

## 上一条改动（c163f3b）

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


