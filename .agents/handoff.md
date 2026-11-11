# 最新接续状态 (2026-11-11 v0.10.222 附件通道 debugger 占用根因修复)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`master`（已打 tag `v0.10.222` 并推送到远程）
> 当前版本：`0.10.222`（下一版 `0.10.223`，再下 `0.10.225`，版本号任意位置禁含数字 4）

---

## 0. 总览：附件通道全线失效的根因已定位并修复

四门禁全绿（146 个测试文件、1477 个用例 100% passed，编译/类型检查/代码规范全绿）。

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| A 需求 118：附件通道 debugger 占用根因修复 | ✅ 已闭环 | 复用连接 + ownsDebugger，代理/指纹场景恢复 |
| B 长系统提示词与用户长输入改走附件 | ✅ 已闭环 | shouldAttach + 节流隔离 + 语义化文件名前缀 |
| C 纯净模式状态栏/长暂停计时恢复 | ✅ 已闭环 | sendSec 未定义 + 自停判据补 sendPauseActive |
| D DeepSeek 附件就绪判定容错增强 | ✅ 已闭环 | 输入框范围放宽 + 子串匹配 |

---

## 1. 核心根因与修复（2026-11-11 真机日志确证）

### 1.1 【最关键】附件通道被 debugger 常驻占用而全线失效

- **现象**：用户报告新开对话后长文本仍被批量灌入输入框，未转附件；而开发环境测试却能通过。
- **真机日志决定性证据**：
  ```
  回传 JS 汇总执行结果, 消息长度=4102
  附件通道失败，回退 insertText: debugger-busy
  ```
- **根因**：`src/app/net-identity.ts` 在启用代理/指纹时 `applyNetIdentity` → `ensureDebugger` 执行 `wc.debugger.attach('1.3')` 后**永不释放**（`releaseDebugger` 仅在打开 DevTools 前调用）。而 `src/app/ipc/cdp-attach.ts` L65 是**独占式**判定：`if (wc.debugger.isAttached()) return { success: false, error: 'debugger-busy' }`。
  → **只要开启代理或指纹（真实用户默认场景），整个会话内附件通道 100% 失效**，长文本全部静默回退 `insertText` 全文注入。开发环境未开代理（`needShield=false`）故不 attach，才能测通。
- **修复**（`src/app/ipc/cdp-attach.ts`）：
  - 新增 `ownsDebugger` 标记，仅当自身 attach 时在 `finally` 中 `detach`；
  - `isAttached()` 为真时**复用现有连接**，不再返回 `debugger-busy`；
  - 绝不抢断外部占用者（net-identity）的 debugger 会话。

### 1.2 CDP 深层节点定位与前端状态唤醒

- `DOM.getDocument` 原用 `{ depth: 1 }`，深层 `input[data-cuckoo-attach-input]` 检索不到。
- 改为优先 `Runtime.evaluate` + `DOM.requestNode` 精确取 `nodeId`，兜底 `DOM.getDocument({ depth: -1 })`。
- 文件注入后派发 `input` / `change` 事件，唤醒 React/Vue 受控状态机。

### 1.3 纯净模式发送状态栏与长暂停计时

- `src/ui/harness.html` 的 `renderSendTick()` 直接使用 `sendSec` 但作用域内未定义 → `ReferenceError` 中断状态栏与宠物气泡渲染。已补齐 `var sendSec = sendStartAt > 0 ? Math.floor((Date.now() - sendStartAt) / 1000) : 0;`。
- 定时器自停判据补入 `&& !sendPauseActive`，随机长暂停期间不再被误杀定格。

### 1.4 长系统提示词与用户长输入改走附件

- `src/overlay/chat-input.ts` 抽出 `shouldAttach(tag, len)`：放行 `系统提示词`、`JS汇总` 与用户消息（`!isSystemTag(tag)`）。
- 节流（60s）仅作用于自动化工具循环（`JS汇总`）；系统提示词与用户手动长输入豁免。
- **`lastAttachAt` 仅由工具结果刷新**：否则系统提示词上传后，紧随的首轮工具结果会被节流挤回 `insertText`（等于没修）。
- 文件名前缀按语义区分：`系统设定-MMDD-HHMM.txt` / `用户需求-MMDD-HHMM.txt` / `工具输出-MMDD-HHMM.txt`。

### 1.5 DeepSeek 附件就绪判定容错增强

- `src/providers/deepseek.ts` 的 `getAttachReadySource`：输入框检索优先 `#chat-input`；附件卡片匹配范围放宽至 `boxTop - 260` ~ `boxBottom + 120`；支持子串匹配与文件名后缀边界判断。

---

## 2. 关键上下文

- 根目录：`d:\Desktop\Super-File\cuckoo-code`
- 核心文件：
  - `src/app/ipc/cdp-attach.ts`：CDP 附件通道（debugger 复用 + 深层节点定位 + 事件唤醒）
  - `src/app/net-identity.ts`：代理/指纹盾，**常驻占用 wc.debugger**（关键背景）
  - `src/app/ipc/send-as-file.ts`：`chat-send-as-file` IPC，复用 cdpAttach
  - `src/overlay/chat-input.ts`：`shouldAttach` / 节流 / 文件名前缀 / 发送串行链
  - `src/ui/harness.html`：纯净模式状态机、`renderSendTick`、长暂停事件
  - `src/providers/deepseek.ts`：`getAttachProbeSource` / `getAttachReadySource`

## 3. 后续建议

- **真机验证待补**：本次修复在 typecheck/test/lint/compile 全绿基础上提交，但"启用代理/指纹时附件通道恢复"需真机复验（开发版实例：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& npx electron . --remote-debugging-port=9444`）。验证要点：开启代理后发一条 >4000 字符的工具回传，确认日志出现 `长文本已走附件通道` 而非 `附件通道失败，回退 insertText: debugger-busy`。
- **静默降级建议**：附件失败目前静默回退 `insertText`，建议后续至少记录显式告警，避免同类问题长期潜伏。
