# 最新接续状态 (2026-10-29 第三场 · 已发版)

## 核心进展
- **需求 095 已合入 master 并随 v0.10.168 发布**：修复子代理窗口泄漏远程事件导致手机误报「已停止生成」。
- **上一版 v0.10.167**：修复远程扫码按钮布局 + APK 固定签名（需求 094）。
- **当前版本**：v0.10.168。

## 095 问题与根因

### 症状
手机远程端在主对话执行任务期间会莫名弹「已停止生成」，电脑端主对话其实还在跑。

### 根因（已取证）
1. `src/bridge/entry.ts` 的 `initRemoteBridge()` **无条件执行**——子代理窗口也初始化了一份（同文件 `initPlugins` 已有 `if (!subCfg)` 门控，remote 漏了）。
2. 子代理复用父窗口 profileId（`src/app/profile.ts:153` `id: parent.id`，为了共用账本/token/设置）。
3. 子代理跑满 maxTurns 时调 `requestAbort()`（`src/bridge/subagent.ts:126`）→ `emitUserStop()` → 子代理窗口的 remote-bridge 上报 `ai-stop` → 主进程按父 profileId 广播 → 手机弹「已停止生成」。
4. 同一路径还会把子代理的 `ai-stream`/`ai-reply`/`tool`/`ai-error` 混进主对话。

### 相邻泄漏路径（审查发现，一并修）
`addWindow` 无条件 `lastActiveWindowId = win.id`，子代理创建时抢占「主窗口」指针 → `getMainContext()`（12 处调用方）在子代理运行期间返回子代理 → 手机未选窗口时远程「停止」会定位到子代理窗口。

### 修复
- `src/bridge/entry.ts`：`if (!subCfg) initRemoteBridge();`
- `src/app/ipc/remote.ts`：`remote-report` 里 `if (ctx && ctx.isSubagent) return { success: true };` 兜底
- `src/app/window.ts`：新增 `pickMainWindowId()`（排除子代理），`addWindow`/`removeWindow`/closed 回退/`getMainContext`/`getMainWindow`/`setMainWindow` 统一走同一规则
- `test/main/window.test.js`：5 个回归用例

## 验证
- `npm run typecheck` ✅
- `npm test` ✅ 131 文件 / 1304 用例
- `npm run lint` ✅ 0 error（65 个既有 warning）
- `npm run compile` ✅
- 子代理 code-reviewer 两轮独立审查，第二轮指出 5 条低/中建议，已全部收口（真值判断改显式 null、getMainContext 补兜底、setMainWindow 补注释、补多主窗口回退用例）
- **未做真机验证**：需 `npm start` 跑一次 `runAgent` 观察手机端不再误报

## 真机验证清单（待做）
- A. 主对话跑 `runAgent`，子代理收工期间手机端**不**出现「已停止生成」
- B. 子代理的流式文本不混进主对话气泡
- C. 手机端主动点停止仍正常显示「已停止生成」
- D. 多窗口场景下 `getMainContext` 返回正确的主窗口（不受子代理影响）

## 调查中发现的其它问题（未修，待用户确认是否立项）
1. **watchdog 兜底收尾复用 `ai-stop`**（`src/remote/manager.ts:334`）：网页停止生成且静默超 8 秒后主动调 `onAiStop`，手机显示「已停止生成」，实际可能只是 finished 帧丢失。语义上应区分「用户停止」与「本轮已结束」，需新增独立事件类型。
2. **ChatGPT 平台把断流判为 stopped**（`src/providers/hooks/chatgpt.ts:117`，`aborted = AbortError || XHR status===0`）：弱网/切后台会误判为用户主动停止。DeepSeek hook 只认拦截到的 `stop_stream` 请求，无此问题。
3. **`onPhoneStop` 双次 ai-stop**（pre-existing）：`manager.ts:127` 直接 `onAiStop`，主窗口 hook 的 `onUserStop` 也会再报一次。手机侧幂等，非本次引入。

## 遗留
- 上面 3 条待用户确认。
- 092 子代理并发池的真机验证清单 A~H 仍未做（历史遗留）。
- `v0.10.164` tag 违规（含数字 4）仍在 origin，是否删除待用户决定。

## 教训
- **「共用 profileId」是隐形炸弹**：任何以 profileId 为键的广播/状态，都必须显式区分主窗口与子代理。`ai-state` 早就做了分离（`window.ts` 注释写明），但 `remote-report` 和 `lastActiveWindowId` 两处都漏了。以后新增以 profileId 为键的逻辑，先问一句「子代理会不会污染」。
- 同一根因往往有多条泄漏路径，修完主路径要顺着 grep 一遍 `profileId` 的消费点。
