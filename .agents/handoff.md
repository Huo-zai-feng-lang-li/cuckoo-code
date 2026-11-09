# 最新接续状态 (2026-11-10)

## 本轮：需求 111 认知节奏发送管线 + languages 单元素修复（v0.10.213）

- **彻底解决「延迟太低封号 / 太高卡顿」两难**，把「干等」换成真人三段节奏：
  1. **R 反应停顿**（填充前，占比 0.3~0.55，与上一条 AI 回复长度正相关）+ **T 输入耗时**（原生 insertText 分块注入）+ **S 犹豫停顿**（填充后）。R+S 恒等于 `randomDelay(msg)`，总延迟严格遵守用户配置 `sendDelayMin/Max`。
  2. **默认延迟 6~16 秒 → 6~36 秒**（global-settings / overlay state / panels settings 三处 + 4 个测试）。
  3. **randomDelay 边界抖动**：命中 min 在 [min,min+25%] 抖动、命中 max 在 [max-25%,max] 抖动，消除「短文本恒等于 min」的固定节拍指纹，且不反转「越长越慢」语义。
  4. **手动操作回归 0ms**：纯净模式用户手动发送、快捷提示词、手机远程发送都是真人触发，加延迟反而是机器特征。
  5. **原生 insertText 完整性加固**：任一段失败即整体回退 DOM，校验最终长度（容差 16 字符）；textarea 清空后补 dispatch input。
  6. **可打断反应等待**：`interruptibleWait` + `PendingSend.wake`，停止信号立即唤醒。
  7. **navigator.languages 单元素修复**（实测确认的真实封号点）：CDP `setUserAgentOverride` 原先传单元素 `locale`，实测 `navigator.languages=["en-US"]`。新增 `buildAcceptLanguageList()` 生成完整偏好列表并兜底 ≥2 元素。
  8. **ensureDebugger 并发保护**：`attachingPromises` WeakMap + attach 后 `Runtime.evaluate` 存活验证，杜绝"假 attached"导致 CDP 全线超时。
  9. **远程调试端口默认关闭**：`start.js` 原默认开 9333（CDP 暴露可被风控探针检测），改仅显式设 `CUCKOO_DEBUG_PORT` 时开；`--dev` 不再自动开 9444。
- 验证：`npm run typecheck` / `npm run lint`（0 errors）/ `npm run compile` / `npm test`（135 文件 1377 用例 100% 通过）全绿。
- 真机 CDP 探针实测：`plugins=5`、`webdriver=false`、`chrome` 对象齐全、WebGL 渲染器自洽、`hardwareConcurrency=8`、`deviceMemory=8`、`screen=1920x1080`。
- 版本 0.10.212 → 0.10.213。
- **待用户真机验证**（当前开发实例跑的是旧代码，需重启）：发送时序是否落在 6~36s 配置区间、长消息完整性、`navigator.languages` 是否变成多元素。

---

## 核心进展

- **需求 110（原生输入 + 自适应延迟）** 已合并，本轮 111 在其上做认知节奏重构与配置合规修复。
- **需求 108/109**（网络隐私防泄露 + 每窗口独立硬件指纹）已闭环并通过三大检测站实测（passer-by / ip138 / browserleaks）。
- **指纹现状（实测）**：Canvas/Audio 闭包 WeakSet 幂等微扰、`Window.prototype` 原型链伪装、V8 原生函数 Cloaking、WebRTC mDNS 固定种子虚构、socks5h→socks5 规范化防 DNS 泄漏、`disable-blink-features=AutomationControlled`。

## 关键文件与改动（本轮）
- `src/overlay/chat-input.ts`: `planSendTiming` / `interruptibleWait` / `doSendToChat` 三段时序；`randomDelay` 边界抖动；原生注入完整性校验；`insertSnippet` 0ms。
- `src/app/net-identity.ts`: `buildAcceptLanguageList`；`ensureDebugger` 并发保护与存活验证。
- `src/bridge/intercept/observer.ts`: `contextLen` 透传（AI 回复长度 → R 占比）。
- `src/bridge/harness-bridge.ts`: 手动发送 0ms。
- `src/app/global-settings.ts` / `src/overlay/state.ts` / `src/overlay/panels/settings.ts`: 默认延迟 6~36 秒。
- `start.js`: 调试端口默认关闭 + 注释修正。
- 测试：`test/overlay/chat-input.test.js`、`test/overlay/extra.test.js`、`test/app/net-identity.test.js`、`test/app/global-settings.test.js`、`test/overlay/panels/settings.test.js`。
