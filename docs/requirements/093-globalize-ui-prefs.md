# 093 全局化自动压缩与字号偏好

## 背景
用户反馈设置页中的“纯净模式字号”和“自动压缩上下文”在多个窗口间不同步，期望所有设置项全局生效。

## 问题定位
1. **纯净模式字号**：已存入主进程 `ui-prefs.json`，但保存时（`set-ui-prefs`）只对发起请求的当前窗口应用了缩放，未遍历广播给所有窗口的 harness 视图。
2. **自动压缩上下文**：纯本地存储。配置存在 AI 页面的 `localStorage` 中，且存在一套独立的 `get-autocompact` / `save-autocompact` IPC 通信，完全不跨窗口同步。

## 方案
### 1. 修复字号跨窗口实时同步
在 `src/app/ipc/settings.ts` 的 `set-ui-prefs` 处理函数中，将只处理当前窗口改为遍历所有窗口的 `harnessView` 应用缩放。

### 2. 自动压缩彻底全局化
- 将配置迁移至主进程 `AgentSettings` (存储于 `agent-settings.json`)。
- 增加字段：`autoCompactEnabled` (boolean) 和 `autoCompactThreshold` (number, 万)。
- 设置页 UI（纯净模式右下角悬浮窗）不再直接读写 `localStorage`，而是通过新增的同步机制与主进程通信。
- `events.ts` 接收主进程下发的配置，实时更新本地运行状态。

## 涉及文件
- `src/app/global-settings.ts`
- `src/app/ipc/settings.ts`
- `src/overlay/events.ts`
- `src/overlay/panels/settings.ts`
- `src/ui/shell/scripts/pages/settings.ts`
- `src/ui/shell/partials/pages/settings.html`
- `src/ui/harness.html`

## 验证
- A 窗口修改自动压缩阈值，B 窗口纯净模式立即生效。
- A 窗口修改字号，B 窗口纯净模式立即缩放。
- 原有自动压缩触发逻辑不受影响。
