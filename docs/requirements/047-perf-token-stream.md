---
id: 047
type: performance
title: 性能修复：token 统计同步 IO 放大 + 流式 stripToolBlocks O(n²)
status: doing
branch: (直接主分支)
created: 2026-10-13
updated: 2026-10-13
---

## 背景

深度性能排查发现两处确凿热点：

1. **token 统计同步 IO 放大**（`src/app/token-stats.ts`）：每次 AI 上报 token（`update-token-usage`）会触发 **1 次 writeFileSync + 8 次 readFileSync** 整个 `token-stats.json`（pushTokenUsage 读 3 次、broadcastSystemTotal 读 1 次、broadcastWindowUsage 读 3 次、setWindowUsage 内部 readRaw+getTotal 读 2 次），全部同步阻塞主进程。
2. **流式 stripToolBlocks O(n²)**（`src/bridge/harness-bridge.ts`、`feishu-bridge.ts`）：`stripToolBlocks` 在 `onStream` 每帧被调用，对**全量正文**跑 3 个正则；正文随生成增长 → 长回复下累积开销显著。

## 目标

消除上述两处热点，保持对外行为不变。

## 改动

### token-stats 内存缓存
- 新增模块级 `_cache`，`readRaw()` 命中缓存不再读盘；`writeRaw()` 同时更新缓存
- 写盘失败 → `_cache = null` 使缓存失效，下次读回退磁盘真相（闭合内存/磁盘不一致缺口）
- 保持原「同步 IO + 主进程单线程」并发假设（未引入 await）
- `readRaw` 注释标注「返回共享缓存引用，调用方只读或经 writeRaw 提交」

### stripToolBlocks 快速路径
- 加 `if (text.indexOf('```') === -1) return text.trim();`：无围栏时跳过 3 个全文正则（与正则路径严格等价——三正则均以 ``` 开头）
- 删 harness-bridge 冗余 `.trim()`（函数内部已 trim）

## 验证

- typecheck / test 980 / lint 0 error / compile 全绿
- 真机：连续两次 token 上报（80000 → 95000 → 111111），磁盘与壳页面读值始终一致，验证缓存无 stale 覆盖
- code-reviewer 审查：改动 2 严格等价（9/10）；改动 1 核心正确，采纳其「写盘失败回退」建议