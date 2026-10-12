---
id: 031
type: feature
title: 纯净模式字号缩放（设置项）
status: done
branch: (直接主分支，用户要求)
created: 2026-10-12
updated: 2026-10-12
---

## 背景

纯净模式（harness）的字号全是硬编码 px（AI 正文 13px、代码 12px、标题 16/15/14px、工具信息 11-12px）。用户反馈**偏小**，但无任何调节入口，想调只能改源码重打包。

## 目标

在设置页提供**纯净模式字号**选择（小/标准/大/特大/超大），全局生效、持久化。

### 范围

- ✅ 设置页下拉：85% / 100% / 115% / 130% / 150%
- ✅ 用 Electron `webContents.setZoomFactor` 等比缩放（不改 CSS，整体协调）
- ✅ 持久化到主进程（`ui-prefs.json`），不依赖 AI 页面 localStorage
- ✅ 改设置即时应用（当前窗口 harness 视图）
- ❌ 不做：仅调正文（等比缩放更协调）、快捷键缩放

## 方案

### 为什么用 setZoomFactor 而非改 CSS

harness 字号散落 30+ 处硬编码 px，逐个改成变量工作量大且易漏。`setZoomFactor` **一次缩放整个视图**，比例天然协调。

### 存储（主进程直存）

新增 `src/app/ui-prefs.ts`：读写 `~/.cuckoo/ui-prefs.json`，字段 `harnessZoom`（0.8~1.6）。不依赖 AI 页面 localStorage（链路绕、易超时）。

### 应用时机

- harness 视图**创建时**（`entry.ts ensureHarnessView`）读偏好应用
- 设置页改动时（`set-ui-prefs` IPC）立即应用到当前窗口 harness 视图

## 验收标准

- [ ] 设置页有"纯净模式字号"下拉
- [ ] 切换后纯净模式整体字号变化
- [ ] 重启后保持
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- 多窗口：set-ui-prefs 只即时应用触发窗口，其他窗口下次重建才生效
- 未做快捷键缩放（Ctrl+= / Ctrl+-）
