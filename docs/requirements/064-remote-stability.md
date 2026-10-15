---
id: 064
type: fix
title: 手机远程稳定性：隧道自愈 + 半开丢消息 + 后台保活
status: done
branch: fix/064-remote-stability
created: 2026-10-16
updated: 2026-10-16
---

## 背景

用户反馈手机远程"容易断线"，目标：做到像市场主流 App 一样丝滑好用；同时**绝不能影响 Harness**（项目最核心功能）。

## 根因（三条，来自 explore 调研 + 主代理复核）

### ① cloudflared 快速隧道崩溃后无自愈（最致命）
`src/remote/tunnel.ts:121-129`：`onExit` 只清 `tunnelProc=null` + resolve 一次，**无任何重启逻辑**。快速隧道（trycloudflare.com）本身不稳定，进程一退 → 隧道永久失效，手机端再也连不上，只能重启电脑端。

### ② 手机后台/锁屏 → 客户端心跳冻结 → 服务端 60s 判死
`app.js:225` 客户端 25s 心跳依赖 `setInterval`；移动端后台被浏览器冻结 → 发不出 ping → `server.ts:198-207` 服务端 30s ping 两次无 pong 即 `terminate`。表现为"手机熄屏几分钟回来必断"。

### ③ 半开连接窗口期静默丢消息
`app.js:250-255` `sendRaw`：`connected && readyState===1` 在半开时仍成立 → `send` 返回 true，消息进死 TCP，**不进 sendQueue**（`doSend` 只在返回 false 时入队）→ 用户以为发了，实际丢失。

## 修复

### A. 隧道自愈（tunnel.ts）
- `onExit` 区分"主动停止"与"意外退出"：主动 stop 不重启；意外退出按退避（3s→6s→...封顶 30s）自动重启。
- 记录 `intentionalStop` 标志，stopTunnel 时置位防误重启。
- 重启上限（如连续失败 5 次后放弃并记录错误，避免无限重试）。

### B. 客户端保活增强（app.js）
- 降低服务端判死敏感度：服务端两次无 pong（60s）→ 放宽到 3 次（90s），给手机后台恢复留时间。
- 客户端心跳间隔 25s 保持；但 pong 超时判定从 60s 放宽到 75s（与上层协同）。
- `visibilitychange` 已有秒连兜底，保留。

### C. 半开丢消息（app.js）
- `sendRaw` 增加"乐观标记"：消息发出后若短时间内（如 2s）未收到服务端任何响应/未确认，视为可疑。**更简方案**：`doSend` 改为"总是先入 sendQueue，收到服务端 `ready`/`pong` 确认后再移除"——但改动大。
- **最小方案**：`sendRaw` 在 `ws.bufferedAmount` 异常或 `readyState !== 1` 时返回 false；另加"发送后 3s 内若连接断，把该消息重新入队"的兜底。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机：隧道 kill 后自动恢复；手机熄屏 3 分钟回来能连；断线期间发的消息重连后补发

## 风险

- 隧道自动重启可能产生僵尸进程 → 用 killProcTree 保证旧进程先死。
- 改动仅在 `src/remote/`，**不触碰 bridge/overlay/harness**，对 Harness 零影响（子代理审计确认，信心 10/10）。

## 审计意见处理（两轮子代理审计，全修）

### 第一轮
- **🔴 R1（onExit 抹掉新进程引用 → 僵尸/重复进程）**：真 bug（本次引入）。改为闭包绑定 `myProc` + 代际号 `myGen`，`onExit` 里 `if (myGen !== tunnelGen) return` + `if (tunnelProc === myProc)` 才清引用。
- **🔴 R2（stop→start 竞态漏判）**：删除全局 `intentionalStop`，改用代际号；`stopTunnel` 里 `tunnelGen++`。
- **🔴 R3（客户端 STALE_MS 不自洽）**：75s→130s（明显大于服务端判死），让服务端先断为主路径。
- 🟡 S1 注释修正、S2 stop 静默丢加提示、S3 成功分支重置 restartAttempts。

### 第二轮
- **🔴-1（残留 restartTimer 阻塞新代重启 → 自愈失效）**：`startTunnel` 入口清残留 `restartTimer`。
- **🔴-2（error 回调缺代际守卫 → 污染状态）**：`error` 回调首行加 `if (myGen !== tunnelGen) return`。
- 🟡-3（定时器回调用全局 tunnelProc）：改用闭包 `myProc`；onExit 补清 `pendingStartTimer`。
- 🟡-4（ENOENT 后仍重试 5 次）：致命启动错误标记 `fatalStartError`，不进入重启。
- 🔵 stopTunnel 清 `lastStartOpts`（防状态泄漏）。
