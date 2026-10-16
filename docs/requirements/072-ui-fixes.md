---
id: 072
type: feature
title: 活动栏图标显隐设置 + Token 图标统一 + 通知浮窗高度自适应
status: done
branch: fix/072-ui-fixes
created: 2026-10-16
updated: 2026-10-16
---

# 072 — UI 修复合集

## 背景
UI 评审发现：① 活动栏图标过多（20 个），高频功能（记忆/远程控制）被溢出塞进「⋯」；用户要求可自定义显隐。② Token 图标用文字「元」，与其余 19 个线条图标不一致。③ 通知浮窗内容不足时底部留白过大。

## 目标
1. **活动栏图标显隐**：设置页新增「活动栏图标」卡片，逐个开关控制显示/隐藏；即时生效、持久化（localStorage）。settings 不可隐藏（防死锁）。
2. **Token 图标**：文字「元」→ 硬币 SVG（与其余图标统一）。
3. **通知浮窗高度自适应**：渲染后测量内容真实高度回传主进程，贴合窗口消除底部空白。

## 改动文件
- 新增 `src/ui/shell/scripts/activitybar-visibility.ts`（显隐状态 + 应用）
- `src/ui/shell/scripts/pages/settings.ts` + `partials/pages/settings.html`（设置卡片）
- `src/ui/shell/scripts/activitybar-overflow.ts`（溢出跳过用户隐藏项）
- `src/ui/shell/scripts/activitybar-drag.ts`（拖拽跳过用户隐藏项）
- `src/ui/shell/partials/activitybar.html`（Token 图标换 SVG）
- `src/ui/shell/styles/base.css`（`.ck-ab-user-hidden`）
- `src/ui/shell/scripts/main.ts`（初始化）
- `src/app/notification-{preload,window}.ts` + `src/ui/notification-window.html`（高度自适应，已改）

## 验收
- 设置页可逐个开关活动栏图标，即时生效、重启保留；settings 不可隐藏。
- Token 图标为硬币 SVG，风格统一。
- 通知浮窗底部无多余空白。
- typecheck / test / lint / compile 全绿。
