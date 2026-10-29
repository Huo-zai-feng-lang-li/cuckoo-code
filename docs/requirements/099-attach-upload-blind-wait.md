---
id: 099
type: fix
title: 修复附件上传后的无谓盲等（删除 attachDelay 配置项）
status: done
branch: fix/099-attach-upload-blind-wait
created: 2026-10-29
updated: 2026-10-29
---

# 需求 099：修复附件上传后的无谓盲等

## 1. 背景

`attachFile` 工具把文件塞进 `<input type=file>` 后，注入脚本无条件先
`await sleep(waitMs)` 再检查附件 chip 是否出现，`waitMs` 来自「附件上传后检测等待」
设置项（默认 1~10 秒，用户可调到 6~20 秒）。

**问题**：

- `DataTransfer` + `change` 是同步动作，页面处理通常几百毫秒
- 盲等期间不做事，纯浪费
- 后面本来就有 300ms 轮询 + 15 秒超时兜底，完全能覆盖慢情况
- 该设置项语义与「发送延迟」高度混淆（用户反复询问两者区别）
- 初始引入（449331b）默认 0.5~1 秒，全局化时（71412c5）被放大到 1~10 秒

## 2. 方案

### 2.1 删除盲等（src/tools/impl/attach-file.ts）

注入脚本改为「**先查后轮询**」：

```
change 事件 → 立即 fileVisible() 检查
           → 未命中才进 300ms 轮询（上限 UPLOAD_TIMEOUT_MS = 15 秒）
```

`buildInjectCode` 删除 `waitMs` 参数，`execute` 删除 min/max 随机延迟计算。

### 2.2 删除失效配置项（6 处）

盲等删除后 `attachDelayMin/Max` 成为死参数，整条配置链一并移除：

- `src/app/global-settings.ts` — 字段、默认值、钳制、返回
- `src/app/ipc/tool.ts` — execute-js 透传
- `src/bridge/api.ts` — **关键**：不再从 localStorage 读（否则用户旧值永久生效且无法修改）
- `src/overlay/panels/settings.ts` — 字段、默认值、校验、写入、reset KEYS
- `src/ui/shell/partials/pages/settings.html` — UI 输入框
- `src/ui/shell/scripts/pages/settings.ts` — SET_FIELDS、collectSettings

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/tools/impl/attach-file.ts` | 删盲等，删 waitMs 参数 |
| `src/app/global-settings.ts` | 删字段/默认值/钳制 |
| `src/app/ipc/tool.ts` | 删透传 |
| `src/bridge/api.ts` | 删 localStorage 读取（断链关键） |
| `src/overlay/panels/settings.ts` | 删字段/校验/写入/reset |
| `src/ui/shell/partials/pages/settings.html` | 删 UI |
| `src/ui/shell/scripts/pages/settings.ts` | 删字段映射 |
| `src/tools/runtime/JsRunner.ts` | 注释同步 |
| `test/app/global-settings.test.js` | 删附件断言 |
| `test/overlay/panels/settings.test.js` | 删附件测试；修正一个靠附件校验蹭过的假测试 |

## 4. 验收标准

- [x] 附件上传不再有固定盲等，首次检查立即执行
- [x] 慢情况下 300ms 轮询 + 15 秒超时兜底仍然有效
- [x] 设置页不再显示「附件上传后检测等待」
- [x] localStorage 旧值不再被读取（不再影响行为）
- [x] typecheck / test / lint / compile 全绿
