# 设置全局化 + 防封默认收紧 + 队列停止加固 - 对抗性代码审计报告

## 1. 门禁裁决
- **裁决结果**：⚠️ CONDITIONAL PASS → 修复后 ✅ PASS
- **审计范围**：`git diff --cached`（42 个文件，+1538 / -242 行）
- **裁决理由**：发现 1 处 🔴 严重缺陷（防封迁移对老用户完全失效）+ 1 处 🟡 中等并发缺陷，均已修复并补回归测试；全量校验绿。

## 2. 改动链路与闭环核验

### 核心改动摘要
1. **设置全局化**：设置从「AI 页面 localStorage 唯一源」升级为「主进程 ~/.cuckoo/agent-settings.json 权威源 + localStorage 运行时缓存」，解决多窗口设置互不同步。
2. **防封默认收紧**：重试次数 10→3、重试间隔 4~10s→15~30s、429 重试 40→1、看门狗 3→1、发送间隔 1~10s→6~16s。
3. **浏览器指纹伪装**：禁 Blink `AutomationControlled`、`navigator.webdriver` 走原型链、补 `window.chrome` 全套。
4. **任务队列先停后发**：`sendQueueItemNow` 严格 stop → 清输入框 → 等静默 → 发送。
5. **多端停止闭环**：手机端/纯净模式停止后广播级联、终态收敛。
6. **壳页面布局跨窗口同步**：侧栏宽度/活动栏顺序/显隐经主进程广播。

### 两端闭环取证
- **起点（触发）**：`src/app/entry.ts:610-620`（did-finish-load 下发/迁移）→ 已核实
- **终点（落盘+运行时）**：`src/app/global-settings.ts:196-201`（writeJsonAtomicSync 原子落盘）→ `src/bridge/entry.ts:184-191`（cuckoo-sync-settings → applySettingsData 写 localStorage）→ 已核实
- **Untracked 漏提风险**：无（`git status --untracked-files=all` 无 `??` 行）

## 3. 缺陷与风险取证清单

### 🔴 严重：migrateLegacy 的 LEGACY_DEFAULTS.sendDelay 值写错，防封迁移对老用户完全失效
- **定位**：`src/app/global-settings.ts:135-141`（原值 `sendDelayMin:4, sendDelayMax:12`）
- **事实证据**：
  - 取证 1：`git show HEAD:src/overlay/state.ts` → `sendDelayMin:1000, sendDelayMax:10000`（**毫秒** = 1/10 秒）
  - 取证 2：`git show HEAD:src/overlay/panels/settings.ts` → `sec(lsGet('cuckoo-send-delay-min'), 1)` / `sec(..., 10)`（秒单位默认 1/10）
  - 取证 3：老用户 localStorage 若存过设置，值为 `'1000'`/`'10000'` ms → 转秒后 `SettingsData.sendDelayMin/Max = 1/10`
  - 取证 4：`migrateLegacy` 比对 `same(1, 4) && same(10, 12)` = **false** → 不迁移，保留 1/10 秒
- **缺陷代码与推演**：编写者把需求文档里「4-12 秒」的**目标值**误写成「旧默认值」放进 `LEGACY_DEFAULTS`。老用户升级后 `sendDelay` 保持 1/10 秒，防封节奏优化（需求 089 核心目标之一）**100% 失效**。
- **潜在危害**：老用户升级后继续以高危节奏发包，反爬风控不降反升；且用户打开设置页看不到异常（值「看起来合理」），难以察觉。
- **修复方案**：`LEGACY_DEFAULTS.sendDelayMin/Max` 改为 `1/10`，并补一条防回归测试锁死语义。
- **修复状态**：✅ 已修复（`global-settings.ts` + `test/app/global-settings.test.js` 新增用例「旧真值 sendDelay 1/10 秒必须命中迁移（防回归）」）
- **信心评分**：10/10

### 🟡 中等：save-settings 并发时发起方窗口 localStorage 会持陈旧数据
- **定位**：`src/app/ipc/settings.ts:153-163`（原 `broadcastSettings(next, getAiWebContents(event.sender))` 跳过发起方）
- **事实证据**：
  - 落盘用「await 后重读的最新值 + delta」→ 文件最终正确
  - 但广播跳过发起方 → 若两窗口在同一 await 窗口（~50ms）内并发保存**不同字段**，后完成方会：
    - 先用「旧 latest + 自己 delta」推给 AI 页面校验（提交给 AI 页面的数据缺另一窗口的字段）
    - 再广播跳过自己 → 其 AI 页 localStorage 永久缺另一窗口刚写的字段
  - 运行时 hook/loop 同步读 localStorage → 会拿到错值
- **潜在危害**：多窗口同开 + 快速连改不同设置项（或脚本化操作）时，某窗口运行时配置与文件不一致，需重载页面才纠正。
- **修复方案**：广播不跳过发起方（重复收到同一份数据是幂等应用，成本可忽略）。
- **修复状态**：✅ 已修复（去掉 skip 参数）
- **信心评分**：8/10

### 🟢 轻微：注释与实现不符（已一并对齐）
- `src/app/ipc/settings.ts:62` JSDoc 声称广播「含纯净模式 harnessView」，实现只发 `ctx.view` → 已修正 JSDoc
- `src/app/global-settings.ts` 头注释「sendDelay: 4~12s → 6~16s」与旧真值 1~10s 不符 → 已修正
- `docs/requirements/089` 多处写 4-12 秒，实现为 6-16 秒 → 已同步文档

### 🟢 轻微：clearInputArea 失败时 catch 缺少可选链
- `src/bridge/harness-bridge.ts:178` → `err?.message` 已用可选链，无实际缺陷（审计确认，无需改）

## 4. 五维核查矩阵回执
- [x] **架构契约与安全红线**：已取证核查。依赖方向合规（app 依赖 infra，未反向）；`*.generated.*` / `api.d.ts` / `shell.html` 均未手改（compile 重新生成）；无硬编码密钥。
- [x] **端到端功能闭环**：见 §2，两端取证完整；未发现死代码/半截工程。
- [x] **对抗性 Bug 与并发安全**：见 §3（发现并修复 2 处真缺陷）。
- [x] **性能与代码复杂度**：`layout-sync` 有防回环守卫（`applying` + 值未变则跳过 apply）；`broadcastShellLayout` 只在 `shellLayout` 变更时触发；`sendChain` 串行化保证消息不交织。未发现热路径退化。
- [x] **领域专项（AI Agent）**：
  - 忙态准入：`manualSendInFlight` + `flushingSuppressed` + `sendQueue` 串行化 → ✅
  - 流式终态收敛：`observer.ts` 的 `aborted` 抑制 + `emitUserStop` + `watchdogSuspended` → ✅
  - 多会话隔离：`manualSendToken` 令牌在 `clearTransientState` 时自增，在途等待作废 → ✅
  - 可见历史 vs 实际上下文：手机用户消息 → `harness-event-report` → harness 渲染用户气泡；框架内部消息 tag 过滤不上报 → ✅

## 5. 全量验证结果
- `npm run typecheck` → 通过
- `npm test` → **130 套件 / 1267 用例全绿**
- `npm run lint` → 0 errors（65 warnings 均为历史存量 unused-vars）
- `npm run compile` → 通过（`shell.html` 522080 字节）
