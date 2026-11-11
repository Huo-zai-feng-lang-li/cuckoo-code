---
id: 118
type: fix
title: 纯净模式发送状态同步与长文本/初始化提示词附件通道修复
status: done
branch: fix/117-pure-mode-status-and-prompt-attachment
created: 2026-11-11
updated: 2026-11-11
---

# 118：纯净模式发送状态同步与长文本/初始化提示词附件通道修复

> 状态：**done**
> 分支：`fix/117-pure-mode-status-and-prompt-attachment`
> 最近更新：2026-11-11

## 一、用户原始目标与痛点背景

1. **纯净模式等待与长暂停状态丢失**：在纯净模式（Harness）下，界面不显示"等待发送"倒计时与随机长暂停宠物气泡提示。
2. **长文本输入未走附件**：用户在纯净模式输入超过 4000 字符的长需求时，仍作为普通文本粘贴，未转为附件。
3. **新会话长系统提示词未走附件**：初始化新对话时注入的长系统提示词（通常多达上万字符）未转为附件，暴露了脚本机械特征，存在高危风控风险。

## 二、架构根因分析

### 2.1 真机日志确证的主根因（最关键）

```
回传 JS 汇总执行结果, 消息长度=4102
附件通道失败，回退 insertText: debugger-busy
```

**`wc.debugger` 被 `net-identity.ts` 常驻占用**：启用代理/指纹时，`applyNetIdentity` → `ensureDebugger` 执行 `wc.debugger.attach('1.3')` 后**永不释放**（`releaseDebugger` 只在打开 DevTools 前调用）。

而 `cdpAttach` L65 是**独占式**判定：`if (wc.debugger.isAttached()) return { success: false, error: 'debugger-busy' }`。

→ **只要开启了代理或指纹（真实用户默认场景），整个会话内附件通道 100% 失效**，长文本全部静默回退到 `insertText` 全文注入，恰好是需求 115/118 要消灭的机器特征。开发环境因未开代理（`needShield=false`）不 attach，故能测通。

### 2.2 其余根因

1. **`renderSendTick` 运行时未定义变量异常**：`src/ui/harness.html` 的 `renderSendTick()` 直接使用 `sendSec`，作用域内未定义 → `ReferenceError`，中断状态栏渲染与宠物气泡更新。
2. **定时器过早自停**：`sendTickTimer` 轮询判据 `if (!statusText || (!generating && toolRunningCount <= 0))`，工具执行完、AI 下一轮尚未开始时（正处等待发送/长暂停），第 1 秒即被误杀。
3. **系统提示词与用户长输入被附件通道排除**：`usesNaturalDelivery(tag)` 把 `'系统提示词'` 判为 `false`；`ATTACH_THROTTLE_MS = 60000` 节流误拦新对话初次提示词与用户手动长输入。
4. **CDP 深度查询限制与事件未唤醒**：`DOM.getDocument` 仅 `{ depth: 1 }`，深层 `input[data-cuckoo-attach-input]` 检索不到；注入后未派发 `input`/`change` 唤醒前端状态机。

## 三、修复设计

1. **`src/app/ipc/cdp-attach.ts`（根因修复）**：
   - 引入 `ownsDebugger` 标记：仅当自身 `attach` 时才在 `finally` 中 `detach`；
   - 若 `wc.debugger.isAttached()` 为真（被 net-identity 常驻占用），**复用现有连接**而非返回 `debugger-busy`；
   - 采用 `Runtime.evaluate` + `DOM.requestNode` 精确取 `nodeId`，兜底 `DOM.getDocument({ depth: -1 })`；
   - 文件注入后派发 `input` 与 `change` 事件。
2. **`src/ui/harness.html`**：
   - 补齐 `var sendSec = ...`；
   - 自停判据加入 `&& !sendPauseActive`。
3. **`src/overlay/chat-input.ts`**：
   - 抽出 `shouldAttach(tag, len)`，放行系统提示词、`JS汇总` 与用户消息；
   - 节流仅作用于 `JS汇总`；
   - `lastAttachAt` 仅由工具结果刷新，避免系统提示词上传后把紧随的首轮工具结果挤回 insertText；
   - 定制文件名前缀（`系统设定-` / `用户需求-` / `工具输出-`）。
4. **`src/providers/deepseek.ts`**：增强 `getAttachReadySource` 卡片匹配容错（输入框范围放宽、子串匹配）。

## 四、验证结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `npm run typecheck` | ✅ 0 错误 |
| test | `npm test` | ✅ 146 文件 / 1477 用例 100% 通过 |
| lint | `npm run lint` | ✅ 0 errors / 71 warnings（均为历史遗留，src 不在 lint 覆盖范围） |
| compile | `npm run compile` | ✅ 全量重建成功 |

新增回归测试：
- `DeepSeek 平台超长系统提示词转为附件通道发送`
- `DeepSeek 平台用户长消息转为附件通道发送`
- `debugger 被外部常驻占用（如 net-identity）时复用连接，且不擅自 detach`
