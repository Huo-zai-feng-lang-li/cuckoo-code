# 需求档案 082：修复纯净模式历史消息编辑未生效缺陷

- **编号**：082
- **类型**：fix
- **标题**：修复纯净模式历史消息编辑未生效缺陷
- **状态**：done
- **更新**：2026-10-18

---

## 一、背景与问题根因

用户反馈：“纯净模式下历史会话点击编辑没有修改成功”。

经过全链路代码排查与架构分析，定位到以下核心根因：

### 1. 历史消息缺乏“就地保存”能力
在 `src/ui/harness.html` 的 `editUserMessage` 实现中：
- 当用户编辑非最后一条的“历史消息”时，操作栏仅提供：`取消`、`填入输入框`、`从此处截断重发`。
- **根本没有提供“保存修改”按钮**。如果用户仅想修正提示词或错别字并保存历史记录，无法完成保存。
- 点击“填入输入框”会触发 `cancel()` 将气泡还原为原始文本，原消息未被修改。

### 2. 截断重发与 Ctrl+Enter 粗暴失败并丢弃用户输入
- 用户修改完后按 `Ctrl+Enter`，代码执行 `doTruncate()`。
- `doTruncate()` 依赖 `resolveTruncateWebMsgId(targetIdx)` 解析底层网页消息 ID。
- 在纯净模式原生会话、首条用户提问（无前置 assistant）、或缺少 `webMsgId` 时，函数直接执行 `cancel()` 强制取消编辑、丢弃用户输入，并抛出系统错误：“此会话不支持精确截断（缺少网页消息记录）”，导致修改彻底失败。

### 3. 会话重命名 IPC 缺少广播通知
- 主进程 `set-session-title` 处理完后，未向窗口派发 `shell-sessions-changed` 事件，导致跨视图/跨窗口联动刷新不及时。

---

## 二、架构方案与技术设计

### 1. 纯净模式历史消息编辑闭环（`src/ui/harness.html`）
1. **就地保存（`doSaveOnly`）**：
   - 为历史消息提供清晰的“保存修改”按钮（设为 primary）；
   - 更新当前气泡 DOM，更新 `histItem.text` 及 `history` 对应条目；
   - 触发 `saveHist()` 本地持久化，并调用 `updateConvNav()` 更新导航点；
   - 重新挂载 user actions 闭包，确保后续再次点击编辑能取得最新文本。
2. **快捷键规范**：
   - `Escape`：取消编辑，恢复原文；
   - `Ctrl+Enter` / `Cmd+Enter`：
     - 若为最后一条消息：重新发送（`doSubmitLatest`）；
     - 若为历史中间消息：执行安全就地保存（`doSaveOnly`），避免误破坏后续对话或因截断失败丢失输入。
3. **弹性截断重发（`doTruncate`）**：
   - 若支持网页端精确截断（`webMsgId != null && api.truncate`），走官方网页会话分支；
   - 若不支持网页端截断（纯净模式首条消息 / 无 webMsgId / 纯本地），**绝不直接报错取消**，而是回退至本地物理截断重发：
     调用 `truncateUserMessage(msgEl, histItem)` 清理当前及后续消息节点与历史，将新内容送入 `input` 并触发 `send()`，实现纯净模式下的重新接续生成。
4. **编辑态界面保护**：
   - 进入编辑时隐藏或移除当前卡片的悬浮 actions，退出/保存时重新挂载，避免编辑期间悬浮按钮冲突。

### 2. 主进程会话重命名广播补齐（`src/app/ipc/session.ts`）
- 在 `set-session-title` 处理成功后，向窗口派发 `shell-sessions-changed`，确保所有窗口与侧边栏的会话列表即时感知并同步标题。

---

## 三、修改清单

- `docs/requirements/082-fix-harness-history-edit.md`：需求档案
- `src/ui/harness.html`：就地保存功能、截断重发弹性降级闭环、编辑态交互优化
- `src/app/ipc/session.ts`：补齐 `set-session-title` 的 sessions-changed 广播通知
- `test/ui/harness-history-edit.test.js` 或对应测试：验证编辑保存与截断重发逻辑

---

## 四、验证标准

1. `npm run typecheck` + `npm test` + `npm run lint` + `npm run compile` 全绿。
2. 历史消息编辑可就地保存，文本、历史数组与 localStorage 均正确更新。
3. 历史消息截断重发在无 webMsgId 场景下能够优雅降级为本地截断并重新发送，不报错丢弃。
