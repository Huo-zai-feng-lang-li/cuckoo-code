# 最新接续状态 (2026-11-11 v0.10.220 Token 页面布局优化发版)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`master`（已打 tag `v0.10.220` 并推送到远程）
> 当前版本：`0.10.220`（下一版 `0.10.221`，再下 `0.10.222`，版本号任意位置禁含数字 4）

---

## 0. 总览：纯净模式各链路已闭环，气泡横向药丸排版与计时全量修复

四门禁全绿（146 个测试文件、1471 个用例 100% passed，编译/类型检查/代码规范全绿）。

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| A 纯净模式发送链路与逐请求回执 | ✅ 代码闭环 | 逐请求 requestId 回执已闭环，残留校验与 URL 误判已解决 |
| B 随机长暂停：独立计时与黄色高亮 | ✅ 代码闭环 | 解耦常规延迟与长暂停计时，`sendStartAt` 重置；数字全量 `<b>` 黄色高亮 |
| C 宠物气泡横向展开与输入框加长 | ✅ 代码闭环 | 彻底修复 `min-content` 竖排坍缩 Bug，恢复 `nowrap` + `width: max-content`；加固 bubble HTML 转义防御 XSS |
| D 上下文阈值自动切换窗口 | ✅ 代码闭环 | 复用限流链路，摘要模式先摘要再分享最近 20%；加固源窗口销毁清理防挂死 |
| E 暂存区对抗审计与闭环加固 | ✅ 审计全闭环 | 3 个子代理红队推演复核完成；修复 XSS 隐患与分享超时死锁；146测试套件1471用例100%通过 |

---

## 1. 核心进展与 Bug 修复记录 (2026-11-11 最新)

### 1.1 修复气泡竖排坍缩 Bug（"不能变成竖着的"）
- **现象**：用户真机测试发现，宠物下层状态气泡变成了极其细长的垂直长条，文字竖向每行一个字排列（如"触\n发\n随\n机..."、"等\n待\n发\n送\n9s"）。
- **根因**：气泡父容器 `.ck-pet-bubbles` 采用 `flex-direction: column; align-items: center;`。此前为防止长文案溢出引入了 `white-space: normal; word-break: break-word`。在未指定显式宽度的 flex 容器中，浏览器按照 `min-content`（最小内容单元）计算气泡宽度，而中文字符之间处处可折行，导致宽度直接坍缩为单个汉字宽度加 padding（约 40px），渲染成垂直竖条。
- **修复**（`src/ui/pets/pet.css` 及 `src/ui/pet-window.html`）：
  - 显式声明 `width: max-content;`；
  - 恢复 `white-space: nowrap;`；
  - 移除 `word-break: break-word;` 与 `overflow-wrap: break-word;`；
  - 确保气泡无论在内嵌模式还是独立浮窗中，均严格按文本内容自然横向展开为单行圆角胶囊。

### 1.2 修复常规延迟超时与随机长暂停计时叠加 Bug
- **现象**：用户设置发送延迟为 4~20 秒，真机运行时等待却超过了 20 秒，且下层气泡未标明触发长暂停。
- **根因**：底层长暂停（30~75秒）触发时派发了 `send-pause` 事件；长暂停结束后切回常规延迟发送时，`sendStartAt` 仍保留着最开始的时间戳未被重置。导致长暂停消耗的时间被全额算入了常规延迟中，秒数直接从 30 多秒开始跳，让用户误以为常规延迟超标、长暂停没有生效。
- **修复**（`src/ui/harness.html`）：
  - 在 `case 'send-pause'` 中，无论长暂停触发进入（`sendPauseActive=true`）还是暂停结束恢复常规延迟（`wasPauseActive=true`），均立即重置 `sendStartAt = Date.now()`；
  - 恢复常规延迟时立即调用 `renderSendTick()` 刷新视图，使长暂停与常规发送延迟的计时域完全隔离，常规延迟严格落在用户配置的 4~20 秒内。

### 1.3 消除随机长暂停后常规延迟二次叠加（体验与性能最优）
- **现象**：长暂停结束后，状态气泡又显示“等待发送 N秒”，需要再等 4~20 秒才发，总等待时间长达近 1 分钟。
- **根因**：`chat-input.ts` 在长暂停执行完后，仍无条件执行 `reactionMs`（反应停顿）与 `hesitationMs`（犹豫停顿），导致走神几十秒后又二次等待。
- **修复**（`src/overlay/chat-input.ts`）：
  - 标记 `didLongPause = true`；
  - 一旦触发并完成了随机长暂停，拟人与避风控效果已极其充分，直接将 `reactionMs` 与 `hesitationMs` 置 0，长暂停结束后直接分块填入输入框并发送，不再产生任何二次叠加等待。

### 1.4 原生页面遮罩对接随机长暂停状态（状态可见性修复）
- **现象**：原生 DeepSeek/ChatGPT 页面顶部悬浮条在长暂停时没有任何专用文案，用户看不到长暂停状态。
- **修复**（`src/overlay/panel.ts` & `src/overlay/events.ts`）：
  - `panel.ts` 引入 `updateMaskSendPause(active, durationMs, onCancel)`；
  - 长暂停激活时确保移除 `cuckoo-hidden` 显示遮罩，文案精准渲染为 `触发随机概率延迟（共 <b>Xs</b> · 已等 <b>Ys</b>），可点下方停止`；
  - 顶部取消按钮绑定 `cancelPendingSend()`，允许用户随时中断长暂停；
  - 结束时复位长暂停状态，发送完成后平滑隐藏。

### 1.5 下层状态气泡数字统一黄色高亮 (`<b>...</b>`)
- **实现**（`src/ui/harness.html`）：
  - 改造 `pauseStatusText(waitSec)`，将触发次数、总时长、等待秒数全部包裹进 `<b>` 标签：
    `触发随机概率延迟 第<b>{count}</b>次 · 共<b>{pauseSec}秒</b> · 等待发送 <b>{wait}秒</b>`；
  - 在 `renderSendTick` 及 `syncPet` 时传递 `html: true`，使其完美命中 `.ck-pet-bubble b` 的金黄色发光胶囊样式，与常规 `等待发送 <b>{N}秒</b>` 保持视觉统一。

### 1.6 加长输入框
- **优化**（`src/ui/harness.html`）：
  - 将 `.composer` 的横向 padding 从 32px 缩减至 20px（`padding: 24px 20px 40px;`），释放更多水平排版空间，防止长文本局促。

### 1.7 彻底根除回传失败重试导致的二次延时超标与内容翻倍
- **现象**：用户配置发送延迟 4~20 秒，真机实测等待耗时却达 30 多秒，且宠物气泡未提示随机长暂停，依然显示“等待发送 32s”。
- **真实根因**（真机日志确证）：
  1. **首次发送失败判定**：工具执行完后初次拟人化等待 16 秒，由于发送按钮点击仅通过 `btn.click()`，或受控输入框清空慢，2.5s 观察窗内输入框未完全清空，`sendAndConfirm` 判定第 1 次发送失败。
  2. **重试重新计算拟人延迟**：`sendToolResultWithRetry` 触发第 2 次重试，但调用 `sendCombinedJsResultsToChat` 时未传入重试标记，导致重新计算了一次完整的 12 秒拟人化反应和犹豫延迟！两次延迟叠加：`16s + 12s = 28s`，加上执行和检测开销，纯净页面和宠物看到的就是 30 多秒！
  3. **输入框旧工具回传重复拼接翻倍**：初次填入输入框但未发出的 5061 字符，在第 2 次重试时被误当成“用户已输入内容”追加在前面，导致消息长度翻倍至 10127 字符，恶性循环。
  4. **纯净模式顶部状态栏文案未跟随**：`renderSendTick` 中 `statusText` 死板硬编码为【结果待发送】，长暂停时只有气泡变，状态栏不变。
- **修复**：
  - `src/bridge/intercept/observer.ts`：在 `sendToolResultWithRetry` 中，重试（`attempt > 1`）传递 `isRetry = true`；
  - `src/overlay/chat-input.ts`：
    - `sendCombinedJsResultsToChat` 增加 `isRetry?: boolean` 参数，重试走 300ms 快速通道，杜绝二次叠加拟人延迟；
    - 输入框防残留保护：重试期间或输入框内容已包含工具回传前缀时，严禁当作用户输入重复拼接翻倍；
  - `src/providers/deepseek.ts`：`triggerSend` 派发完整的 PointerEvent + MouseEvent 序列并执行 DOM click，确保 Vue 状态机 100% 响应；
  - `src/ui/harness.html`：`renderSendTick` 状态栏文字跟随 `sendPauseActive` 实时显示 `随机长暂停中（第X次 · 共Xs · 等待Ys）`，并在接收到激活事件时自动起跑 `startSendTick(0)` 倒计时。

---

## 2. 关键设计与实现回顾

### 2.1 逐请求回执闭环链路
- 前端 `harness.html` 生成 `requestId` → preload `sendMessage(text, requestId)` → 主进程 `harness-send` 挂 `waitForUserMessageReceipt`（150s 超时）→ 转发 `harness-user-message` 带 `requestId` → bridge 三路（成功/失败/异常）回传 `harness-user-message-result` → 主进程 `await` 后返回 `{success,error}`。
- 草稿回填：清空前暂存 `pendingDraft`；失败且输入框仍空时回填原文，非空不覆盖。

### 2.2 拟人化延迟算法与时序规划
- 底层算法（`src/overlay/chat-input.ts`）：
  - `randomDelay(msg)`：认知模型映射到 `[state.sendDelayMin, state.sendDelayMax]`，添加 ±35% 随机抖动并双向 clamp，边界处有独立离散抖动，数学上 100% 严格落在配置区间内。
  - `planSendTiming(msg, prevReplyLen)`：将总延迟严格拆分成 $R$（填充前反应停顿）+ $S$（填充后犹豫停顿），二者相加严格等于总延迟。
  - 真实耗时 = 延迟时长 + 底层 DOM/IPC 输入开销（约 0.1~0.3s），绝不超标。

---

## 3. 验证账本 (2026-11-11 实测全绿)

| 门禁 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| compile | `npm run compile` | 0 | hooks/sanitizer/pets/api.d.ts/bootstrap/shell.html 全量重建更新 |
| typecheck | `npm run typecheck` | 0 | `tsc --noEmit` + `tsc -p tsconfig.hooks.json` 零类型报错 |
| lint | `npm run lint` | 0 | 0 errors，70 warnings（均为历史无用变量提示） |
| test | `npm test` | 0 | **146 files passed, 1471 tests passed (100% 通过)** |

---

## 4. 关键上下文

- 根目录：`d:\Desktop\Super-File\cuckoo-code`
- 核心文件：
  - `src/ui/pets/pet.css`：宠物气泡样式定义（`white-space: nowrap; width: max-content;`）
  - `src/ui/pet-window.html`：独立桌面宠物浮窗（同步气泡样式覆盖）
  - `src/ui/harness.html`：纯净模式 UI 状态机、输入框布局、长暂停事件处理与倒计时渲染
  - `src/overlay/chat-input.ts`：发送串行链、拟人化延迟计算与分段等待
  - `src/bridge/harness-bridge.ts`：桥接通信、逐请求回执上报
