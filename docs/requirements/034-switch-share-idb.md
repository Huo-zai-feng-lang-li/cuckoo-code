---
id: 034
type: fix
title: 修复窗口组「转移对话」报错「IndexedDB 无该会话消息」
status: done
branch: (直接主分支)
created: 2026-10-12
updated: 2026-10-12
---

## 背景

点击「转移对话」（窗口组切换）**总是报错**：`切换失败：IndexedDB 无该会话消息`。
而「压缩」功能可用——两者都依赖读 IDB。

## 根因

两条路径读 IDB 的时机不同：

| 路径 | 做法 | 结果 |
|---|---|---|
| **压缩** | 清 IDB → **刷新**（带 flag）→ 等 hook 发 `cuckoo-idb-history-written` → 读 IDB（DeepSeek 已重建完整历史）→ 分享 | ✅ |
| **切换**（旧） | `shareAllForSwitch` **当前页直接读 IDB**，不刷新、不等重建 | ❌ 报"无该会话消息" |

`compaction.ts` 头注释已写明实测结论：**"同会话内 AI 回复后 IDB 不更新；刷新页面才会补齐"**。
旧切换实现走当前页直读，读不到记录 → 报错。

## 目标

让切换复刻压缩/截断的"清 IDB + 刷新 + 等重建 + 分享 + 回执"流程。

### 范围

- ✅ 新增 `prepareSwitchShare(reqId)`：清 IDB → URL 加 `cuckoo-switch-share` flag → 刷新
- ✅ 新增 `checkPendingSwitchShare()`：刷新后等 IDB 重建 → 全量分享 → 回执主进程
- ✅ hook flag 判定加 `cuckoo-switch-share`（触发 IDB 写入拦截）
- ✅ bridge handler 改调 `prepareSwitchShare`
- ✅ overlay 流程链接入 `checkPendingSwitchShare`
- ✅ 删除死代码 `shareAllForSwitch`（旧 bug 实现）
- ✅ `requestShareFromWindow` 超时 30s → 90s（跨刷新更慢）

## 方案

复用压缩/截断的成熟模式（三段式：段1清IDB+刷新 → 段2等重建+分享+回执）。
reqId 经 localStorage `cuckoo-switch-pending` 跨刷新传递，刷新后回执。

## 验收标准

- [ ] 「转移对话」不再报"IndexedDB 无该会话消息"
- [ ] 切换后目标窗口正确加载分享对话
- [ ] 压缩功能不受影响
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- 切换耗时增加（需清 IDB + 刷新重建，约数秒）；超时已放宽至 90s
- 需真机验证（IDB/刷新属运行时行为，单测覆盖不到）
