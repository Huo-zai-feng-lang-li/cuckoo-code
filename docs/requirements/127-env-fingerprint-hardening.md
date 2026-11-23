---
id: 127
type: fix
title: 登录/运行环境特征修复（阶段 1+2：指纹、UA 与登录页隔离）
status: doing
branch: fix/127-env-fingerprint-hardening
created: 2026-11-23
updated: 2026-11-23
---

# 127 登录/运行环境特征修复（阶段 1+2：指纹、UA 与登录页隔离）

- 状态：阶段 1+2 代码完成（待真机回归）；阶段 2 已按实测证据修正任务书
- 分支：`fix/127-env-fingerprint-hardening`
- 日期：2026-11-23
- 版本：`v0.10.232`（已发布）；UA-CH 品牌部分于 `v0.10.233` 修复

## 背景

平台登录页与运行页会把「Electron 壳」和「被改过的 Chrome」区分开。计划复核时确认：现有实现不是功能崩溃，而是留下了可一行代码验证的自证痕迹与结构矛盾。阶段 1 只做低风险、可单测闭环的四项，不改真实浏览器指纹的取值。

## 根因

- **A5**：`getBrands` / `getWd` 只挂了自有 `toString`。`Function.prototype.toString.call(fn)` 不读 `fn.toString`，一行即露源码。
- **B2**：`maskAsNative` 无条件给包装函数加自有 `toString`，而真原生函数没有该自有属性，等于用新特征换旧特征；`function` 表达式还残留 `prototype`。
- **B1**：页面内 `__cuckooFpInjected` / `__cuckooShieldInjected` 可被 `Object.getOwnPropertyNames(window)` 枚举；按 URL 幂等又会漏掉刷新与 DevTools 关闭后的补注入。
- **A1**：AI view 未开 `plugins`，`navigator.plugins` 为空；真 Chrome 内置 PDF viewer 非空。

## 改动

| 文件 | 内容 |
|---|---|
| `src/app/entry.ts` | AI view `webPreferences.plugins: true`；`did-navigate` 最前调用 `resetNetIdentityDoc` |
| `src/infra/user-agent.ts` | 脚本内新增 `nativeToString` / WeakMap / `markNative` / 全局 `toString` 补丁；`getBrands`、`getHighEntropyValues`、`getWd` 统一注册；补丁不可用时才退回自有 `toString` |
| `src/providers/hooks/shared/native-mask.ts` | 仅在全局 `toString` 补丁不可用时加自有 `toString` |
| `src/providers/hooks/deepseek.ts` / `chatgpt.ts` / `claude.ts` | 10 个 hook 包装函数改对象方法简写，去掉 `prototype` |
| `src/app/net-identity.ts` | 删页面标记；`CdpState` 增 `docEpoch` / `evaluatedEpoch` / `evaluatedScript` / `registeredSource` / `armedSourceAtDocStart`；新增 `resetNetIdentityDoc`；按「文档代次 + 脚本全文」决定是否 `Runtime.evaluate` |
| `src/app/fingerprint.ts` | 删 `__cuckooFpInjected` 定义与判断 |
| `src/providers/generated/hook-sources.ts` | `node scripts/build-hooks.mjs` 重建 |

## 阶段 2 复核与实现（2026-11-23）

### P1-A：否掉，误报

本机真 Chrome headless 实测：

- `window.hasOwnProperty('fetch')` = `true`
- `Window.prototype.hasOwnProperty('fetch')` = `false`
- `window.fetch.hasOwnProperty('prototype')` = `false`

真 Chrome 的 `fetch` 本来就是 `window` 自有属性、原型上没有；任务书“真 Chrome 在 `Window.prototype`”说反了。按任务书改会让 `Window.prototype` 多出 `fetch`、`window` 少掉自有 `fetch`，反而制造两个真 Chrome 不存在的特征。**不改**，阶段 1 的“去 hook 包装函数 prototype”保持不变。

### P1-B：真差异，已实现

- 本机 Windows 11 build 22631；真 Chrome `getHighEntropyValues(['platformVersion'])` 返回 `15.0.0`，原代码 Windows 分支写死 `10.0.0`。
- Chromium 源码 `components/embedder_support/user_agent_utils.cc` 的 `GetUniversalApiContractVersion()` 不是按 build 硬编码，而是读注册表 `HKLM\SOFTWARE\Microsoft\WindowsRuntime\WellKnownContracts` 的 `Windows.Foundation.UniversalApiContract` DWORD，取 HIWORD/LOWORD 拼成 `major.minor.0`（源码：<https://chromium.googlesource.com/chromium/src/+/main/components/embedder_support/user_agent_utils.cc>）。
- 实现改为优先读同一注册表值（`reg.exe`，`/reg:64`，缓存一次）；读取失败才用 build 阈值兜底（26100→16、22631→15、22621→14、22000→13、其余→10）。
- 本机编译产物实测 `platformVersion= 15.0.0`；macOS/Linux 分支保持不变。

### P0：方向对，但原任务书实现会翻车；已重写

原任务书三处硬伤：

1. hook 注入在 `entry.ts` 模块顶层，不在 `init()`；只在 `init()` 加守卫，`chat.deepseek.com/sign_in` 仍会被注入 fetch/XHR hook。
2. `init()` 注册大量 IPC/timer/observer，不幂等；简单加 `__done` 会把登录后的重新初始化挡掉。
3. 正则只匹配 `sign-in`，漏了 DeepSeek 实际存在的 `/sign_in` 和 `/signup`；微信扫码页 `open.weixin.qq.com/connect/qrconnect` 的 host/path 都不匹配，只有 query 的 `redirect_uri` 能匹配，而该页 provider 为 null，拿它验证 hook 会得到假阳性。

已落地：

- 新增 `src/bridge/auth-page.ts` 纯函数 `isAuthPage(href)`，只认明确 host/path；覆盖 `/sign_in`、`/sign-in`、`/signup`、`/sign_up`、`/login`、`/auth`、`/oauth`、`/sso`、`/passport`、`/connect/qrconnect` 等，以及微信/Google/Microsoft/OpenAI 登录 host。
- `entry.ts` 新增 `injectProviderHook()`：顶层尽早注入，但先判 auth；auth 页直接 return。
- `entry.ts` 新增 `overlayInitialized` 与 `watchAuthExit()`：auth 页不跑 `init()`；退出 auth 后补 hook + `init()`。监听用原生 Navigation API `navigatesuccess` + `popstate`/`hashchange`，1.5s 轮询兜底，**不 patch history**。
- `init()` 顶部先判 auth 再置 `overlayInitialized`，避免重复注册 IPC；顶层 `buildUserAgentDataFix()` 保持无条件注入（登录页仍需 UA 修正）。

残余：登录页同源的 `localStorage` 历史 `cuckoo-*` 键不会被跳过注入清掉；要清零需迁移设置存储，另立需求，不在本阶段冒充解决。

### v0.10.233 补充：UA-CH 品牌 GREASE / 顺序

阶段 1 的 `Function.prototype.toString` 伪装只解决了“函数源码暴露”，没有解决
`navigator.userAgentData.brands` 缺 `Google Chrome`：原实现把 GREASE 品牌写死为
`Not_A Brand`、顺序写死，Chrome 152 真值是 `Not?A_Brand` 且 Chromium 排第一；
同时 `applyUad()` 在 CDP 已注入 Google Chrome 时跳过 JS 补丁，打开 DevTools
后 CDP detach 就露出原生列表。已在需求 129 / `v0.10.233` 中修复，详见
`docs/requirements/129-ua-ch-brand-grease.md`。

## 边界

- 不保证「改完不被封」；TLS/JA3、字体、屏幕、GPU 驱动等设备层特征不在代码层解决。
- 不改 WebGL `gl.VENDOR` / `gl.RENDERER`（现代 Chrome 固定 `WebKit`，真实 GPU 只走 `WEBGL_debug_renderer_info`）。
- A2/A3/A4/B3/B4/B6/C/D 均未做，需真 Chrome 采样或真机测量后再排期；D4（CDP 点停止）已被真机证否，不再改。

## 验证

- `npm run typecheck` 通过（主仓 + hooks）。
- `npm test`：153 文件 / 1556 用例全绿（阶段 1 基线 1542；新增 auth 判定 6、auth 接线守卫 3、platformVersion 映射/注册表解析 3）。
- `npm run lint`：0 error（72 条既有 warning）。
- `npm run compile` 通过，hook-sources 已重建。
- `npm run docs:index`：需求索引已更新（114 个需求）。
- 编译产物实测：本机 `platformVersion=15.0.0`；`isAuthPage('/sign_in')=true`、正常对话页 `false`。
- **真实 preload 探针（隐藏 Electron，独立临时 userData，不碰用户实例）**：`https://chat.deepseek.com/sign_in` 加载后 `overlayIds=0`、无 `主世界拦截器注入成功` 日志、`winCuckooKeys=[]`；本地拦截出的 `https://chat.deepseek.com/a/chat/s/probe` 正常页 `overlayIds=6` 且 hook 注入成功。同文档 `history.pushState` 从 `/sign_in` 退出后 2s 内 `overlayIds=6`、hook 注入成功，`watchAuthExit` 生效。
- 针对性用例：同文档同配置只 `evaluate` 一次；导航后已注册脚本覆盖则跳过；无注册脚本的文档补一次；同文档配置变更必须重新 `evaluate`；登录页 hook/overlay 接线与“不 patch history”有源码守卫。

## 遗留

- 完整 app 未验：登录、对话、附件、停止、纯净模式、多窗口内存。
- `window.fetch` 是 `window` 自有属性，已实测与真 Chrome 一致，不再改（P1-A 误报）。
- 登录页 `localStorage` 的 `cuckoo-*` 历史键仍在；跳过注入只能阻止新增 DOM/新写入，清不掉旧键。
- 同文档 SPA **从正常页进入** auth 时，已注入的 hook 无法撤回（overlay 也仍在 DOM 里）；当前保证的是 auth 作为文档入口时干净、auth 退出后补注入。真实登录入口若为整页加载则覆盖；若站点用同文档跳转，需要另立“可卸载 hook / 强制重载”方案。
- OAuth 弹窗与子帧覆盖未采样（A4 前置）。
- `chrome.app` / `chrome.runtime` 方法面仍缺（A2）。
