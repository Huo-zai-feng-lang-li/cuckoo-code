---
id: 113
type: feature
title: 停止双向同步、新会话开关预设与指纹字段清理
status: done
branch: feat/113-stop-sync-and-session-preset
created: 2026-11-10
updated: 2026-11-10
---

# 113：停止双向同步、新会话开关预设与指纹字段清理

> 状态：**done**
> 分支：\`feat/113-stop-sync-and-session-preset\`

## 用户目标与约束

1. 在 AI 网页点「停止」要同步停止纯净模式任务，反过来也一样（双向）。
2. 新开对话时自动关闭「智能搜索」、保持「深度思考」开启。
3. 指纹按最优方案处理（清理无效字段，不改运行时行为）。

约束：
- 不改动已确定的指纹真实尺寸策略（Screen / DPR 保持 Chromium 真实值）。
- 不引入新的跨层依赖（bridge 不依赖 session/app，tools 不依赖上层）。
- 新会话开关只对支持该能力的平台生效，其他平台零影响。

## 现状核查（开工前）

### 停止同步

**正向（纯净模式 → 网页）已完整**：
\`harness-stop\` → \`stopGeneration()\`（\`src/app/ipc/harness.ts:279\`）：
1. \`abortWindowWork\` 强杀工具子进程 + JS 沙箱 worker
2. \`cancelSubagentsByParent\` 取消所有子代理
3. 向 bridge 发 \`harness-stop-signal\`（取消待发送 + 清空输入框 + \`requestAbort\` + 取消重试倒计时 + 暂停看门狗）
4. 定位并点击网页原生停止按钮，轮询校验 \`generating === false\`

**反向（网页 → 纯净模式）UI 收尾完整，但有防御缺口**：
网页 hook 检测 \`stop_stream\` → \`emitUserStop()\` → \`harness-bridge.ts:159\` 上报 \`task-idle\`。
但 \`onUserStop\` 回调只做 \`markAiActivity()\` + \`setAiGenerating(false)\` + \`report(task-idle)\`，
**未调 \`requestAbort()\` / \`cancelPendingSend()\`**（正向的 \`harness-stop-signal\` 有）。

影响面：DeepSeek 停止按钮仅在生成中显示（\`getStopFn\` 靠方块图标判断），工具执行期/延迟回传期按钮已变回发送箭头，用户点不了 → 当前基本不可达。但其他平台（或页面改版）可能让停止按钮在非生成态仍可点，属于防御缺口。

### 新会话开关

真机 DOM 取证（2026-11-10，DeepSeek）：
- 深度思考：\`div.ds-toggle-button.ds-toggle-button--selected\`，\`aria-pressed="true"\`
- 智能搜索：\`div.ds-toggle-button\`，\`aria-pressed="false"\`

无现成扩展点。需在 provider 增加可选钩子，由主进程在新对话页面就绪后、\`initProject\` 之前注入执行。

### 指纹死字段

\`FingerprintConfig\` / \`FingerprintPreset\` 有 \`screenWidth\` / \`screenHeight\` / \`devicePixelRatio\`，
预设池与 \`normalizeFingerprintConfig\` 均有处理，但 \`buildFingerprintScript\` 的 \`cfgJson\` **只打包 6 个字段**，
UI / IPC 层零引用 → 三个字段存储但不生效。属代码卫生问题，会误导维护者。

## 方案

### A. 反向停止同步补齐

在 \`src/bridge/harness-bridge.ts\` 的 \`onUserStop\` 回调补两行：
\`\`\`ts
try { requestAbort(); } catch (_) {}
try { cancelPendingSend(); } catch (_) {}
\`\`\`
与 \`harness-stop-signal\` 的处理对齐。\`cancelPendingSend\` 已在文件顶部导入，\`requestAbort\` 同样已导入。

不动 \`clearInputArea\`（网页已停止时输入框通常是空的，且用户可能在打字，不应擅自清空）。
不动 \`setWatchdogSuspended\`（网页停止是正常终态，看门狗本就该工作）。

### B. 新会话开关预设

**扩展点**（\`src/providers/types.ts\`）：
\`\`\`ts
/**
 * 可选的「新会话默认开关」实现。
 * 新开对话页面就绪后、发送系统提示词之前执行，用于设置该平台的功能开关
 * （如 DeepSeek 的深度思考/智能搜索）。
 * 被序列化注入 AI 页面主世界执行，**必须自包含**，签名 (doc, win) => void。
 */
setupNewSession?(doc: any, win: any): void;
\`\`\`

**DeepSeek 实现**（\`src/providers/deepseek.ts\`）：
自包含函数，按 \`aria-pressed\` 判断当前状态，只在需要时点击：
- 深度思考：\`aria-pressed !== 'true'\` → 点击
- 智能搜索：\`aria-pressed === 'true'\` → 点击

用 \`PointerEvent\` 序列点击（与 \`stopGeneration\` 的 \`clickInPage\` 一致，站点只认真实指针事件）。

**主进程调用**（两处新对话入口）：
- \`src/app/ipc/shell.ts\` 的 \`web-new-conversation\`：\`waitInput\` 回调内、\`ensureWorkspaceTrust\` 之前
- \`src/app/ipc/session.ts\` 的 \`startNewConversationForProject\`：\`onLoad\` 的 \`setTimeout\` 回调内、\`ensureWorkspaceTrust\` 之前

抽一个共享辅助函数放到 \`src/app/ipc/harness.ts\` 导出（\`applyNewSessionPreset(ctx)\`），
两处调用，避免重复代码。

### C. 指纹字段清理

从以下位置删除 \`screenWidth\` / \`screenHeight\` / \`devicePixelRatio\`：
- \`FingerprintPreset\` 接口
- \`FingerprintConfig\` 接口
- \`HARDWARE_PRESETS\` 六套预设
- \`generateFingerprint\` 返回值
- \`normalizeFingerprintConfig\` 的读取与返回

保留 \`fingerprint.ts:286\` 的行为与注释，注释改为说明"尺寸类一律保持真实，不在配置中建模"。

**兼容性**：旧 profile 的 JSON 里残留这三个字段，\`normalizeFingerprintConfig\` 不再读取它们，返回对象不含这三个 key。读取侧无消费者（grep 零命中），不影响任何功能。

测试同步：\`test/app/fingerprint.test.js:17-18\` 删除两行断言，新增一条断言验证 \`buildFingerprintScript\` 的 \`cfgJson\` 不含这三个 key。

## 验收标准

- [x] 网页点停止 → 纯净模式同步收尾，且取消在途发送
- [x] 纯净模式点停止 → 网页停止（既有能力，回归不退化）
- [x] DeepSeek 新对话默认开启深度思考、关闭智能搜索
- [x] 其他平台新对话行为不变
- [x] 指纹配置不再有死字段，注入脚本行为完全不变
- [x] typecheck / test(135 文件 1396 用例) / lint(0 errors) / compile 全绿
- [ ] 真机验证（开发版 \`cuckoo-dev-verify\`）

## 实施记录（与原方案的偏差）

### A. 反向停止同步：补两行之外，还修了一个递归 bug

按原方案在 `harness-bridge.ts` 的 `onUserStop` 补了 `requestAbort()` + `cancelPendingSend()`。
补完立即暴露一个**既有隐患**：`onUserStop` 的订阅者自己会调 `requestAbort`，而
`requestAbort` → `emitUserStop` → 订阅者 → `requestAbort` 构成无限递归。

实测（最小复现）：旧实现回调执行 **2974 次**后被栈溢出兜住（每层 try/catch 吞掉异常），
表面无异常，实际 `task-idle` / `ai-stop` 上报被放大上千倍。

修法（`observer.ts`）：
1. `requestAbort` 加幂等短路（已在中止态则不再广播）
2. `stopped` 分支**不再**把 `abortRequested` 重置为 false，改为置 true 后再广播
   （原实现先重置再广播，导致幂等判断失效，是递归的直接成因）
3. 中止标志统一由 `clearAbort()` 在"下一条用户消息"时复位

回归测试：`test/bridge/intercept/observer.test.js` 新增「requestAbort 幂等」用例。

### B. 新会话开关：扩展点签名修正 + 覆盖全部入口

- **签名修正**：`Provider.setupNewSession` 原写成 `(doc, win) => void`（直接执行语义），
  但 DeepSeek 实现返回的是函数（工厂语义，与 `getStopFn` 一致），调用方也按工厂用。
  已改为 `setupNewSession?(): (doc, win) => any`。
- **就绪轮询**：`applyNewSessionPreset` 改为最多 10 次 × 200ms 重试。
  DeepSeek 返回 `{ ready, found }` 表示"目标开关已出现在 DOM"，未就绪则重试——
  否则 `did-finish-load` 后按钮还没画出来，只执行一次会静默失败。
  超时后继续走新会话流程（开关是增强项，不阻断初始化）。
- **入口覆盖**：除原方案的两个入口外，补了 `harness-new-conversation`
  （纯净模式自己的「新对话」按钮，原来只 loadURL，完全没应用预设），
  以及 `web-new-conversation` 的**无项目目录分支**。

### C. 指纹字段清理

按方案执行。额外在测试里加了「防回潮守卫」：
- 注入脚本不得出现 `screenWidth` / `screenHeight`
- `FP` 配置对象必须恰好是 6 个实际生效字段

## 遗留 / 后续

1. **封号风险**：指纹伪装只降低"被识别为自动化"的概率，降不了"被识别为高频异常账号"。
   真正影响风控的是使用方式（多窗口并行、超长任务、连续几十轮工具回传）。
2. **已知边界**：DeepSeek 停止按钮仅在生成中显示，工具执行期/延迟回传期点不到，
   所以"网页 → 应用"的反向停止主要靠 hook 的 `status=stopped` 事件。
   本次补齐的 `requestAbort` / `cancelPendingSend` 属于防御性加固。
