---
id: 045
type: fix
title: 列表卡片 hover 抖动 + 过渡过快的平滑修复
status: done
branch: fix/045-hover-smooth
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

技能 / 子代理 / MCP / 窗口 / 提示词 / 快照等"有子列表的菜单"卡片，鼠标悬停时详情展开、移开时瞬间消失，鼠标划过过快会发生**抖动**；且 hover 展开动画偏快（0.38s 里还夹着瞬跳）。

## 根因

卡片详情（技能描述 / MCP 底栏 / 窗口底栏 / 子代理描述）默认 `display: none`，hover 时切换 `display` + 动画 `ck-detail-in`（从 `max-height:0` 到 `140px`）：

- **展开**：0.38s 动画（平滑）
- **收起**：`display:none` **瞬间跳变**（display 无法过渡）

快速划过 = "平滑展开 → 瞬间收起" 反复 → 抖动。

## 修复

`src/ui/shell/styles/components.css`：改 `display` 瞬切为**对称过渡**（`max-height` + `opacity` + `margin-top`），进出都平滑：

- 默认态：`max-height:0; opacity:0; margin-top:-6px`（负 margin 抵消父容器 gap，折叠时零占位）
- hover 态：`max-height:160px; opacity:1; margin-top:0`
- 过渡时长 **0.4s**（响应"动画慢一点"）

涉及 6 处：技能描述 / MCP 底栏 / 窗口底栏 / 子代理描述 + 窗口"默认打开"常驻 + 运行中子代理常驻。

`src/ui/shell/scripts/tooltip.ts`：tooltip 出现延迟 120ms→**300ms**（避免划过误弹），warm 模式 20ms→120ms。

## 验收

- 快速划过卡片列表不再抖动 ✓
- hover 展开/收起均为 0.4s 平滑过渡（computed style 确证）✓
- 折叠时零占位（负 margin 抵消 gap）✓
