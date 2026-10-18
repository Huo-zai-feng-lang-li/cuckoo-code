---
id: 084
type: perf
title: 远程提速（静态资源缓存 + 重连/同步优化）与移除手机传图
status: in_progress
branch: feat/084-remote-speedup
updated: 2026-10-19
---

# 084 perf — 远程提速与移除手机传图

## 问题

手机端远程控制存在三个体验问题（用户实测：冷启动到看到文字约 20 秒）：

1. **首页空白久**：静态资源（style.css 32KB + marked.umd.js 46KB + app.js 38KB ≈ 116KB）
   每次打开都全量重下（`serveStatic` 只发 `Cache-Control: no-cache`，且无 ETag →
   浏览器无法走 304），全走 trycloudflare 隧道。
   另 `index.html` 两个 `<script>` 无 defer，阻塞首屏渲染。
2. **重连频繁、恢复慢**：
   - 切后台再回前台，`visibilitychange` 只处理 `!connected`，已连接但半开的场景要等
     25s 心跳定时器发现 `lastPong > 60s` 才重连。
   - 重连退避 `×1.6 / 上限 15s`，一次抖动要等数秒才恢复。
3. **每次重连都重拉 history，且客户端"同步中"兜底 8 秒**：
   `manager.ts` 的 `requestHarnessExport(…, 2000)` 最坏等 2s；
   `app.js` 的 `setSyncing` 超时兜底 8s，用户长时间盯着"正在同步对话…"。

另：**手机传图功能基本不用**，链路极重（原图 base64 上限 8MB + CDP 探测点击最多 3 轮
× 2.5s + `waitComposerReady` 最长 12s 轮询），且带竞态缺陷（上传未完成即可发文本）。
决定移除。

## 方案

### A. 移除手机传图

| 文件 | 改动 |
|---|---|
| `src/remote/pwa/index.html` | 删除上传按钮 `<label id="attach">` 及其 `<input type="file">` |
| `src/remote/pwa/app.js` | 删除 `attachBtn/fileInput` 变量、`handleUpload`、`addImageBubble`、`attach-result` 分支、上传事件绑定 |
| `src/remote/pwa/style.css` | 删除 `.msg-image/.image-bubble/.uploaded-thumb/.image-name/.attach-btn*` 样式 |
| `src/remote/server.ts` | 删除 `ServerDeps.onAttach` 与 `attach` 消息分支 |
| `src/remote/manager.ts` | 删除 `onPhoneAttach`、`cdpAttach` import、`onAttach` 注入 |

保留 `src/app/ipc/cdp-attach.ts`（纯净模式 harness 仍在使用，见 `harness.ts:475`）。

### B. 静态资源缓存（首页提速）

`serveStatic` 改为：
- 计算强校验器 `ETag`（`W/"<mtimeMs>-<size>"`）
- 请求头 `If-None-Match` 命中 → **304 Not Modified**（不传 body）
- `index.html`：`Cache-Control: no-cache`（每次都验证，但命中即 304，极快）
- 其它静态资源：`Cache-Control: public, max-age=31536000, immutable`（一年强缓存）

### C. 脚本 defer

`index.html` 的 `<script src="/marked.umd.js">` 与 `<script src="/app.js">` 加 `defer`，
首屏 HTML/CSS 不再等 46KB 的 marked 下载执行。

### D. 重连与同步优化

| 文件 | 改动 |
|---|---|
| `src/remote/manager.ts` | `requestHarnessExport` 超时 `2000 → 800`（harness 正常 12ms 内回） |
| `src/remote/pwa/app.js` | `setSyncing` 兜底 `8000 → 2500` |
| `src/remote/pwa/app.js` | `visibilitychange`：可见时若 `connected` 但 `lastPong` 超过 15s → 立即重连；否则主动发 ping 探活 |
| `src/remote/pwa/app.js` | 重连退避 `×1.6 / 上限 15000` → `×1.3 / 上限 8000` |

> **不改** history 与活跃流的发送顺序：`manager.ts` 现有顺序（先 history 后 active）
> 有明确理由（客户端 `renderHistory` 在已有消息时跳过，顺序反了会丢历史）。

## 设计取舍：强缓存的代价

`app.js` / `style.css` / `marked.umd.js` 走 `max-age=31536000, immutable`（一年强缓存，
浏览器在有效期内**不发请求**）。副作用：远程服务重新编译后，已打开过 PWA 的手机在缓存
过期前不会自动拿到新版本，需手动强刷或清缓存。

- 对内部工具可接受（PWA 改动频率低）。
- 若后续改动频繁，可改为 `max-age=3600` + ETag，或给资源 URL 加 `?v=<编译时间>` 破缓存。

## 不做

- **用 MCP Cloudflare 建缓存**：当前是 quick tunnel（`trycloudflare.com`），无自定义 zone，
  CF 缓存规则挂不上；且 116KB 静态资源用本地 ETag + 强缓存即可解决，引入 CF 不成正比。
- **换固定 tunnel / frp / tailscale**：物理链路问题，代码改不掉；若仍频繁重连再单独评估。
- **删 `cdp-attach.ts`**：纯净模式 harness 仍依赖，不能删。

## 影响范围

| 文件 | 改动 |
|---|---|
| `src/remote/pwa/index.html` | 删上传 UI、脚本加 defer |
| `src/remote/pwa/app.js` | 删上传逻辑、改同步兜底/重连策略/可见性探活 |
| `src/remote/pwa/style.css` | 删上传相关样式 |
| `src/remote/server.ts` | 删 attach 分支、加 ETag/304/缓存头 |
| `src/remote/manager.ts` | 删 onPhoneAttach、超时 2000→800 |
| `test/remote/server.test.js` | 新增：ETag/304、缓存头、attach 消息已移除 |

## 验证

### 单元/集成
- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿
- 新增测试覆盖：
  - 静态资源响应带 `ETag`，带 `If-None-Match` 命中返回 304
  - `index.html` 的 `Cache-Control` 为 `no-cache`，其它资源为强缓存
  - 发送 `{type:'attach'}` 不再有 `attach-result` 回执（功能已移除）

### 真机
- 冷启动手机打开 → 首屏出现时间、看到历史文字时间
- 二次打开（缓存生效）→ 应显著更快
- 锁屏 1 分钟后回到前台 → 1s 内恢复在线
- 断网 3 秒恢复 → 重连退避后恢复
