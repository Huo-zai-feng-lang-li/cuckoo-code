---
name: bridge
paths:
  - "src/bridge/**/*.ts"
---

# bridge 层规则

bridge 是 preload（与 AI 网页桥接）。

- ❌ 不可 import `session/`、`app/`
  - **已知例外（有意为之）**：`bridge/entry.ts` 直接 import `session/compaction.js` 的 `prepareSwitchShare` / `prepareTruncate`（窗口切换分享与截断的预备动作）。暂不拆；新增其它 session 依赖仍应避免。
- ✅ 可依赖 `infra/providers/tools/overlay`
- **不读写 `overlay/state.ts`**——数据经**回调推送**（`onInterceptedResponse` 等）
- 操作 AI 页面用 `view.webContents`
