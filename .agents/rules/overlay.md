---
name: overlay
paths:
  - "src/overlay/**/*.ts"
---

# overlay 层规则

overlay 是**纯 UI**，**不知道** bridge/session 的存在。

- ❌ 不可 import `bridge/`、`session/`、`app/`
  - **已知例外（有意为之）**：`overlay/events.ts` 直接 import `session/compaction.js`（`runCompaction` / `checkPendingCompact` / `checkPendingInit` / `checkPendingSwitchShare` / `checkPendingTruncate`）。这是压缩流程的特例，暂不拆；新增其它 session 依赖仍需走回调注入。
- ✅ 需要下层能力时，用**回调注入**（如 `wireEvents`、`wireChatInput`）
- 状态只放 `overlay/state.ts`，且仅 overlay 内部用
- UI 模板真源：`src/overlay/template/overlay.{html,css}`，改完要 `npm run compile`
