# 068 — 系统级通知改自绘浮窗（统一视觉）

- 状态：doing
- 分支：直接主分支
- 更新：2026-10-16

## 背景

限流自动切换已改用自绘浮窗（`src/app/alert-window.ts` + `src/ui/alert-window.html`）：无边框透明 BrowserWindow、右下角、圆角卡片、精细阴影、深浅色自适应。

但其它系统级通知仍是 Electron 原生 `new Notification()`（Windows 通知中心样式），视觉与产品脱节、不够统一美观。

## 目标

把系统级「被动通知」统一改为自绘浮窗（沿用 alert-window 的视觉语言），提升整体观感与一致性。

### 范围（改为自绘浮窗）
- `src/app/ipc/renderer.ts` — AI 任务完成通知
- `src/app/entry.ts` — 窗口组切换结果通知
- `src/updater/index.ts` — 更新相关提示（检查中/已最新/开始更新）

### 不改（保留原生）
- `dialog.showMessageBox` —— 模态决策对话框（要求用户选择，非被动通知）

## 设计

- 新建通用通知管理器 `src/app/notification-window.ts`（堆叠、自动消失、hover 暂停、点击聚焦）
- 新建卡片页面 `src/ui/notification-window.html`（沿用 alert-window 令牌系统）
- 新建 preload `src/app/notification-preload.ts`
- 类型：success / info / warn / error，左侧色条 + 图标区分

## 验收

- 三处通知均显示为右下角自绘浮窗（非系统通知中心样式）
- 多条通知垂直堆叠、自动消失、hover 暂停、点击聚焦对应窗口
- 深浅色自适应，与限流浮窗视觉统一
- typecheck / test / lint / compile 全绿
