---
id: 032
type: fix
title: 修复窗口偶发空白（缩放/拖宽才恢复）
status: done
branch: (直接主分支，用户要求)
created: 2026-10-12
updated: 2026-10-12
---

## 背景

窗口**偶发空白**（内容不显示），**缩放或拖动左侧宽度后恢复正常**。

## 根因

Electron 的 `WebContentsView` 首次显示时，**常需重新 `setBounds` 才渲染**。而 `layoutView()` 原本只在 3 个时机调用：
1. 创建时（窗口**尚未显示**、内容未就绪）
2. `resize`
3. `move`

**缺少"窗口 show / 内容就绪"的重排时机**。用户缩放/拖宽触发 `resize` → 重排 → 恢复。完全符合症状。

## 目标

补齐重排时机，消除偶发空白；顺带审计近期改动（029/030/031）无 bug/性能问题。

### 范围

- ✅ 窗口 `ready-to-show` / `show` 后重排
- ✅ 壳页面 `did-finish-load` 后重排
- ✅ AI 页面 `did-finish-load` 后重排
- ✅ 兜底延时重排（200ms / 600ms）
- ✅ `resize`/`move` 用定时器合并（防高频重排）
- ✅ 修复 029 的 observer 抖动隐患

## 方案

### entry.ts

- `ready-to-show` / `show` / 各 `did-finish-load` → `layoutView()`
- `resize`/`move` 改 `scheduleLayout()`（16ms 合并）
- 兜底 200ms / 600ms 各排一次

### activitybar-drag.ts（029 审计修复）

`applyActivitybarOrder` 改为"**顺序一致则不碰 DOM**"，避免 MutationObserver 每次子节点变化都重排（性能隐患）。

## 验收标准

- [ ] 窗口显示后不再偶发空白
- [ ] 拖拽排序仍正常，且无 observer 抖动
- [ ] typecheck + lint + compile + test 全绿

## 审计结论（029/030/031）

- **030 进度条**：纯事件监听，无性能问题 ✅
- **031 字号缩放**：读写频率低，无问题 ✅
- **029 拖拽排序**：原每次 observer 回调都重排 DOM → 已修为"顺序一致则跳过" ✅

## 遗留

- 空白问题属时序竞争，理论上彻底消除需 Electron 修复；已加多重兜底，应显著改善
