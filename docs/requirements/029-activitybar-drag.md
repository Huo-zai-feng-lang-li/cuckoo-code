---
id: 029
type: feature
title: 活动栏图标拖拽排序
status: done
branch: (直接主分支，用户要求)
created: 2026-10-12
updated: 2026-10-12
---

## 背景

左侧活动栏图标顺序写死在 `activitybar.html`，用户无法调整。插件动态挂载的图标（记忆/快照等）也只能按固定位置插入。

## 目标

支持**拖动活动栏图标调整顺序**，顺序持久化（重开记住）。

### 范围

- ✅ 鼠标拖拽排序
- ✅ 顺序存 localStorage（`cuckoo-activitybar-order`）
- ✅ 兼容插件动态挂载的图标（MutationObserver 重排序）
- ✅ 拖拽后抑制误点击（不误切 tab）
- ❌ 不做：拖出/跨栏、分组

## 方案

新增 `src/ui/shell/scripts/activitybar-drag.ts`：

- **拖拽**：mousedown 记录起点，mousemove 超 6px 阈值才进入拖拽态（避免与点击冲突），实时把元素插到鼠标位置
- **持久化**：mouseup 时按 DOM 顺序存 key 列表（tab / 插件 tab / `_spacer`）
- **应用顺序**：启动 + 插件挂载（MutationObserver）时按存的顺序重排；改 DOM 前 `observer.disconnect()`，改完再 observe（**防自己触发自己 → 死循环**）
- **防误点击**：拖拽结束后捕获阶段吞掉一次 click

接线：`main.ts` 调 `initActivitybarDrag()` + `applyActivitybarOrder()`；`base.css` 加拖拽态样式。

## 验收标准

- [ ] 可拖动图标调整顺序
- [ ] 重启后顺序保持
- [ ] 拖拽不会误触发 tab 切换
- [ ] 插件图标挂载后也遵循保存的顺序
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- 未做：拖出/跨栏、分组、右键重置顺序
