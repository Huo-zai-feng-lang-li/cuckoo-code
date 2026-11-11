# 纯净模式「等待发送」超出配置上限 —— 偶发问题诊断记录

> 状态：**待修（偶发，暂不处理）**
> 记录日期：2026-11-11
> 关联需求：117 / 118（纯净模式状态与提示词附件）
> 关联提交：`5c3a26f fix: 彻底根除工具回传重试二次延迟与长暂停状态脱节`（v0.10.221）

---

## 一、现象

用户在设置页把**发送延迟区间**改为 **4~20 秒**，但在纯净对话模式下，宠物气泡/状态栏显示的「等待发送 / 结果待发送」秒数**偶发超过 20 秒**，有时达 40~70 秒。

关键观察（用户原话）：

> 如果有长暂停的话，宠物上面的提示会显示触发随机概率延迟提示的，但是秒数超过的时候显示的是等待发送。

即：**超时的那些轮次里，用户并没有看到「随机长暂停中（第 N 次 · 共 Xs）」文案**，只看到「结果待发送（工具 Xs · 延迟 Ys）」。

---

## 二、已核实的事实（代码取证）

### 2.1 配置确实生效了

`~/.cuckoo/agent-settings.json` 实际内容（2026-11-11 读取）：

```json
"sendDelayMin": 4,
"sendDelayMax": 20,
"pauseEnabled": true,
"pauseChance": 0.1,
"pauseMin": 30,
"pauseMax": 75
```

- `sendDelayMin/Max` 单位是**秒**，4/20 正确落盘（`src/app/global-settings.ts` L77-78 默认 4/30）。
- `pauseEnabled` 仍为 `true`，长暂停**没被关掉**。

### 2.2 发送延迟严格 clamp，不可能自己超上限

`src/overlay/chat-input.ts` L59-91 `randomDelay()`：

- L60-61 取 `state.sendDelayMin/Max`
- L72-78 认知模型 + ±35% jitter 后 **`Math.max(min, Math.min(max, target))` 强制钳制**
- L86-89 命中边界时在边界内侧抖动，仍不越界

`planSendTiming()` L102-108 把总延迟拆成 R/S 两段，和恒等于 `randomDelay()` 的返回值。

**结论**：只要走 `randomDelay`，单次等待不可能超过 `sendDelayMax`。超出部分必然来自别处。

### 2.3 唯一能突破上限的是「随机长暂停」

`src/overlay/chat-input.ts` L364-378：

```ts
if (state.pauseEnabled && fixedDelay === undefined
    && usesNaturalDelivery(tag) && Math.random() < state.pauseChance) {
  const minMs = state.pauseMinMs;              // 30000
  const maxMs = state.pauseMaxMs > minMs ? state.pauseMaxMs : minMs; // 75000
  const pauseMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  notifyPause(true, pauseMs);
  resumed = await interruptibleWait(pauseMs, token);
  finally { notifyPause(false, pauseMs); }
  didLongPause = true;
}
```

- 命中条件：`pauseEnabled` && `fixedDelay === undefined` && 非系统 tag && 随机数 < 0.1
- 命中后等待 30~75 秒，**独立于 sendDelay 区间**
- 且 L430-433：命中长暂停后 **R/S 常规延迟全置 0**，不再叠加

所以「4~20 配置 + 等待 40~70 秒」只可能由这一支解释（除非 `state` 被别的路径改写）。

### 2.4 纯净模式手动发消息根本不会触发任何延迟

`chat-input.ts` L337-343：

```ts
function sendUserMessageToChat(msg: string): Promise<boolean> {
  cancelInitialPrompt();
  cancelQueuedSends(true);
  return sendToChat(msg, 'harness', 0);   // ← fixedDelay = 0
}
```

`fixedDelay = 0` → L428 `if (fixedDelay !== undefined) hesitationMs = fixedDelay` 直接跳过 L364 的长暂停判定，也跳过 `planSendTiming`。

**结论**：用户手动消息（tag=`harness`）是 0ms 直发；「等待发送 N 秒」只可能来自**工具结果回传**（tag=`JS汇总`，`fixedDelay` 传 undefined，走完整随机延迟 + 长暂停）。

### 2.5 ⭐ 长暂停结束后，UI 会立刻抹掉长暂停的痕迹

这是本次诊断的**关键发现**，也解释了用户"没看到长暂停提示"的困惑。

事件链路：

1. `chat-input.ts` L369 `notifyPause(true, pauseMs)`
2. → `harness-bridge.ts` L202 `report({ type: 'send-pause', active: true, durationMs })`
3. → `harness.html` L4353-4369 `case 'send-pause'`

harness.html 处理逻辑：

```js
case 'send-pause': {
  var wasPauseActive = sendPauseActive;
  sendPauseActive = !!payload.active;
  pauseDurationMs = payload.active ? (payload.durationMs || 0) : 0;   // ← 结束即清零
  if (sendPauseActive) {
    pauseCount++;
    sendStartAt = Date.now();
  } else if (wasPauseActive) {
    sendStartAt = Date.now();     // ← 计时起点重置为 0
  }
  syncPet();
  if (sendTickTimer) {
    renderSendTick();
  } else if (sendPauseActive) {
    startSendTick(0);
  }
  break;
}
```

`chat-input.ts` L372 的 `finally { notifyPause(false, pauseMs); }` 在**长暂停一结束就立刻发出**。

于是：

| 阶段 | 状态栏文案（harness.html L3152-3154） |
|---|---|
| 长暂停进行中 | `随机长暂停中（第 1 次 · 共 63s · 等待 40s）` |
| 长暂停结束瞬间 | `结果待发送（工具 0s · 延迟 0s）` ← **痕迹全丢** |
| 之后 | 正常注入 → 发送确认（≤2500ms）→ 秒数从 0 重新爬 |

**用户如果只看"长暂停结束之后"那一段，必然只看到「等待发送 / 结果待发送」，而且秒数是从 0 重新涨的** —— 前面那 30~75 秒的等待确实发生过，只是 UI 没留痕迹。

### 2.6 "结果待发送"态反证 `send-pause` 事件到达过

`startSendTick()` 在 harness.html 里的**唯一调用点**是 L4367（`case 'send-pause'` 的 `else if (sendPauseActive)` 分支）。

也就是说：**只要用户看到「结果待发送（工具 Xs · 延迟 Ys）」，就反证 `send-pause` 事件到达过页面**。而该事件只能由 `notifyPause` 触发（chat-input.ts L369/372）。既然到过，长暂停就不是"没触发"。

（注：`sendStartAt` 在 L4359 / L4361 / L3179 三处被赋 `Date.now()`，也可由 `startSendTick` 直接写入。但 `startSendTick` 本身只能由 `send-pause` 分支调起，所以逻辑闭环成立。）

### 2.7 其它被计入"延迟 Ns"但不属于 sendDelay 区间的耗时

纯净模式状态栏的「延迟 Ns」由 `startSendTick()` 从**工具结束时刻**起算（L3175-3187），期间包含：

1. **附件通道上传**：>4000 字符走 `sendAsFile`（chat-input.ts L383-420），网络耗时未计
2. **发送确认观察窗**：`sendAndConfirm()` L479-512 最多 2500ms（L488）
3. **串行链排队**：前一条未走完，后一条整段等待都算进去（`sendChain` L317-330）

这三项都不受 `sendDelayMax` 约束。

---

## 三、待验证的疑点（未实证）

### 疑点 A：长暂停是否真的在这些轮次触发过

**当前状态**：未做真机取证。

**验证方法**（下次复现时）：

1. 起开发版实例：
   ```
   set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& npx electron . --remote-debugging-port=9444
   ```
2. 纯净模式下对 AI 页面按 `F12`（独立 DevTools，见 entry.ts L367-373）
3. 复现"等待超 20s"的那一刻，看控制台是否打出：
   ```
   [Cuckoo Code] 随机长暂停 63s（拟人）...
   ```
   （来源：chat-input.ts L368）

**判定**：

- **有这行** → 长暂停正常触发，属于 **UI 痕迹丢失**（问题 2.5），不是延迟异常。修 UI 即可。
- **没有这行** → 才是真异常，需继续查：
  - AI 页面 `localStorage['cuckoo-send-delay-max']` 实际值
  - `state.sendDelayMax` 是否被 `cuckoo-sync-settings` 广播写回过默认 30
  - `planSendTiming` 是否被绕过（比如 `fixedDelay` 传了非 undefined 值）

### 疑点 B：`sendStartAt` 的秒数是否真的从 0 重新爬

用户描述"秒数超过的时候显示的是等待发送"——按 L4361 逻辑，长暂停结束后 `sendStartAt` 会被重置为 `Date.now()`，秒数应从 0 起算。

若用户看到的是**秒数直接跳到 40+**（而非从 0 起算），说明 L4361 的重置没生效，或 `send-pause(false)` 事件没到达——需另查 `harness-event-report` 通道。

### 疑点 C：是否存在多条并发消息导致计时串台

`sendChain` 串行化（L317-330）保证同一时刻只有一条在跑，但 `startSendTick` 的 `sendStartAt` 是**全局单变量**（L3126），若上一轮 tick 未 `stopSendTick` 就开启新一轮，计时基准可能错位。

**验证**：查 L3185 的自停判据 `(!generating && toolRunningCount <= 0 && !sendPauseActive)` —— 若上一轮工具尚未退出 `toolRunningCount`，旧 tick 可能继续跑，与新 tick 交替覆盖秒数。

---

## 四、建议修复（按优先级）

### P1：保留长暂停的事后痕迹（解决 2.5 的 UI 缺陷）

`harness.html` `case 'send-pause'` 在 `active=false` 时，**不要立刻把 `pauseDurationMs` 清零、也不要立刻重置 `sendStartAt` 到 0**，而是：

- 保留一条「上次随机长暂停 Ns（第 M 次）」的残留文案，若干秒（如 5~8s）后淡出
- 或把本轮长暂停时长累加进「本轮总等待」显示：`结果待发送（工具 Xs · 含长暂停 63s · 延迟 Ys）`

这样用户复盘时就能看到完整的等待构成，不再出现"超时但看不到解释"的困惑。

### P2：发送失败残留不回收（关联另一个已定位缺陷）

`chat-input.ts` `sendAndConfirm()` L479-512 失败后 **AI 页面输入框残留用户全文，无任何回滚**。

且 `cancelPendingSend()` L547-553 只清系统 tag（`isSystemTag(pendingSend.tag)`），而 `SYSTEM_MSG_TAGS`（L279-283）**不含 `'harness'`**，永远清不到用户消息残留。

这是"纯净模式文字跑到原版输入框"的**实证主因**（缺陷 A，与本文档不同的问题，一并记录供后续统一修）。

### P3：发送前检测 AI 页面是否在生成

`sendAndConfirm` 在 AI 正在生成时必然超时失败（发送按钮不可点）。可在 `doSendToChat` 填充前先检查生成状态，忙则等空闲，从源头避免"填了发不出 → 残留"。

---

## 五、涉及文件索引

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `src/overlay/chat-input.ts` | L59-91 | `randomDelay()`，严格 clamp |
| `src/overlay/chat-input.ts` | L102-108 | `planSendTiming()`，R/S 拆分 |
| `src/overlay/chat-input.ts` | L337-343 | `sendUserMessageToChat`，fixedDelay=0 |
| `src/overlay/chat-input.ts` | L364-378 | 随机长暂停判定与等待 |
| `src/overlay/chat-input.ts` | L430-433 | 长暂停后跳过 R/S |
| `src/overlay/chat-input.ts` | L479-512 | `sendAndConfirm`，失败无回滚 |
| `src/overlay/chat-input.ts` | L547-553 | `cancelPendingSend`，清不到 harness tag |
| `src/overlay/chat-input.ts` | L279-283 | `SYSTEM_MSG_TAGS`，不含 harness |
| `src/overlay/state.ts` | L22-36 | 发送延迟与长暂停默认值 |
| `src/app/global-settings.ts` | L66-97 | 主进程默认值（唯一真相源） |
| `src/bridge/harness-bridge.ts` | L202 | `onSendPause` → `send-pause` 上报 |
| `src/ui/harness.html` | L3122-3194 | `renderSendTick` / `startSendTick` |
| `src/ui/harness.html` | L4353-4369 | `case 'send-pause'` 事件处理 |

---

## 六、信心评分

| 结论 | 信心 | 依据 |
|---|---|---|
| 配置 4~20 已生效 | 10/10 | 直接读 agent-settings.json |
| `randomDelay` 严格 clamp | 10/10 | 代码 L78 `Math.max(min, Math.min(max, target))` |
| 唯一超上限来源是长暂停 | 9/10 | 除长暂停外无其它路径能突破 max；附件/确认窗/排队是"额外时长"但状态栏起算点已包含 |
| 长暂停结束后 UI 痕迹丢失 | 9/10 | L4356 清零 + L4361 重置 + L372 finally 立即通知，路径完整 |
| 用户超时轮次是否真触发了长暂停 | **5/10（未实证）** | 需真机抓 `[Cuckoo Code] 随机长暂停` 日志确认 |
| `send-pause` 事件必到（反证） | 8/10 | `startSendTick` 唯一调用点在 send-pause 分支 |
