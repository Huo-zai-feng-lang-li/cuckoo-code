---
id: 075
type: fix
title: tooltip 改独立窗口（不被 AI 视图遮挡）+ Git 布局 + Token 图标还原
status: done
branch: fix/075-tooltip-git-token
created: 2026-10-16
updated: 2026-10-16
---

# 075 — tooltip 独立窗口 + Git 布局 + Token 图标

## 背景
1. **tooltip 被 AI 视图遮挡**（真机实测：顶部按钮 tooltip 与 AI 视图矩形 overlap=true）。AI 页面是 WebContentsView（原生层），CSS z-index 无效。
2. **Git 提交历史展开挤掉改动/暂存列表**（需求 074 引入自适应后，两边争空间）。
3. **Token 图标**用户要还原为文字「元」。

## 目标
1. tooltip 改用**独立透明置顶窗口**渲染（屏幕坐标定位、鼠标穿透、不抢焦点），永不被 AI 视图遮挡。
2. Git：改动列表与历史各保最小可见高度，互不挤没。
3. Token 图标还原文字「元」。

## 改动文件
- 新增：`src/app/tooltip-window.ts`、`src/app/tooltip-preload.ts`、`src/ui/tooltip.html`、`src/app/ipc/tooltip.ts`
- `src/app/ipc/index.ts`（注册）
- `src/app/shell-preload.ts` + `src/ui/shell/scripts/shell-api.ts`（暴露）
- `src/ui/shell/scripts/tooltip.ts`（改调 IPC）
- `src/ui/shell/styles/pages.css`（Git 布局）
- `src/ui/shell/partials/activitybar.html`（Token 图标）

## 验收
- 顶部/侧栏 tooltip 完整显示，不被遮挡。
- Git 改动列表与历史各保最小高度。
- Token 图标为「元」。
- typecheck / test / lint / compile 全绿。
