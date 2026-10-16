---
id: 070
type: feature
title: 纯净模式生成中禁用工作区其他会话切换 + package.json 脚本默认折叠
status: done
branch: feat/070-ws-busy-disable
created: 2026-10-16
updated: 2026-10-16
---

# 070 — 生成中禁用工作区会话切换 + 脚本默认折叠

## 背景

1. **生成中切换会话有风险**：纯净模式下 AI 正在回复/跑工具时，点工作区列表切到其他会话会：
   - 纯文本生成：页面导航中断流（基本无害）；
   - 工具执行中：工具在后台跑完但结果回传上下文已随导航销毁 → **工具白跑、AI 卡住**。
   - 待发队列被清空（此为用户消息队列，切到不同会话不应迁移，属正确行为）。
   「对话」页（conversations.ts）已有 harnessBusy 置灰禁用能力；**「工作区」页缺失**。

2. **任务页 package.json 脚本列表默认展开**占垂直空间，用户希望默认折叠。

## 目标

- 工作区页：harness 生成中，**非当前会话**置灰禁用切换（重命名/归档/删除仍可用，当前会话不置灰）。
- 任务页：package.json 脚本列表默认折叠。

## 方案

### 工作区页禁用
- 新增模块级 `harnessBusy`，订阅 `api.onHarnessBusy`（复用既有 harness→主进程→壳页面链路，无需新增 IPC）。
- `renderItem`：`harnessBusy && !isCur` → 加 `ck-ws-disabled` 类。
- 点击处理：`harnessBusy && !current` 时早退（双保险，防 CSS pointer-events 未覆盖）。
- CSS：`.ck-ws-item.ck-ws-disabled` 降透明度 + not-allowed 光标。

### 任务页默认折叠
- `tasks.html`：caret 加 `ck-git-caret-c`、列表加 `cuckoo-hidden`（初始折叠）。

## 改动文件
- `src/ui/shell/scripts/pages/workspaces.ts`
- `src/ui/shell/styles/components.css`
- `src/ui/shell/partials/pages/tasks.html`

## 验收
- 生成中：非当前会话置灰、点击无效；当前会话正常；重命名/归档/删除仍可用。
- 生成结束：置灰自动解除。
- 任务页 package.json 脚本默认折叠，点击标题可展开。
- typecheck / test / lint / compile 全绿。
