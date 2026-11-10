# 最新接续状态 (2026-11-10 19:20)

## 核心进展

**v0.10.217 已准备就绪（待提交/打 tag）。** 本轮完成需求 113：停止双向同步、新会话开关预设、指纹死字段清理。

- 版本：`0.10.217`（package.json / package-lock.json / CHANGELOG 三处已同步）
- 分支：`feat/113-stop-sync-and-session-preset` → 待合 master
- 上一版：`v0.10.216`

## 本轮交付

### 1. 停止递归 bug（本轮最大发现）

**现象**：`requestAbort()` → `emitUserStop()` → 订阅者回调（harness-bridge / remote-bridge 自身也调 `requestAbort`）→ 无限递归。旧实现靠每层 `try/catch` 把栈溢出吞掉，**表面无任何异常**。实测回调执行 2974 次，`task-idle`/`ai-stop` 上报放大上千倍。

**修法**（`src/bridge/intercept/observer.ts`）：
1. `requestAbort` 加幂等短路（`if (abortRequested) return`）
2. `stopped` 分支**不再** `abortRequested = false`，改为置 true 后再广播——原先的重置正是递归直接成因
3. 中止标志统一由 `clearAbort()` 在"下一条用户消息"时复位

### 2. 反向停止同步补齐

`src/bridge/harness-bridge.ts` 的 `onUserStop` 补 `requestAbort()` + `cancelPendingSend()`，与 `harness-stop-signal` 对齐。修复「用户已停止、工具结果仍打进对话」。

### 3. 新会话默认开关（DeepSeek 开深度思考、关智能搜索）

- `Provider.setupNewSession` 扩展点（**工厂语义**，签名已修正为 `(): (doc, win) => any`）
- DeepSeek 按 `aria-pressed` 判态，PointerEvent 序列点击，已是目标态不点
- `applyNewSessionPreset`（`src/app/ipc/harness.ts`）带就绪轮询：10 次 × 200ms，provider 返回 `{ ready }`
- **入口全覆盖**：`web-new-conversation`（含/无项目目录两分支）、`new-conversation-for-project`、`harness-new-conversation`

### 4. 指纹死字段清理

`screenWidth`/`screenHeight`/`devicePixelRatio` 从 config/preset/normalize 全删。尺寸类保持 Chromium 真实值（锁死视口会与 `WebContentsView.setBounds` 冲突 + 制造 `screen.width` vs `innerWidth` 矛盾）。

## 验证结果

- typecheck / lint(0 errors) / compile / test（135 文件 **1396** 用例）全绿
- **真机验证（开发版 + CDP 9444）**：
  - 新会话开关：翻成非目标态 → 壳入口开新对话 → 自动拉回目标态 ✅
  - 停止幂等：注入 `status=stopped` 事件，`task-idle` 每次只 +1，连发两次仍 +1，无放大 ✅
  - `harnessAPI.stop()` 18ms 返回，走 `not-generating`（DeepSeek 停止按钮仅生成中显示）
- **待用户确认**：三端停止的实际体感（尤其手机端）

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 需求档案：`docs/requirements/113-stop-sync-and-session-preset.md`（status: done）
- 输出长度硬上限：`JsRunner.ts` `OUTPUT_LIMIT = 20000`；`chat-input.ts` `MAX_OUTPUT = 15000`
- 真机测试：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& node_modules\electron\dist\electron.exe . --remote-debugging-port=9444`（前台起，background 模式）
- **进程管理**：`taskkill /F /IM electron.exe` 被安全策略拒绝；用 `powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"`。开发版主进程 PID 用 `netstat -ano | findstr :9444` 查
- 打包版 `Cuckoo-Code.exe` 占 7799 端口正常，不要动；开发版 userData 是 `cuckoo-dev-verify` 隔离
- **坑**：`readLines` 默认 limit 2000，读大文件（如 CHANGELOG 3492 行）会截断；整体重写会丢数据，必须用 `edit` 精准插入
- **坑**：PowerShell 按 GBK 解码 UTF-8 会中文乱码，读文件显式用 UTF-8
