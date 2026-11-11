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

### 1.3 下层状态气泡数字统一黄色高亮 (`<b>...</b>`)
- **实现**（`src/ui/harness.html`）：
  - 改造 `pauseStatusText(waitSec)`，将触发次数、总时长、等待秒数全部包裹进 `<b>` 标签：
    `触发随机概率延迟 第<b>{count}</b>次 · 共<b>{pauseSec}秒</b> · 等待发送 <b>{wait}秒</b>`；
  - 在 `renderSendTick` 及 `syncPet` 时传递 `html: true`，使其完美命中 `.ck-pet-bubble b` 的金黄色发光胶囊样式，与常规 `等待发送 <b>{N}秒</b>` 保持视觉统一。

### 1.4 加长输入框
- **优化**（`src/ui/harness.html`）：
  - 将 `.composer` 的横向 padding 从 32px 缩减至 20px（`padding: 24px 20px 40px;`），释放更多水平排版空间，防止长文本局促。

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
