---
id: 073
type: fix
title: 通知浮窗图片按真实比例完整显示 + 进度条渐变
status: done
branch: fix/073-notif-pic-progress
created: 2026-10-16
updated: 2026-10-16
---

# 073 — 通知浮窗图片比例 + 进度条渐变

## 背景
用户反馈：① 通知浮窗图片区固定 100px + `object-fit:cover`，把 900×408（2.21:1）的图**裁切压扁**，显示不完整；② 进度条渐变太单调。

## 修复
1. **图片按真实比例**：图片区初始 180px，图片加载后由 `applyPicRatio(naturalWidth, naturalHeight)` 按真实宽高比计算精确高度（clamp 80~320px），完整显示不裁切；高度变化后重新测量卡片总高回传主进程。
2. **进度条渐变**：4 段渐变（实色 → 提亮 → 实色 → 淡出）+ 同色系外发光，缩短时右端先消隐，有"流光"走向。

## 改动文件
- `src/ui/notification-window.html`（.pic-wrap 高度自适应 + applyPicRatio + measureAndResize 抽取 + .timer 渐变）
- `src/app/notification-window.ts`（PIC_HEIGHT 100→180 初始占位）

## 验证
- 实测：图片 900×408 → 完整显示 175px 高（比例 2.21，无裁切）；进度条 4 段渐变生效。
- typecheck / test(988) / lint(0 error) / compile 全绿。
