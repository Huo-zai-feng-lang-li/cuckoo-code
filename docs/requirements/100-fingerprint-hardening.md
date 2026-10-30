---
id: 100
type: fix
title: 浏览器指纹一致性加固（降低账号风控风险）
status: done
branch: fix/100-fingerprint-hardening
created: 2026-10-31
updated: 2026-10-31
---

# 需求 100：浏览器指纹一致性加固

## 1. 背景

审计发现多处「反自动化 / 指纹一致性」缺陷，会让站点判定为「被篡改的浏览器」，进而触发限流、验证码，极端情况短期封禁。均不影响正常功能。

## 2. 缺陷与修复

### ① 伪造了 Chrome 64 已移除的 API（自我矛盾）

`src/infra/user-agent.ts` 给 `window.chrome` 补了 `loadTimes` / `csi`，这两个 API 在 Chrome 64 就被删除。UA 声称高版本 Chrome，页面上却存在早已移除的 API —— 比不伪造更可疑。

**修复**：删除这两行伪造；保留 `chrome.runtime` / `chrome.app`（Google OAuth 登录依赖，见需求 050）。

### ② 包装 fetch / XHR 未伪装 toString

三个平台 hook 都替换了 `window.fetch` 与 `XMLHttpRequest.prototype.open/send/setRequestHeader`，但 `toString()` 直接暴露源码，一行检测即可识破。

**修复**：新增 `src/providers/hooks/shared/native-mask.ts` 的 `maskAsNative(fn, name, nativeLength)`，把包装函数伪装成 `function xxx() { [native code] }`，并**补齐 length**（原生 fetch=1、send=0、open=2、setRequestHeader=2）。三平台全部接入。

### ③ 平台信息自相矛盾（macOS 用户必中）

`buildChromeUserAgent()` 硬编码 Windows UA，`sec-ch-ua-platform` 写死 `"Windows"`，`userAgentData` 整体伪造（platform 写死 Windows、platformVersion 写死 10.0.0）。但 `navigator.platform` 是原生真实值 —— macOS 上 UA 说 Windows、platform 说 MacIntel，一眼假。

**修复**：

- UA / Client Hints / userAgentData 全部按 `process.platform` 生成，与原生 `navigator.platform` 天然一致；
- `userAgentData` 改为**最小覆盖**：只补 `brands` 里缺的 "Google Chrome" 品牌，platform / platformVersion / mobile 全部透传 Chromium 原生值。

### ④ hook 在 window 上留下可枚举标记

三个 hook 用 `window.__cuckoo*HookInstalled__` 做幂等，页面一行 `Object.keys(window).filter(k => k.includes('cuckoo'))` 就能识别。

**修复**：改为闭包变量（hook 本身是 IIFE，天然只执行一次）。

### ⑤ 高熵 Client Hints 删而不补

`ensureClientHints` 删掉 `sec-ch-ua-full-version(-list)` 却不补发。

**修复**：原本没发就不硬加（真实 Chrome 也不会无条件发），原本发了就用修正后的值替换。

### ⑥ 品牌补丁此前从未真正生效（排查中发现的连锁缺陷）

- `navigator.userAgentData` 每次访问返回**新对象**，打在实例上的补丁随对象一起丢弃（`brands` 之所以生效是因为走了原型 getter）；
- 原生 `getHighEntropyValues` 要求 `this` 是实例，原型包装若固化对象会抛 `Illegal invocation`；
- 原生方法是原型上的只读方法，非严格模式下普通赋值会静默失败，必须用 `defineProperty`。

**修复**：统一只打原型，包装内用 `apply(this, arguments)` 保留调用时的 this，用 `defineProperty` 而非直接赋值。

### ⑦ 子代理启动间隔默认 0 秒

同账号多路子代理同时开 SSE 是明显机器人特征，默认 0 秒等于完全不设防。

**修复**：默认值改为 2~5 秒随机；`migrateLegacy` 把旧默认 (0,0) 迁移到 (2,5)，用户自定义值原样保留。

## 3. 已知残留（本次不处理，记录备查）

1. `chrome.runtime` / `chrome.app` 伪造 —— 真实 Chrome 的普通网页通常没有这两个对象；但这是 Google OAuth 登录的历史依赖，需单独评估。
2. `cuckoo-ds-headers` 明文存 `authorization` 于 localStorage —— 同源页面可读，改动面涉及压缩流程。
3. `"Not_A Brand";v="24"` 是 GREASE 值硬编码，真 Chrome 随主版本轮换；改错反而更假。
4. `Function.prototype.toString.call(window.fetch)` 仍可绕过实例上的 toString 伪装 —— 防它必须改 `Function.prototype.toString` 本身。
5. 压缩流程直调 API、并发与时长特征属产品固有属性，非代码缺陷。

## 4. 验证

- typecheck / compile / test（131 文件 1316 用例）/ lint（0 errors）全绿
- 真机 CDP 探针（开发版 9444，DeepSeek 页面）：
  - `navigator.platform` / UA / `userAgentData.platform` 三者一致
  - `chrome.loadTimes` / `chrome.csi` 均为 `undefined`
  - `fetch` / XHR 的 `toString()` 含 `[native code]`，`length` 已对齐原生值
  - `Object.keys(window)` 中无任何 cuckoo 标记
- 子代理 code-reviewer 审查：9 条意见，采纳 5 条、驳回 1 条（migrateLegacy 有 `hasAgentSettingsFile()` 守卫）、记录 3 条
