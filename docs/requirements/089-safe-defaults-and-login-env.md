# 需求 089：修复登录环境反爬风控与收紧自动化默认节奏配置

## 1. 核心目标
针对近期 DeepSeek 与主流平台反爬风控升级导致的封号与拦截问题，修复登录环境的浏览器指纹伪装破绽，并调整默认重试/超时次数与发送延迟区间，降低自动化特征。

## 2. 问题分析与根因定位
1. **浏览器指纹与登录环境特征泄露**：
   - `src/infra/user-agent.ts` 中 `buildUserAgentDataFix()` 直接使用 `Object.defineProperty(navigator, "webdriver", ...)` 在实例上定义属性，导致 `navigator.hasOwnProperty('webdriver') === true`。现代 WAF（Cloudflare、Datadome 等）与登录风控直接将其标记为自动化机器人。
   - Electron 主进程未禁用 Blink 特性 `AutomationControlled`，导致 Chromium 内核原生处于受控自动化模式。
   - 缺少真实的 `window.chrome` 运行时对象及其子属性（`runtime`, `loadTimes`, `csi`, `app`），导致 Google 登录与 OAuth 授权抛出"此浏览器或应用不安全"。
2. **重试与超时默认频率过高**：
   - 流静默超时看门狗 `cuckoo-watchdog-count` 默认为 3 次。
   - HTTP 429 频繁限制重试 `cuckoo-retry-429-count` 默认为 40 次，限流后持续高频重试极易触发账号封禁。
   - 普通失败重试 `cuckoo-retry-count` 默认为 10 次，间隔 4~10 秒，节奏偏激进。
   - 需将默认超时催促次数及 429 重试次数均收紧为 1；普通重试收紧为 3 次、间隔 15~30 秒。
3. **发送延迟节奏**：
   - 默认发送延迟区间原为 1-10 秒，下限过低容易被行为流风控检测。
   - 实际实现取更保守的 6-16 秒（6000ms - 16000ms），比文档早先设想的 4-12 秒更贴近人。

## 3. 详细设计与改动清单
- `src/app/entry.ts`：
  - 启动阶段执行 `app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')`，从 Chromium 引擎层彻底禁用自动化控制特性。
- `src/infra/user-agent.ts`：
  - 重写 `buildUserAgentDataFix()`：
    - 确保 `navigator.hasOwnProperty('webdriver') === false`，在 `Navigator.prototype` 原型链上定义 `webdriver` getter 返回 `false`。
    - 将 `userAgentData` 定义在 `Navigator.prototype` 上。
    - 补齐标准 `window.chrome` 及其属性。
- `src/bridge/loop/watchdog.ts`：
  - `DEFAULT_COUNT` 默认值由 3 调整为 1。
- `src/bridge/loop/retry.ts`：
  - `DEFAULTS.count429` 默认值由 40 调整为 1；`DEFAULTS.count` 由 10 调整为 3；`delayMin/Max` 由 4000/10000 调整为 15000/30000。
- `src/overlay/state.ts`：
  - `sendDelayMin: 6000`（原 1000）。
  - `sendDelayMax: 16000`（原 10000）。
- `src/overlay/chat-input.ts`：
  - `randomDelay()` 的兜底值保持 1000/10000（仅 state 未就绪时使用）；真实默认节奏由 `state.sendDelayMin/Max`（6000/16000）提供。
- `src/overlay/panels/settings.ts`：
  - `openSettings`、`getSettingsData`、`resetSettings`、`resetSettingsData` 的默认值同步对齐：
    - `retryCount` 默认 3
    - `retryDelayMin` 默认 15（秒）
    - `retryDelayMax` 默认 30（秒）
    - `watchdogCount` 默认 1
    - `retry429Count` 默认 1
    - `sendDelayMin` 默认 6（秒）
    - `sendDelayMax` 默认 16（秒）
- `src/overlay/events.ts`：
  - 延迟配置输入框初始赋值对齐秒单位。
- 单元测试：
  - `test/infra/user-agent.test.js`：补充 `navigator.webdriver` 原型链与 hasOwnProperty 校验测试。
  - `test/bridge/loop/watchdog.test.js`：默认值断言更新为 1。
  - `test/bridge/loop/retry.test.js`：`count429` 默认值断言更新为 1。

## 4. 验证要求
- `npm run typecheck` 通过
- `npm test` 全部通过
- `npm run lint` 通过
- `npm run compile` 通过
