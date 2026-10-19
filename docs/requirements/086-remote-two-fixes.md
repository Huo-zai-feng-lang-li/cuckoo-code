---
id: 086
type: perf
title: 远程两项关键修复（同步渲染批量提速 + 静态资源 URL 版本化）
status: done
branch: feat/086-remote-fixes-and-nav
updated: 2026-10-19
---

# 086 perf — 远程两项关键修复

## 背景

v0.10.23~25 的远程优化因网络瓶颈被整体回退到 v0.10.22（v0.10.26）。但其中**两项与网络无关、
有硬实测依据**的修复值得单独保留，不随网络问题一起丢弃。

## 方案

### A. renderHistory 批量渲染（解决"同步对话等 2 秒"）

**实测定位**：服务端 `WS open → ready → history` 全程仅 16ms，瓶颈全在客户端。

**根因**：`renderHistory` 逐条调 `addUser`/`addAi`/`addSystem`，每条都触发：
- `renderMd`（marked 解析 + DOMParser 消毒）
- `decorateContent`（遍历 `pre` 建代码块 UI）
- `checkEmptyState` + `capMessages`（各一次全量 `querySelectorAll('.msg')`）
- `scroll(true)`（强制 reflow）

12 条消息 = 24 次全量 DOM 查询 + 12 次强制 reflow，O(n²)。

**修复**：拆出 `buildUserEl`/`buildSystemEl`/`buildAiEl`（只建元素、不插 DOM、不做全量查询），
`renderHistory` 用 `DocumentFragment` 一次性插入，全量查询与滚动各只做一次。

**保序不变**：仍保持"先 history 后 active stream"（`if (messages.querySelector('.msg')) return` 这条保护不能动）。

**注**：`buildAiEl` 里的 `decorateContent`/`attachActions` 都是纯 DOM 操作
（`querySelectorAll('pre')` / `createElement` / `insertBefore` / `addEventListener`），
不依赖元素已插入文档，在 detached fragment 上调用安全。

### B. 静态资源 URL 版本化（解决"发版后手机跑旧代码"）

**根因**：CF 边缘会长期缓存 `immutable` 资源（`cf-cache-status: HIT` + `age` 数万秒）。
源站改 `Cache-Control` 对已缓存的边缘无效，只有 URL 本身变化才能绕过。

**修复**：`serveStatic` 响应 `index.html` 时把 `/app.js` / `/style.css` / `/marked.umd.js`
的引用动态改写为 `?v=<mtimeMs>`。带 `?v=` 的请求走 `immutable`（URL 已随内容变化，缓存安全），
不带 `?v=` 的沿用原策略（`index.html` no-cache，其余 immutable）。

每次发版 mtime 变 → URL 变 → CF 和浏览器缓存自然失效。

## 不做

- 同步态动画（纯视觉，无功能价值）
- 缓存分层 `no-cache`（被 URL 版本化取代，且在高 RTT 下增加往返）
- `--protocol http2`（实测在用户网络下更慢）
- 项目名 / 工具名显示（用户未明确要求保留）

## 影响范围

| 文件 | 改动 |
|---|---|
| `src/remote/pwa/app.js` | 拆出 3 个 build 函数 + `renderHistory` 改 DocumentFragment |
| `src/remote/server.ts` | 新增 `VERSIONED_ASSETS`/`assetVersionCache`/`assetVersion`/`versionizeHtml`；`serveStatic` 支持 `?v=` |
| `test/remote/server.test.js` | 新增 2 条：index.html 引用带 `?v=`、带 `?v=` 走 immutable |

## 验证

- typecheck / test / lint / compile 全绿
- 真机：index.html 引用带 `?v=`、`app.js?v` 返回 200 + immutable、同步等待明显缩短
