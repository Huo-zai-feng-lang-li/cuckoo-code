---
id: 050
type: fix
title: 工具窗口（openBrowserWindow）无法登录 Google（缺 UA 指纹修正）
status: done
branch: fix/050-browser-window-ua
created: 2026-10-14
updated: 2026-10-14
---

## 背景

用 `openBrowserWindow` 打开的工具窗口访问 Gemini / Google 登录页时，报「此浏览器或应用可能不安全」无法登录。

根因（实测指纹证据）：
- `browser-window-manager.ts` 只调了 `setUserAgent(buildChromeUserAgent())`（去掉 Electron 标识），但**缺**两样 Google OAuth 必需项：
  1. `navigator.userAgentData.brands` 缺 `"Google Chrome"` 品牌（实测只有 `Not?A_Brand` + `Chromium`）
  2. `sec-ch-ua*` 请求头未改写（Electron 默认缺 "Google Chrome" 品牌）

主窗口 AI 视图（`entry.ts:539/546` + `bridge/entry.ts:44`）三样齐全，所以能过。

## 目标

工具窗口补齐与主窗口一致的 UA 指纹修正，使 Google 系站点（含 Gemini）可登录。

## 改动

### 新增 `src/tools/browser-preload.ts`（工具窗口专用 preload）
- preload 阶段经 `webFrame.executeJavaScript` 向**主世界**注入 `buildUserAgentDataFix()`（修正 `navigator.userAgentData` / `navigator.webdriver`），与 `bridge/entry.ts` 方式一致。
- **放在 `src/tools/` 根目录**（非 `impl/`）：`impl/` 是 D12 契约扫描目录，会被 `build-tool-api.mjs` 当工具模块 import 执行 → 报错。且 preload 是工具层自有资源，放这里避免 tools 反向引用 app 层（依赖铁律）。

### 改 `src/tools/impl/browser-window-manager.ts`
- `openWindow` 的 `webPreferences` 指定 preload（`contextIsolation:true, nodeIntegration:false, sandbox:false`；`sandbox:false` 是 ESM preload 必需，否则报 "Cannot use import statement outside a module"）。
- 安全基线放在用户 `webPreferences` **之后**，不可被覆盖；剥离 `width/height` 避免冗余。
- 新增 `preload-error` 监听：preload 加载失败时主进程显式记录（否则指纹修正静默失效）。
- 复用 `infra/user-agent.ts` 的 `ensureClientHints(ses)` 补齐 `sec-ch-ua*` 请求头。

### 重构 `src/infra/user-agent.ts` + `src/app/entry.ts`
- 把主窗口内联的 `onBeforeSendHeaders` 改写逻辑提取为 `ensureClientHints(ses)`（WeakSet 去重），`entry.ts` 改为复用（顺带修复同 partition 多窗口重复注册互相覆盖的问题）。

## 验证

- typecheck / test / lint / compile 全绿
- 真机：工具窗口 `navigator.userAgentData.brands` 含 "Google Chrome"；Google 登录页不再报"不安全"
