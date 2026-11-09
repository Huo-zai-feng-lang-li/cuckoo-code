---
id: 108
type: feature
title: 每窗口独立代理与浏览器指纹伪装（代理 + 时区/语言/位置 + WebRTC）
status: completed
branch: feat/108-per-window-proxy
created: 2026-11-09
updated: 2026-11-09
---

# 需求 108：每窗口独立代理与浏览器指纹伪装

## 1. 背景与痛点

Cuckoo Code 是多窗口应用，每个窗口（profile）已有独立持久化 partition（`src/app/profile.ts:87`）。
用户有时需要**某个窗口走代理**（如 `http://127.0.0.1:51081` 或用户自备代理），
但同一时刻其他窗口仍要直连（国内站、本地服务等），双方不能互相污染。

直接用 `session.setProxy` 只能解决 TCP/HTTP 层，但专业伪装检测站
（`https://ipip.la/disguise.html`）会额外扣分：

| 层 | 检测项 | 不处理时得分 |
|---|---|---|
| 网络层 | HTTP IPv4 = 代理出口 | 正常 |
| 网络层 | **WebRTC 泄露真实 IP**（UDP 不走 HTTP 代理） | -45 分 高危 |
| 逻辑层 | 时区（Asia/Shanghai）vs IP 归属（US） | -30 分 |
| 逻辑层 | 语言（zh-CN）vs IP 归属（US） | -25 分 |
| 逻辑层 | DNS 解析出 CN 运营商 IP | -27 分（WebRTC 修好自动消失）|
| 合计 | | 约 61 分 |

**目标**：Cuckoo Code 原生支持"每个窗口一套独立网络身份"，无需安装浏览器扩展。

## 2. 技术选型

| 维度 | 用户自研浏览器扩展（WebRTC-Disabler） | **本方案（Cuckoo Code 原生）** |
|---|---|---|
| 代理 | ❌ 无法做（浏览器单 session） | `session.fromPartition(p).setProxy({...})` |
| 时区 | hook `Date` / `Intl` | **CDP `Emulation.setTimezoneOverride`**（Chromium 原生） |
| 语言 | hook `navigator.language` + DNR 头 | **CDP `Emulation.setLocaleOverride`** |
| 地理位置 | hook `navigator.geolocation` | **CDP `Emulation.setGeolocationOverride`** |
| WebRTC | 注入 `FakeRTCPeerConnection` 主世界 | **CDP `Page.addScriptToEvaluateOnNewDocument` 主世界注入** |

**核心洞察**：Electron 的 partition 天然是"多窗口隔离"颗粒；CDP 的 Emulation 是 Chromium 原生能力，
不会在 JS 层留 hook 痕迹（`Function.prototype.toString` 完全原样），远比 content_script 注入安全。

**为什么不用启动参数 `--force-webrtc-ip-handling-policy`**：一刀切会废掉"直连窗口的真实视频通话"
（国内腾讯会议/飞书/钉钉网页版都依赖 UDP WebRTC），而本方案允许每窗口独立策略。

## 3. 实现清单

### 3.1 数据结构（`src/app/profile.ts`）
```ts
profile.proxy = {
  enabled: boolean,
  rules: string,           // 'http://127.0.0.1:51081' / 'socks5://127.0.0.1:7890'
  bypass: string,          // '<local>,localhost,127.0.0.1'
  timezone?: string,       // 'America/Los_Angeles'
  locale?: string,         // 'en-US'
  latitude?: number,
  longitude?: number,
  webrtc: 'spoof' | 'disable' | 'off',   // 默认 'off'（不改原生）
}
```
新增 `setProfileProxy(id, proxy)` / `getProfileProxy(id)`。

### 3.2 核心模块（`src/app/net-identity.ts`）
- `normalizeProxyConfig(input)`：输入白名单 + 类型校验，防脏数据
- `applyNetIdentity(view, cfg)`：
  1. `session.setProxy`（先于 loadURL，首请求就走代理）
  2. `debugger.attach('1.3')`（懒 attach；WeakMap 记录状态）
  3. `Emulation.setTimezoneOverride` / `setLocaleOverride` / `setGeolocationOverride`
     （即使 cfg 为空也显式传空值，**撤销旧覆盖**——避免用户从"设了美国时区"改成"不设"后仍卡在美国）
  4. WebRTC：`Page.removeScriptToEvaluateOnNewDocument(旧 id)` → `addScriptToEvaluateOnNewDocument(新脚本)`
- `releaseDebugger(wc)`：F12 打开 DevTools 前调用（debugger 与 DevTools 互斥）

### 3.3 WebRTC 注入脚本
- **spoof**：Fake RTCPeerConnection 包装原生 → `iceServers = []`（断 STUN）→ 只返回 1 条 mDNS `.local` host 候选
  - `RTCPeerConnection.name = 'RTCPeerConnection'`，`toString` 伪装 `[native code]`
  - `onicecandidate` setter + `addEventListener` 双路径拦截（防高级检测绕过）
- **disable**：构造即抛错（最严格，但有"少数派特征"）
- **off**：不注入（保留原生，直连窗口的视频通话正常）

### 3.4 IPC 契约（`src/app/entry.ts`）
- `get-profile-proxy` { profileId } → { proxy }
- `set-profile-proxy` { profileId, proxy } → { proxy }
  - **纵深防御**：仅本窗口可读写自己（`ctx.profileId !== profileId` 拒绝）
  - **存储前 normalize**：避免磁盘存字符串 latitude 等脏数据
  - **保存后立即应用**：对该 profile 的所有窗口（主 + 子代理）`applyNetIdentity` + reload

### 3.5 UI（`src/ui/shell/`）
- `partials/modals.html`：新增 `#proxy-modal` 弹窗（启用/代理地址/绕过/时区/语言/经纬度/WebRTC 策略）
- `scripts/pages/windows.ts`：
  - 窗口卡片底部加 `🌐` 按钮（启用时代理时显示 "🌐 代理"）
  - `openProxyModal(profileId)` 打开弹窗，读写当前配置
  - **AbortController 管理监听器**（不用 `once:true`——校验失败提前 return 会"偷掉"监听器，用户改好后再点没反应）
- `styles/pages.css`：`.ck-win-proxy` 按钮样式

### 3.6 兜底（`entry.ts` did-finish-load）
首次创建窗口时 `applyNetIdentity` 在 loadURL 前调用，target 可能尚未就绪导致 attach 静默失败。
页面加载完成后再 `applyNetIdentity` 一次（不 reload，仅补 Emulation）确保时区/语言真正生效；
WebRTC 注入需 reload 才作用于当前文档，下次刷新即完整生效。

## 4. 已知限制（非 bug，文档化）

- **CDP 与 DevTools 互斥**：启用代理后按 F12，会先 `releaseDebugger` 再开 DevTools（Emulation 暂失效，
  关掉 DevTools 后不自动重挂——避免与用户调试抢占用）。弹窗底部已提示。
- **HTTP 代理不支持 UDP**：国外视频/语音通话（Google Meet / Zoom 网页版）在 spoof/disable 下无法真正通话，
  这是 HTTP 代理本身的物理限制，需 `webrtc: 'off'` 临时放行。
- **DNS 泄露**：随 WebRTC 修复（UDP 不再直连）自动消失；若代理端自身 DNS 泄露需在代理客户端配远程 DNS。

## 5. 验证结果

- [x] `npm run typecheck` 通过
- [x] `npm test` 通过（132 测试文件，1336 用例全部 PASS）
- [x] `npm run lint` 0 errors（67 warnings 基线持平）
- [x] `npm run compile` 通过，生成物 `src/ui/shell.html`（538401 字节）中 `#proxy-modal` 仅一份
- [ ] 用户真机验证（自测：设置代理 → 打开 ipip.la/disguise.html → 确认综合得分 >90）

## 6. 影响面与向后兼容

- **未配置 proxy 的窗口**：`DEFAULT_PROXY.webrtc = 'off'`，行为与改动前 100% 一致
  （不 attach debugger、不注入 WebRTC 脚本）。
- **IPC 契约**：新增 `get/set-profile-proxy` 两条，无改动现有通道。
- **生成物**：`shell.html` 由 `npm run compile` 重建（不手改）。
- **子代理窗口**：复用父 partition，自动继承父代理（符合直觉）。
