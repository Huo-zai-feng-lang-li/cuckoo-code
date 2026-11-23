# 计划：登录环境与运行环境异常特征修复（v3，阶段 2 已落地）

- 状态：阶段 1+2 代码完成（四门禁通过）；待真机回归
- 日期：2026-11-23
- 基线版本：0.10.231
- 分支：`fix/127-env-fingerprint-hardening`
- 需求档案：`docs/requirements/127-env-fingerprint-hardening.md`

---

## 0. 目标与非目标

### 目标

1. **登录环境**：让平台登录/OAuth 页面看到一个"静态特征自洽的 Chrome"，而不是"被改造过的 Electron 壳"。
2. **运行环境**：去掉页面上可被一行代码识别的品牌签名与结构矛盾。
3. **不破坏现有功能**：四门禁全绿；纯净模式、投递、附件、子代理链路不受影响。

### 非目标（明确不做，避免虚假承诺）

- 不保证"改完不被封"。封号取决于平台条款、行为、身份、IP、设备层，代码只能降低"环境异常"这一项的权重。
- 不解决多账号设备级聚类：TLS/JA3、系统字体、屏幕分辨率、DPR、GPU 驱动在同机共享，代码层无解。
- 不伪造 TLS 指纹、不改网络栈、不做反检测对抗。
- 不修 WebGL `gl.VENDOR`/`gl.RENDERER`（7936/7937）。**复核结论**：现代 Chrome 对这两个参数固定返回 `"WebKit"` / `"WebKit WebGL"`，真实 GPU 只从 `WEBGL_debug_renderer_info`（37445/37446）暴露。现有代码只覆盖 UNMASKED 两项是正确设计，此前的"双值矛盾"判断撤回。

---

## 0.1 复核修正（2026-11-23，逐条取证后）

### 原分析中必须修正的 6 处

1. **A5 原推荐方案 2（合并进指纹脚本）有回归风险**：`fingerprint.ts:173` 在 `enabled=false` 时返回空串，`net-identity.ts:704,788-795` 只在 `needShield` 时拼装脚本。合并会让"关闭指纹 + 无代理"的用户失去 UA 修正，Google OAuth 可能重新判定"浏览器不安全"。
   → 改为：在 `buildUserAgentDataFix` 脚本内部自建 WeakMap 并包 `Function.prototype.toString`，与 fingerprint / native-mask 的补丁链式共存，互不依赖。

2. **B1 原"按 URL 幂等"不成立**：`entry.ts:736`（每次 `did-finish-load`）与 `entry.ts:823`（DevTools 关闭）都会重调 `applyNetIdentity`；同一 URL 的刷新、DevTools 关闭后文档已是新的/或需要重挂 Emulation，URL 不变但执行条件不同。只认 URL 会漏 `Runtime.evaluate`。
   → 改为：主进程按"文档代次 + 是否已评估"判定（`did-navigate` 递增代次；DevTools 关闭复用同一文档的评估结果）。页面内不再留任何标记。

3. **B4 原"改为模块内变量"不可行**：`src/session/compaction.ts:135` 在 preload 侧读 `localStorage['cuckoo-ds-headers']` 复用 Authorization，而 hook 在主世界，拿不到模块变量；缺失时 `compaction.ts:436-438` 直接抛"未获取到认证请求头"。
   → 改为：hook 通过事件/IPC 把请求头交给 preload，仍不落 localStorage；本条推迟到阶段 2。

4. **D 阶段方向读反了**：`app/ipc/harness.ts:358-361` 明确记录 CDP `Input.dispatchMouseEvent` 只让按钮图标变回箭头、流不停，页面内合成 Pointer 序列才真触发停止；`providers/deepseek.ts:355-356` 同一结论。把停止/发送改成 CDP 会破坏功能。
   → D 阶段降级为"逐事件取证后再定"，本阶段不做。

5. **C1 必须顺手清理自相矛盾代码**：`entry.ts:536-542` 注释写"保持 `setVisible(true)`"，`entry.ts:415` 的 `layoutView` 又置 false，现状注释与行为打架。只改 layout 会留下错误文档。
   → 推迟到阶段 2，改动时一并删除 536-542 的旧注释与显式 `setVisible(true)`。

6. **B3 漏了引用点与 data 属性**：`bridge/scroll-follow.ts:24` 硬编码了 `cuckoo-root` 等 4 个 id；`data-cuckoo-stop-target`（`harness.ts:1087`）与 `data-cuckoo-attach-input`（`providers/deepseek.ts:254`）直接写在页面 DOM 上。
   → B3 范围扩展为 "id/class + data-* + 全部 JS 引用点"，推迟到阶段 2。

### 新发现、需纳入后续阶段的 4 项

- **B5**：`maskAsNative` 给函数加自有 `toString`（`native-mask.ts:66-72`），真原生函数没有自有 toString；阶段 1 的 B2 一并修掉。
- **B6（已证否）**：此前判断“`window.fetch` 是自有属性、真 Chrome 在 `Window.prototype`”恰好说反。本机真 Chrome headless 实测 `window.hasOwnProperty('fetch')=true`、`Window.prototype.hasOwnProperty('fetch')=false`。不改，只保留阶段 1 去 hook 包装函数 prototype。
- **OAuth 弹窗未取证**：全仓没有 `setWindowOpenHandler`；`window.open` 新窗口是否继承 `view.webContents.setUserAgent` 与 preload 注入未知。A4 排期前必须真机采样。
- **子帧覆盖未取证**：CDP `addScriptToEvaluateOnNewDocument` 进所有 frame，preload 只进主帧；跨帧一致性检查需真机确认。

### 原分析中经核对无误、保持不动

- E1 `__cuckooFpInjected` / `__cuckooShieldInjected`、E2 `#cuckoo-root`、E4 hook 包装函数 `prototype` 残留、E6 `navigator.plugins` 为空、E8 `platformVersion` 写死、E9 登录页被 overlay + hook 覆盖、E10 纯净模式 `-20000 + setVisible(false)`，逐条与源码一致。E4 的 `window.fetch` 本身是 `window` 自有属性，与真 Chrome 一致；只修包装函数。
- `gl.VENDOR`/`gl.RENDERER` 撤回判断正确。
- C1 方向可行：harness 正文背景不透明（`harness.html:20,54` 的 `--bg` 为 `#ffffff` / `#0e1014`），覆盖下层不会透出 AI 页面。

---

## 0.2 实施结果（2026-11-23）

- A1 / A5 / B2 / B1 已落地；生成物 `hook-sources.ts` 由 `node scripts/build-hooks.mjs` 重建，未手改。
- B1 实施中发现「只按代次判断」会在同文档配置变更时跳过 `evaluate`，导致新盾不生效；已改为「代次 + 脚本全文」双条件，并补一条配置变更用例。
- 单测中发现指纹/盾脚本全文仍命中 `__cuckoo`：来源是 B1 改动时留下的注释字样，已改为中性表述，脚本运行时不再含品牌标记。
- 四门禁：typecheck ✓ / 151 文件 1542 用例 ✓ / lint 0 error ✓ / compile ✓ / docs:index ✓。
- 未做：真机回归（登录、对话、附件、停止、纯净模式、多窗口），留待用户按 `3.4` 执行。

---

## 0.3 阶段 2 实施结果（2026-11-23）

- **P1-A 否掉**：本机真 Chrome headless 实测 `window.hasOwnProperty('fetch')=true`、`Window.prototype.hasOwnProperty('fetch')=false`；任务书写反，按它改会新增两处真 Chrome 不存在的特征。不改。
- **P1-B 落地**：真 Chrome 的 `platformVersion` 来自注册表 `Windows.Foundation.UniversalApiContract`（Chromium `GetUniversalApiContractVersion()`），不是 build 硬编码。`user-agent.ts` 优先 `reg query` 读同值并缓存，失败才按 build 阈值兜底；本机 22631 实测 `15.0.0`。
- **P0 落地**：新增 `src/bridge/auth-page.ts`；`entry.ts` 的 hook 注入改为 `injectProviderHook()`（顶层执行但先判 auth），`init()` 加 `overlayInitialized` + auth 守卫，`watchAuthExit()` 用 Navigation API/popstate/hashchange + 1.5s 轮询，不 patch history。
- **P0 取舍**：登录页同源 `localStorage` 的 `cuckoo-*` 历史键不会被跳过注入清掉；迁移设置存储是更大改动，另立需求，不在本阶段冒充解决。
- 已验证：隐藏 Electron + 真实 preload 加载 `/sign_in`，overlayIds=0、无 hook 注入日志；正常页 overlayIds=6、hook 注入成功；同文档 pushState 退出 auth 后 2s 内 overlay 补上。仍待完整 app 验证登录后同页补注入与 128 复验。

---

## 1. 现状取证（保留）

### 1.1 窗口与页面结构

| 层 | 承载 | 关键代码 |
|---|---|---|
| 壳页面 | `BrowserWindow.webContents` → `ui/shell.html`（file://） | `src/app/entry.ts:152-178` |
| AI 页面 | `WebContentsView` → 平台 https 页面 | `src/app/entry.ts:198-215` |
| 纯净模式 | `WebContentsView` → `ui/harness.html`（file://） | `src/app/entry.ts:313-376` |
| 插件浮层 | 独立透明 `BrowserWindow`（data:text/html） | `src/app/entry.ts:245-302` |

同一 partition：`persist:<providerId>:<profileId>`（`src/app/profile.ts:100,153`）。

### 1.2 登录环境注入链

| 注入物 | 位置 | 作用范围 |
|---|---|---|
| UA 改写 | `src/app/entry.ts:213,622` → `src/infra/user-agent.ts:40-47` | 全页面 |
| Client Hints 请求头 | `src/infra/user-agent.ts:264-302`（`onBeforeSendHeaders`） | 全 session |
| `userAgentData` / `webdriver` / `chrome` 补丁 | `src/bridge/entry.ts:44-51` → `src/infra/user-agent.ts:78-250` | 主世界，所有页面 |
| 代理/时区/语言/geo/WebRTC | `src/app/net-identity.ts`（CDP） | 全页面 |
| 硬件指纹 | `src/app/fingerprint.ts`（CDP） | 全页面，默认开启 |
| overlay DOM + CSS | `src/overlay/panel.ts:15-31` | **所有页面，含登录页** |
| fetch/XHR hook | `src/bridge/entry.ts:56-69` + `src/providers/hooks/*` | 所有匹配平台 host 的页面，含登录页 |

### 1.3 已确认的硬特征（证据）

| 编号 | 特征 | 证据 | 检测方式 |
|---|---|---|---|
| E1 | `window.__cuckooFpInjected` / `__cuckooShieldInjected` | `fingerprint.ts:202-206`、`net-identity.ts:578-579` | `Object.getOwnPropertyNames(window)`、`in` |
| E2 | DOM `#cuckoo-root` + 模板内 100 个去重 `cuckoo-*` 标识 | `panel.ts:26-31`、`template.generated.ts` | `querySelectorAll('[id^=cuckoo],[class*=cuckoo]')` |
| E3 | localStorage 41 个固定 `cuckoo-*` key + 3 族按会话动态 key | `bridge/entry.ts:217-235`、`overlay/events.ts`、`loop/*`、`panels/settings.ts` | `Object.keys(localStorage)` |
| E4 | hook 包装函数 `prototype` 残留（`window.fetch` 本身自有属性与真 Chrome 一致） | `native-mask.ts:49`（`delete fn.prototype` 对 `configurable:false` 无效） | `fetch.hasOwnProperty('prototype')`（包装函数） |
| E5 | `getBrands` / `getWd` 未注册全局 toString WeakMap | `user-agent.ts:119-122, 209-212` | `Function.prototype.toString.call(getBrands)` |
| E6 | `navigator.plugins` 为空 | `entry.ts:199-209` 未设 `plugins`；Electron 默认 `false` | `navigator.plugins.length` |
| E7 | `chrome.app` / `chrome.runtime` 方法面缺失（`chrome.app` 另有 `isInstalled`） | `user-agent.ts:229-245` | `typeof chrome.app.getDetails`、`typeof chrome.runtime.sendMessage` |
| E8 | `platformVersion` 写死 `'10.0.0'`（阶段 2 已改读 UniversalApiContract） | `user-agent.ts` Windows 分支 | `getHighEntropyValues(['platformVersion'])` |
| E9 | 登录页也被 overlay + fetch hook 覆盖（阶段 2 已隔离） | `panel.ts:26`、`bridge/entry.ts` | 登录页 Console |
| E10 | 纯净模式 `-20000` + `setVisible(false)` + `backgroundThrottling:false` | `entry.ts:205, 409-415` | `[visibilityState, screenX, hasFocus]` |
| E11 | 硬件预设全 Windows（`HARDWARE_PRESETS` 6 套均 `win-*`）；`platformVersion` 另有 mac/linux 写死分支 | `fingerprint.ts:35-84,331` | 跨平台真机 |

### 1.4 行为层已确认（运行环境）

| 动作 | 位置 | 问题 |
|---|---|---|
| 点发送 | `chat-input.ts:654,1136`、`providers/deepseek.ts:129-133`、`providers/chatgpt.ts:113` | DeepSeek 已是 Pointer/Mouse 序列 + click；其余为 `btn.click()` → `isTrusted=false` |
| 合成键盘 | `chat-input.ts:1160-1162`、`providers/deepseek.ts:151-154` | `dispatchEvent(new KeyboardEvent)` → `isTrusted=false` |
| 输文字 | `providers/chatgpt.ts:86` | `execCommand('insertText')` → untrusted |
| 停止按钮 | `app/ipc/harness.ts:369-374` | 合成 Pointer/Mouse；**CDP 版本已被真机证否**，`harness.ts:358-361` |

可信路径已有实现：`app/ipc/cdp-attach.ts:344-346`（`Input.dispatchMouseEvent`，仅用于附件点击）。

### 1.5 文档漂移

- `.agents/handoff.md:38` 写"纯净模式保持 `setVisible(true)`、只移 bounds"，与 `entry.ts:415` 实际 `setVisible(aiVisible)` 不一致。
- `entry.ts:536-542` 的注释同样写"保持 `setVisible(true)`"，与 415 行矛盾。阶段 2 一并修正。

---

## 2. 修复项

### 阶段 1（本次执行，低风险、可验证）

#### A1. 启用内置 PDF viewer，修 `navigator.plugins`

- 文件：`src/app/entry.ts:199-209`
- 改法：AI view 的 `webPreferences` 增加 `plugins: true`；壳/harness/overlay 不加。
- 依据：Electron 官方 `plugins` 默认 `false`；真 Chrome 有 PDF viewer 插件与 mimeTypes。
- 风险：渲染进程内存上升；需真机验证启动时间与稳定性。
- 验证：登录页 `navigator.plugins.length > 0`、`navigator.mimeTypes.length > 0`。

#### A5. 收口 `getBrands` / `getWd` 的 toString

- 文件：`src/infra/user-agent.ts:78-250`
- 改法：在脚本内部自建 `nativeStrings` WeakMap + 对象方法简写的 `hookedToString`，包住 `Function.prototype.toString`；`getBrands`、`getWd`、`patched(getHighEntropyValues)` 统一 `markNative` 注册；仅在 WeakMap/补丁不可用时才退回自有 `toString`。
- 依据：`Function.prototype.toString.call(fn)` 不看 `fn.toString`，必须走全局 WeakMap。
- 风险：脚本会在每个页面 patch 一次全局 toString；与 fingerprint / native-mask 的补丁链式共存（各自保留上一层 orig）。
- 验证：`Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get)` 返回 `[native code]`；`desc.get.hasOwnProperty('toString') === false`。

#### B2. hook 去 `prototype` + 去自有 `toString`

- 文件：`src/providers/hooks/shared/native-mask.ts`、`deepseek.ts:462,551,562,573`、`chatgpt.ts:473,535,546`、`claude.ts:182,202,206`
- 改法：
  - 10 个 hook 包装函数改用**对象方法简写**（`({ fetch(input, init) {...} }).fetch`），天生无 `prototype`，`this`/`arguments` 语义不变；
  - `maskAsNative` 不再给函数加自有 `toString`（只依赖 WeakMap；WeakMap/补丁失败时才退回自有 toString）；
  - `delete fn.prototype` 保留为兜底，不再依赖；
  - `name`/`length` 保持现状：原生函数这两个属性本身 `configurable: true`，已对齐（原分析"可配置即异常"不成立）。
- 风险：方法简写的 `name` 由语法决定，`length` 用 `defineProperty` 对齐；`window.fetch` 的自有属性残留记入 B6，阶段 2 处理。
- 验证：`fetch.hasOwnProperty('prototype') === false`、`fetch.hasOwnProperty('toString') === false`、`fetch.length === 1`；XHR 三个方法同样；`Function.prototype.toString.call(fetch)` 为 `[native code]`。

#### B1. 删除页面标记，改为主进程文档代次幂等

- 文件：`src/app/fingerprint.ts:202-206`、`src/app/net-identity.ts:578-579,606-620,788-809`、`src/app/entry.ts:746` 的 `did-navigate`
- 改法：
  - 删除两处 `window.__cuckoo*` 定义与判断；
  - `CdpState` 增加 `docEpoch` / `evaluatedEpoch` / `evaluatedScript` / `registeredSource` / `armedSourceAtDocStart`；新增导出 `resetNetIdentityDoc(wc)`，在 `did-navigate`（主帧、含同 URL 刷新）递增 `docEpoch` 并快照「导航前已注册脚本的全文」；
  - `applyNetIdentity` 每次仍按最新配置重注册脚本，供后续文档使用；只有当「当前文档已执行过同一份脚本」或「本文档 document-start 已自动执行同一份脚本」时才跳过 `Runtime.evaluate`；同配置热更新不重复 patch，配置变更必须重新评估；
  - DevTools 关闭复用同一文档的评估结果，避免重复 patch。
- 风险：`did-navigate` 若在 `did-finish-load` 之后才触发，最多多一次评估，不会漏注入；单测锁住「同文档同配置只 evaluate 一次、导航后同脚本跳过、无注册脚本补一次、配置变更重新 evaluate」。
- 验证：`Object.getOwnPropertyNames(window).filter(k=>k.includes('cuckoo'))` 为空；同一画布连续 `toDataURL` 两次 hash 一致且只加噪一次。

### 阶段 2（本次不做，排期后执行）

- **A2**：补 `chrome.app.getDetails/getIsInstalled`、`chrome.runtime.connect/sendMessage/id`。**阻塞**：需真 Chrome 普通网页采样完整属性清单与调用语义；新增方法必须走 A5 的 native 收口。
- **A3**：`platformVersion` 按系统真实值。**阻塞**：Windows 11 build 分档映射需查 Chromium 实现（`13/14/15.0.0` 不能一刀切）；先只改 Windows 分支。
- **A4**：登录/OAuth 路径跳过 overlay 与 hook。**阻塞**：需逐平台采样登录路径；必须覆盖 `window.open` 弹窗（当前无 `setWindowOpenHandler`）；恢复逻辑要明确 `init()` 的跳过范围，避免登录后 SPA 回对话页缺监听。
- **B3**：DOM 去品牌化。范围 = root id（同步 `scroll-follow.ts:24`）+ 100 个 `cuckoo-*` id/class + `data-cuckoo-stop-target` / `data-cuckoo-attach-input` + 全量 JS 选择器。
- **B4**：localStorage 去品牌化。`cuckoo-ds-headers` 改事件/IPC 回传（不落盘）；其余 key 迁移以 `global-settings` 为权威源，保留一个版本旧 key 读取。
- **B6**：`window.fetch` 改到 `Window.prototype`，需真机验证页面脚本兼容性。
- **C1**：纯净模式不再移出屏幕；同步删除 `entry.ts:536-542` 的旧注释/语句；真机量 CPU/多窗口内存后再定。
- **C2**：F12 生产构建拦截；开发模式保留。
- **C3**：跨平台硬件预设；需 mac/Linux 真机采样 `UNMASKED_RENDERER_WEBGL`。
- **D**：行为层。D4（停止）已被真机证否，不改；D1/D2/D3 先逐事件取证 `isTrusted` 是否真的被站点使用，再决定是否值得动。

### 明确不做

- 不补 OffscreenCanvas / ImageBitmap 噪点；Canvas/Audio 微扰默认关闭需产品决策。
- 不改 TLS、不改字体/屏幕/GPU 驱动。
- 不处理代理 IP 质量、账号身份层。

---

## 3. 验收标准

### 3.1 静态检查（登录页 Console）

```js
Object.getOwnPropertyNames(window).filter(k => k.includes('cuckoo'))   // []
window.fetch.hasOwnProperty('prototype')                               // false
window.fetch.hasOwnProperty('toString')                                // false
Function.prototype.toString.call(window.fetch)                         // 'function fetch() { [native code] }'
Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get)
navigator.plugins.length                                               // > 0
```

### 3.2 运行检查（纯净模式）

```js
[document.visibilityState, window.screenX, window.screenY, document.hasFocus()]
// 阶段 1 不变，仍为 ['hidden', -20000, -20000, false]
```

### 3.3 门禁

- `npm run typecheck` 0 错
- `npm test` 全绿（基线 151 文件 1538 用例）
- `npm run lint` 0 error
- `npm run compile` 通过（含 hook-sources 重建）
- `npm run docs:index`（新增需求档案后）

### 3.4 真机回归（阶段 1 必须做）

- 登录：DeepSeek/ChatGPT/Claude 登录页能正常登录
- 对话：新建对话、投递、附件、停止、压缩、子代理
- 纯净模式：切换、面板、滚动跟随、长对话不卡
- 多窗口：3 个窗口并行，内存与 CPU 在可接受范围

---

## 4. 执行顺序与里程碑

| 阶段 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| 1 | A1 + A5 + B2 + B1 | 1 天 | 无外部采样 |
| 2 | A2 + A3 + A4 + B3 + B4 + B6 | 3-4 天 | 真 Chrome 采样、OAuth 路径采样 |
| 2 | C1 + C2 | 1 天 | 真机性能测量 |
| 2 | C3 | 1 天 | mac/Linux 采样 |
| 3 | D（取证后决定） | 待定 | 逐平台真机 |

---

## 5. 阻塞点与待确认

1. **真 Chrome 属性清单**：`chrome.app` / `chrome.runtime` 的完整自有属性与方法签名。
2. **Windows 11 `platformVersion` 映射**：按 build 分档，禁止一刀切。
3. **各平台登录路径清单 + OAuth 弹窗行为**。
4. **Canvas/Audio 是否默认关闭**：产品决策。
5. **D 阶段是否值得做**：先取证。

---

## 6. 回滚方案

- 阶段 1 一个 commit；阶段 2 按 A/B/C 分文件提交，禁止混提。
- 分支 `fix/127-env-fingerprint-hardening`，不合 master 前保留 `0.10.231` tag 可回退。
- B3 模板替换前先 `git tag` 本地快照点；生成物重建失败可 `git checkout -- src/overlay/template.generated.ts`。
- B4 迁移保留旧 key 读取一个版本。

---

## 7. 文档同步

- 阶段 1 完成后更新 `.agents/handoff.md` 的纯净模式描述与本次改动摘要。
- 新增 `docs/requirements/127-env-fingerprint-hardening.md`，记录根因、改动、验证、遗留。
- `changelogs/2026-11.md` 顶部追加条目（`Security` / `Fixed`），版本号禁含 4。
