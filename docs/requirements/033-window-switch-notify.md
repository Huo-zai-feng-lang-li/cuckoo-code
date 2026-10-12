---
id: 033
type: feature
title: 窗口组切换提示（原因 + 来源→目标 + 结果）
status: done
branch: (直接主分支)
created: 2026-10-12
updated: 2026-10-12
---

## 背景

窗口组切换（手动「转移对话」或账号限流自动切换）**全程无提示**：
- 自动切换时窗口焦点突然跳走、源窗口被关，用户完全不知道发生了什么、为什么。
- 手动转移成功也无反馈（仅按钮短暂变"转移中…"，失败才弹 alert）。

## 目标

切换时给出明确提示：**原因**（限流自动/手动转移）、**来源 → 目标窗口**、**结果**。

### 范围

- ✅ 壳页面应用内 toast（右上角，成功 6s / 失败 10s）
- ❌ 系统通知（切换后焦点已跳到目标窗口，用户面前必有壳页面，弹系统通知属多余打扰，故不做）
- ✅ 覆盖：成功、分享失败、探测全失败、源窗口不可用
- ❌ 不做：切换历史记录、可点击 toast 跳转窗口

## 方案

- 主进程 `entry.ts`：新增 `notifyWindowSwitch(reason, fromName, toName, ok, detail)`，
  在 `runSwitchForGroup` 各返回点调用；系统通知 + 广播 `shell-window-switch` 给所有窗口。
- `runSwitchForGroup` 加 `reason` 判定（`closeSource=true` → 限流，否则手动）。
- preload 暴露 `onWindowSwitch`；shell-api 补类型。
- 壳页面新增 `window-switch.ts`：toast 渲染；`base.css` 加 toast 样式。

## 验收标准

- [ ] 手动转移成功 → 弹提示"手动转移对话：A → B"
- [ ] 限流自动切换 → 弹提示"账号限流自动切换：A → B"
- [ ] 失败（分享失败/全忙/均不可用）→ 弹失败提示含原因
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- toast 不可点击跳转目标窗口（后续可选）
