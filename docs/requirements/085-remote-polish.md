---
id: 085
type: perf
title: 远程体验打磨（同步态动画 + 渲染提速 + 工具名 + 项目名 + http2）
status: in_progress
branch: feat/085-remote-polish
updated: 2026-10-19
---

# 085 perf — 远程体验打磨

## 问题

1. **"正在同步对话…"最多等 2 秒**：实测服务端 WS open→history 仅 16ms，瓶颈在客户端
   `renderHistory` 逐条渲染——12 条消息每条都触发 `renderMd` + `decorateContent` +
   `checkEmptyState`/`capMessages`（各一次全量 DOM 查询）+ `scroll(true)`（强制 reflow），
   呈 O(n²)。
2. **同步态视觉平庸**：只有静态文案 + 呼吸圆环，等待感强。
3. **工具执行只显示"正在调用系统工具…"**：`onTool` 已带 `name` 字段，但 PWA 未使用。
4. **手机端看不到当前项目**：`listProfiles` 只返回窗口名。
5. **隧道协议**：默认 QUIC（UDP），部分网络对 UDP QoS 导致不稳定；HTTP/2 走 TCP 443 更易穿透。

## 方案

### A. renderHistory 批量渲染（解决 2 秒）

拆出 `buildUserEl`/`buildAiEl`/`buildSystemEl`（只建元素、不插 DOM、不做全量查询），
`renderHistory` 用 `DocumentFragment` 一次性插入，之后**只做一次** `checkEmptyState` +
`capMessages` + `scroll(true)`。

保序不变：仍是"先 history 后 active stream"（`renderHistory` 在已有 `.msg` 时跳过，
这个保护不能改，否则流式期间进入会丢历史）。

### B. 同步态视觉升级

新增 `.syncing-*` 组件（不复用 `.empty-state`，避免与"已就绪"空态互相污染）：
- 三环错相脉冲（accent 渐变，`--ease-out` 指数缓动）
- 逐字流动的进度条（indeterminate，纯 CSS，`prefers-reduced-motion` 降级为静态）
- 标题下方细线微光扫过
- 遵守 craft-floor：无渐变文字、无零偏移彩色光环、阴影带偏移+软模糊、对比度达标

### C. 工具名展示

`onToolEvent(phase, name)` 接收 `name`，显示 `正在执行：<name>`。

### D. 项目名

`listProfiles` 返回 `{ id, name, projectName }`（projectName = projectDir 最后一段）；
PWA 选择器与顶部标签显示 `窗口名 · 项目名`。

### E. 隧道协议

`tunnel.ts` 固定隧道分支加 `--protocol http2`（TCP 443，规避 UDP QoS）。

## 不做

- 新建会话 / 打开新项目（= 远程触发新建对话，跨视图重置风险高）
- 资源文件浏览（手机看文件体验差，且需新增带路径校验的 IPC）

## 影响范围

| 文件 | 改动 |
|---|---|
| `src/remote/pwa/app.js` | renderHistory 批量渲染、同步态组件、工具名、项目名显示 |
| `src/remote/pwa/style.css` | 新增同步态样式 |
| `src/remote/pwa/index.html` | 同步态容器（如需） |
| `src/remote/manager.ts` | listProfiles 加 projectName |
| `src/remote/tunnel.ts` | `--protocol http2` |
| `test/remote/*` | 覆盖 listProfiles 字段、renderHistory 批量行为（如可测） |
