# 最新接续状态 (2026-10-30)

## 核心进展
- 发布 v0.10.189：工具回传阶段计时语义拆分（工具耗时 / 拟人化延迟分开显示），原版遮罩 + 纯净模式状态栏双端同步。

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
