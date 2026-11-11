---
id: 117
type: fix
title: 排除 Cloudflare 挑战域名注入与 RTC 实例属性隐身
status: done
branch: fix/115-long-text-attachment
created: 2026-11-11
updated: 2026-11-11
---

# 需求 117：排除 Cloudflare 挑战域名注入与 RTC 实例属性隐身

## 1. 背景与痛点

在多窗口独立代理（需求 108）与独立硬件指纹（需求 109）中，Cuckoo Code 通过 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 向页面注入主世界网络隐私盾（`buildShieldScript`）与硬件指纹盾（`buildFingerprintScript`）。

然而，CDP 的 `addScriptToEvaluateOnNewDocument` 默认作用于目标 WebContents 下的**所有 document 与 iframe（包含跨源 iframe）**。

在自研浏览器扩展 WebRTC-Disabler（v3.10）的真实排查与真机取证中，坐实了如下致命死因：
- 当目标站点（如包含 Cloudflare Turnstile 人机验证的登录/防护页面）创建指向 `challenges.cloudflare.com` 的验证沙箱 iframe 时，注入脚本同样在该 iframe 内执行；
- CF 自家环境被 hook（`appendChild`、`setAttribute`、`Function.prototype.toString`、`Navigator`、`WebGL` 等），导致 CF 内部跨帧环境一致性校验失败，卡死在 `interactiveBegin` 阶段，持续发送心跳却永不返回验证 Token；
- WebRTC-Disabler 在排除 4 个 CF 挑战域名后，Turnstile 瞬间绿勾通过。

此外，Fake RTCPeerConnection 实例上直接定义的方法具有可枚举性，`Object.keys(pc)` 不为空，破坏了原生 RTC 实例的指纹纯洁度。

## 2. 目标

1. **CF 挑战域名旁路放行**：
   在 `buildShieldScript`（`src/app/net-identity.ts`）与 `buildFingerprintScript`（`src/app/fingerprint.ts`）脚本顶部增加域名检测，对以下 4 个 Cloudflare 人机验证挑战域名立即静默退出，不作任何 hook 与属性注入：
   - `challenges.cloudflare.com`
   - `challenges.fed.cloudflare.com`
   - `challenges.cloudflare-cn.com`
   - `challenges-staging.cloudflare.com`
2. **RTC 实例属性隐身**：
   Fake RTCPeerConnection 实例的自有属性（`addEventListener`、`removeEventListener`、`setConfiguration`、`constructor`、`onicecandidate`）全部设为不可枚举（`enumerable: false`），对齐真实浏览器原生 RTC 实例 `Object.keys` 为空的特征。
3. **主页面防护不变**：
   主页面及其它非 CF 挑战 iframe 的代理、DNS 防护、WebRTC 伪装与硬件指纹完全保持不变。

## 3. 验收标准

1. `test/app/net-identity.test.js` 与 `test/app/fingerprint.test.js` 增加针对 CF 挑战域名的放行断言，以及 RTC 实例自有属性不可枚举断言；
2. 全量 `npm run typecheck`、`npm test`、`npm run lint`、`npm run compile` 通过；
3. `npm run docs:index` 需求索引更新。
