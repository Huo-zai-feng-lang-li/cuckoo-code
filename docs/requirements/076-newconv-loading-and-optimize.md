---
id: 076
type: feature
title: 新建对话 loading 遮罩 + 新建耗时优化 + tooltip 回归 DOM + 设置页图标折叠 + 通知摘要优化
status: done
branch: master（直接主分支）
created: 2026-10-16
updated: 2026-10-16
---

# 076 — 一批 UI/体验优化

## 背景
本轮多项体验修复（用户逐条反馈）。

## 交付
1. **点顶部「+」不弹「初始化项目」**：该弹窗是"首次使用提示"（首页 URL + 无项目目录即弹），被"开新对话"误触发。现点「+」写入时间标记（localStorage），overlay 10s 内不弹。
2. **点「+」显示新建 loading 遮罩**：居中呼吸图标 + 流光进度条，传达"正在新建"（此前页面停在空白首页无反馈）。
3. **新建对话耗时优化**：`did-finish-load` 后固定等 2000ms → 400ms（`shell.ts` + `session.ts`）。理由：`initial-prompt` 监听器在 preload 顶层同步注册（did-finish-load 时已就绪），输入框就绪由 chat-input 轮询保证。省约 1.6s。
4. **tooltip 换回 DOM 方案**：独立透明窗口方案（v0.9.14）在 Windows 上闪烁、体验差 → 回退为 DOM 版（跟手）；同时保留"顶部工具栏不弹 tooltip"。删除独立窗口 4 个文件。
5. **设置页活动栏图标可折叠 + 动态读取**：默认收起，展开后竖排；动态读 DOM（含插件图标）→ **Agent 模式可隐藏**。
6. **通知摘要优化**：正文 2 行 → 3 行；卡片高 118 → 154；底部内边距加大（避免摘要被进度条压住）。

## 关键文件
- `src/app/ipc/shell.ts`（新建标记 + 延时 400 + notifyDone + tooltip ipc 移除）
- `src/app/ipc/session.ts`（延时 400）
- `src/overlay/panel.ts`（10s 内不弹首次提示）
- `src/ui/shell/scripts/newconv-loading.ts`（新）
- `src/ui/shell/scripts/tooltip.ts`（回归 DOM）
- `src/ui/shell/scripts/pages/settings.ts` + `partials/pages/settings.html`（图标折叠）
- `src/app/notification-window.ts` + `src/ui/notification-window.html`（摘要）
- 删除：tooltip-window/preload/html/ipc

## 验收
- typecheck / test(988) / lint(0 error) / compile 全绿
- 真机：loading 遮罩正常显示/隐藏；tooltip 跟手
