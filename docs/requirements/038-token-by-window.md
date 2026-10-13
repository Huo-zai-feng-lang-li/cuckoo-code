---
id: 038
type: feature
title: Token 统计按窗口展示今日用量
status: done
branch: feat/038-token-by-window
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

Token 页四个数字口径混乱：
- `各轮累计`（当前会话历史）、`今日窗口`（本窗口今日）、`窗口累计`（本窗口历史）、`系统总累计`（全局历史）
- 「今日窗口」和「窗口累计」都带"窗口"但一个说时间、一个说范围，看着同类却不同维度
- **缺「全局 × 今日」维度**（今天所有窗口一共烧多少）
- 柱图是"本窗口近 10 天趋势"，但用户想看**今日各窗口用量对比**

## 目标

1. 补一格「今日全窗口」（全局 × 今日）
2. 命名消歧：`今日窗口` → `今日本窗口`；`窗口累计` → `本窗口历史累计`
3. 柱图改为**按窗口展示今日用量**（替换原近 10 天趋势）

## 设计要点

### 数据来源

主进程 `token-stats.json` 现只存各 profileId 的**历史累计**（数字）。需扩展为对象：
```json
{ "<profileId>": { "cumulative": 1.43e8, "today": 4.4e7, "todayDate": "2026-10-13", "name": "主力窗口" } }
```
- 兼容旧格式（值为数字 = 纯 cumulative）
- 跨天：todayDate ≠ 今天 → today 视为 0（读取时判断）
- 窗口名从 `profileManager.getProfileById(profileId).name` 取

### 数据流

```
overlay/events → updateTokenUsage(context, cumulative, windowCumulative, todayCumulative, daily)
  → 主进程 shell.ts：setWindowUsage(profileId, { cumulative, today, name })
  → 广播 'shell-window-usage'（各窗口今日用量列表）给所有壳页面
  → token 页渲染「今日全窗口」+ 窗口柱图
```

## 实现文件

| 文件 | 改动 |
|---|---|
| `src/app/token-stats.ts` | 扩展为对象存储 + setWindowUsage/getWindowUsageList/getTodayTotal |
| `src/app/ipc/shell.ts` | handler 改调 setWindowUsage + 广播窗口用量 |
| `src/app/shell-preload.ts` | 加 onWindowUsage |
| `src/ui/shell/scripts/shell-api.ts` | 补类型 |
| `src/ui/shell/partials/pages/token.html` | 加「今日全窗口」格 + 改名 |
| `src/ui/shell/scripts/pages/token.ts` | 渲染今日全窗口 + 柱图改按窗口 |

## 验收

- [ ] 新增「今日全窗口」显示全局今日
- [ ] 两处命名消歧
- [ ] 柱图按窗口展示今日用量（含窗口名）
- [ ] 跨天今日归零
- [ ] 兼容旧 token-stats.json
- [ ] typecheck/test/lint/compile 全绿
