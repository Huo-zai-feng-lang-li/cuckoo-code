---
id: 030
type: fix
title: 自动更新下载进度可见（状态栏进度条）
status: done
branch: (直接主分支，用户要求)
created: 2026-10-12
updated: 2026-10-12
---

## 背景

自动更新下载新版本时，**用户看不到任何下载进度**，只在下载完成后弹出"是否安装"。

根因（src/updater/index.ts）：
- 进度提示是**系统通知**（弹一下就没），不是界面进度条
- 条件苛刻：`if (isManualCheck && percent % 10 === 0)` —— ① 启动时自动检查（非手动）**全程不提示**；② 只在整 10% 提示，进度跳变会**跳过**

## 目标

下载时在**状态栏显示实时进度条**（百分比 + 进度条），完成/失败后短暂停留再隐藏。

### 范围

- ✅ 主进程把下载进度推给壳页面（`shell-update-progress`）
- ✅ 状态栏进度条（百分比 + 填充条）
- ✅ 完成/失败后停留 4 秒隐藏
- ✅ 放宽系统通知节流（3 秒一次，不再依赖 %10）

## 方案

- `src/updater/index.ts`：`sendProgress()` 推状态栏；`download-progress` 实时推 percent；`update-available` 推 0%；`update-downloaded` 推 done；`error` 推 error
- `shell-preload.ts` + `shell-api.ts`：暴露 `onUpdateProgress`
- `statusbar.html`：加进度条 DOM（默认隐藏）
- `update-progress.ts`（新建）：接收进度，更新状态栏
- `base.css`：进度条样式

## 验收标准

- [ ] 下载时状态栏显示进度条（实时百分比）
- [ ] 完成后显示"更新已就绪"，停留后隐藏
- [ ] 失败显示"更新失败"
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- 进度只推主窗口（`mainWindowRef`），多窗口时非主窗口不显示
