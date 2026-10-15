---
id: 058
type: feature
title: 限流自动切换改系统级浮窗告警（原 harness 内弹窗看不见）
status: done
branch: feat/058-switch-alert-window
created: 2026-10-16
updated: 2026-10-16
---

## 背景

限流触发自动切换前，当前实现（entry.ts:1180 countdownBeforeAutoSwitch）向 harness 页面发 `harness-switch-countdown` IPC 让 harness 自己渲染倒计时弹窗。问题：**用户经常看不到** —— 当前窗口在后台、harness 被 AI 页面盖住、或用户已切到别的应用。

用户诉求：
- 改用**系统级独立浮窗**，一定看得到；
- 倒计时 **10 秒**；
- 提供 **[取消自动切换] [立即切换]** 两个按钮。

## 目标

用一个独立的 Electron BrowserWindow 浮窗替换 harness 内弹窗。要求：
- alwaysOnTop，屏幕右下角（不挡工作区）；
- 窗口内显示：账号名（窗口名）、限流原因、10 秒倒计时进度条 + 数字；
- 用户操作：
  - [取消自动切换] → 取消本次切换，源窗口原地不动；
  - [立即切换] → 跳过剩余倒计时，立即执行；
  - 点 ✕ 或 Alt+F4 → 视为取消（保守，不乱切）；
  - 10 秒到点 → 自动执行切换；
- 深浅色自适应系统主题；
- 生命周期短（10s 内必然关闭），绝不堆积。

## 改动

### 新建
- `src/ui/alert-window.html`：浮窗 UI（自带完整 CSS，不依赖 shell 的 base.css）
- `src/app/alert-preload.ts`：preload（IPC 通道：alert-init / alert-action / alert-tick 可选）
- `src/app/alert-window.ts`：窗口管理 + IPC 注册

### 修改
- `src/app/entry.ts`：`countdownBeforeAutoSwitch` 改为调用 `showSwitchAlert()`；删掉旧 `harness-switch-countdown` 发送逻辑（保留 IPC 兼容：harness-preload 仍有通道，只是没人调）。

## 验证

- typecheck / test / lint / compile 全绿
- impeccable mechanical detector
- 子代理审计 + 主代理复核
- 真机验证：限流时右下角弹窗出现、倒计时动、按钮生效

## 备注

harnes 内的旧倒计时 UI（harness.html 里 `harness-switch-countdown` 相关）保留代码但不触发（未来可复用为"温和提示"）。
