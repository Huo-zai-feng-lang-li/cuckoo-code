# 只读对抗性代码审计报告：纯净模式投递 / 焦点隔离 / 附件单发

- 仓库：`D:\Desktop\Super-File\cuckoo-code`
- 分支：`feat/126-volcengine-web-integration`
- 被审提交：`24a16be`（v0.10.231，父提交 `fded1b1`）
- 审计性质：只读对抗性审计。未修改任何代码、未提交、未格式化、未改测试、未做变异测试。
- 审计范围：该提交 diff 及其直接调用链（`src/overlay/chat-input.ts`、`src/app/ipc/renderer.ts`、`src/app/ipc/harness.ts`、`src/app/ipc/cdp-attach.ts`、`src/session/project-context.ts`、`src/ui/harness.html`、`test/overlay/chat-input.test.js`，以及 `src/bridge/api.ts`、`src/bridge/harness-bridge.ts`、`src/app/ipc/send-as-file.ts`、`src/providers/{chatgpt,deepseek}.ts`、`src/app/window.ts` 等直接相关方）。

## 0. 审计口径与基线

**行号基准**：报告内所有 `文件:行号` 均为 **`24a16be` 提交快照行号**（审计时已用 `git show 24a16be:<path>` 导出快照到会话工作目录 `.sessions/38455864490302978/audit-parts/snapshot/` 逐行核对）。

**工作区漂移**（重要，影响复核方式）：审计期间工作区相对 `24a16be` 出现了不属于本提交的未提交改动 —— `src/app/ipc/harness.ts`、`src/overlay/chat-input.ts`、`src/app/ipc/cdp-attach.ts`、`src/providers/deepseek.ts`、`src/providers/generated/hook-sources.ts`、`src/tools/api.d.ts`、`src/tools/runtime/bootstrap.generated.ts`、`.agents/plan-纯净模式投递焦点附件修复.md`。前四处正好改了本次被审函数（停止定位宽限轮询、长度校验归一化、附件就绪宽限、图片就绪判据）。**这些改动不是审计对象，本报告对其不作任何结论**；按当前工作区行号去读本报告会偏移，请以 `git show 24a16be:<file>` 为准。

**在途改动与 P1-2 的关系（只陈述事实，不下结论）**：审计收尾时工作区新增的 `cdp-attach.ts` 改动，注释里记录了真机现象「注入后 20ms 判就绪 → 立即清理临时目录 → 页面报 Upload failed」，其修复是「临时文件延迟 120s 清理 + `image-uploading` 最多再等 5s」。这印证了「就绪信号可能瞬时为真」的机制，但该改动**没有触碰标记唯一性、也没有触碰 `consumed` 的判定方式**，因此本报告 P1-2 的根因项仍然成立，不能由这处在途改动视作已修复。

**门禁基线**（调用方已跑，本次未重复）：`typecheck` 0 错；`npm test` 151 文件 1538 用例全绿；`lint` 0 error / 73 warning（历史基线）；`compile` 通过。本次另实跑 `npx vitest run test/overlay/chat-input.test.js` → 46 用例全绿。

**分级定义**：P0 = 阻断/数据损坏；P1 = 确定的功能缺陷或明显竞态；P2 = 边界/性能/文档缺口。

**结论计数**：P0 = 0；P1 = 3；P2 = 8；需真机判定 = 8；已复核无问题 = 14。

---

## 一、确认的问题

### P1-1 · 输入框始终不出现时，10s 冷等待被 8 次重试重复消耗，兜底总耗时上界 ≈ 83.5s

- **位置**：`src/overlay/chat-input.ts:398-407`、`845`、`851-866`
- **触发路径**：
  1. 新初始化 → `waitForInitialPromptAndSend()`(870) → `trySendInitialPrompt(0)`(851) → `sendInitialPromptToInput()` → `doSendToChat`(385)。
  2. `findInputArea()` 为 null；`coldInitWait = tag==='系统提示词' && !initialPromptColdWaitUsed`(398)，flag 仍为 false → `waitMs = 10000`(399)。
  3. `waitForInputArea(token, 10000)` 超时返回 null → 401-405 `return false`。
  4. **`initialPromptColdWaitUsed = true` 写在 407 行，位于「未找到输入框 → 提前 return」之后**，该路径不可达，flag 保持 false。
  5. 500ms 后重试(866)，下一轮仍判 `coldInitWait=true` → 再吃满 10s。
- **耗时算式（代码实数）**：`INITIAL_PROMPT_MAX_ATTEMPTS = 8`(845)，重试间隔 500ms × 7 次；系统提示词固定延迟传 0。
  上界 = `8 × 10000 + 7 × 500 = 83500ms`，另有 100ms 轮询粒度余量（≤800ms）。
- **为什么是问题**：406 行注释承诺「冷启动长等待只用一次：输入框已出现，后续重试无需再等 10s」，但该语义只在**成功找到输入框**时兑现；失败路径上每轮重走 10s。而投递挂在 `sendChain` 串行链上（`chat-input.ts:315、360-368`），这 ~83.5s 内用户消息、工具回传、看门狗全部排队。对照父提交（30 次 × 0ms 等待，失败快），**这条失败路径的兜底时间是本次改动引入的退步**，尽管它把「成功路径」修对了。
- **建议改法**：把 flag 提前到第一次 10s 等待**开始时**置真（或按 attempt 递减：10000 → 1500），使「只用一次」在失败路径上也成立；并考虑把重试上限与总时长的关系写进注释。

### P1-2 · 附件标记 `data-cuckoo-attach-input` 残留 + 选择器只取首个 + 与 provider「定位注入目标」语义同名，可让「附件还没挂上」被判成就绪

- **位置**：
  - 打标记（本提交新增）：`src/app/ipc/cdp-attach.ts:231-241`（给「当前带文件的 input」打属性）
  - 就绪判定（本提交新增）：`cdp-attach.ts:153-159`（`document.querySelector('input[data-cuckoo-attach-input]')`，`files.length===0` 即 `consumed=true`）
  - 同属性既有的**另一套语义**：`cdp-attach.ts:278`（注释：provider 会给命中的 input 打该标记以「避免选错元素」）、`286`、`301`、`314`（`cdp-direct` 路径用它 `querySelector` 定位**本次要注入的节点**）
  - 清理情况：`genericAttachProbe`(`cdp-attach.ts:361-405`) 与 chooser 流程均不清理；全仓仅 `src/providers/deepseek.ts:220-222` 在自己的探测里 `removeAttribute`。
- **触发路径与结论（写死）**：
  1. 第一次上传走 chooser：`setFileInputFiles` 成功 → 237 行给带文件的 input 打标记；站点读走文件后清空 `files`，**属性永久残留**。
  2. 第二次及以后上传：站点选择后重建 file input 是常见做法（允许重复选同一文件），旧标记 input 仍在 DOM 且为空 → `waitComposerReady` 首轮 400ms 轮询即判 `consumed=true` → `ready=true`(159)。
  3. 页面存在多个 file input 时 `querySelector` 只返回文档序第一个：**旧的空标记会遮蔽本次真正注入的新 input**。
  4. 反方向也会坏：若站点在 `executeJavaScript` 打标记之前就已清空 `files`（同一事件循环内），标记打不上 → 通用信号永不生效，等于白加一条判据。
  5. 语义冲突：`cdp-direct` 路径(`286/301/314`)把该属性当「provider 指定的目标节点」。新代码把「带过文件的所有 input」都打上同名标记后，该路径的 `querySelector` 可能命中与 provider 意图不同的元素 → 注入到错误 input，`change` 事件也派发到错误元素。
- **后果链路**：`cdpAttach` 返回 `success:true`(246/324)，或返回 `{success:false, injected:true}` → `harness.ts:606-614` 记 `success:true, injected:true` 并 `continue`，**跳过兜底注入** → `harness.ts:633` 计入 `uploaded` → `harness.html:5212` 判成功 → `5225` 延迟 1.5s 直接发消息。**结果：消息发出但不带附件，且不会再补传，界面显示「上传成功」。**
- **影响边界**：仅走内置 `consumed` 信号的 provider 受影响；DeepSeek 有自己的文件名精确判据，受影响小。
- **建议改法**（择一即可，优先第 1 条）：
  1. 换独立属性名（如 `data-cuckoo-attach-consumed`）承载就绪信号，**不与 provider 的定位标记共用命名空间**；
  2. 注入前先用 `DOM.setAttributeValue` 按 `backendNodeId` 精确标记**本次节点**并清掉其他旧标记，就绪判定只查该节点（`Runtime.evaluate` 拿 `objectId`→`DOM.requestNode` 已有现成链路，`cdp-attach.ts:285-294` 可直接复用）；
  3. 退一步：注入前遍历清空全部 `data-cuckoo-attach-input`，并让 `consumed` 只认「本次 attach 周期内新打」的标记。

### P1-3 · attachFn 幂等守卫用「祖先 innerText 子串命中」判定重复，存在假阳：静默漏传且回报成功

- **位置**：`src/app/ipc/harness.ts:89-99`（判断），`98`（假阳直接 `return { success:true, deduped:true }`）
- **触发路径**：`input` 自身是 `INPUT` → 被 `editable` 跳过；随后沿父链上溯最多 12 层，对每个**非可编辑**祖先取 `innerText` 做 `indexOf(fileName)`。祖先的 `innerText` 会包含其子树内**可编辑元素**的文本，以及已渲染的历史消息文本。
- **为什么是问题**：只要文件名出现在该 12 层范围内的页面文本里（例如同一会话前一轮消息已发出并渲染了该文件名，这正是「上次静默丢附件 → 重试」的典型场景），守卫即判 `dup`，**不注入、直接报成功**；附件根本没挂上，调用方却按成功继续。守卫的注释只防了「用户正文里提到该文件名」，没防住祖先容器把正文/历史文本一起卷进来这一层。
- **补充点**：`fileName` 为空串时 `indexOf('') === 0`，恒判重复（当前调用方总会带名字，属健壮性缺口）。
- **建议改法**：把匹配范围收窄到「附件区」容器（provider 已有的 chip/文件列表判据），或先读 `textContent` 且**排除所有可编辑子树**再做匹配；命中时不要直接报 `success:true`，改为「跳过注入但标记 `deduped`，由调用方决定是否发送」，并在 `fileName` 为空时跳过守卫。

---

### P2 级

**P2-1 · `send-as-file` 通道没跟上 `injected` 语义，已注入未确认时会「附件 + 全文」双份**
位置：`cdp-attach.ts:246、324`（产出 `{success:false, injected:true}`）；`src/app/ipc/send-as-file.ts:52-53`（只透传 `success/error`）；`chat-input.ts:455-465`（`r.success` 假 → 回退把全文敲进输入框）。
为什么是问题：`injected` 语义只接到了 `harness-attach`(`harness.ts:606`)，同结构读取方漏接；回退后页面里附件 chip 仍在，形成双份内容。
当前影响有限：`shouldAttach()` 恒 false(`chat-input.ts:52-54`)，该通道处于休眠，故定 P2。
建议：`send-as-file` 同样读 `injected`；确需回退时先清输入区已挂附件。

**P2-2 · 附件超时 `Promise.race` 落败方仍在主进程继续跑**
位置：`src/ui/harness.html:5207-5211`；`harness.ts:597-633`（文件顺序 `await` 循环）；`cdp-attach.ts:347-353`（finally 清理）。
为什么是问题：UI 超时后报失败并清状态，主进程 handler 仍在逐个注入剩余文件、仍持有 debugger 与临时文件，结果无人消费；用户据此重试 → 可能双份。超时上限放大到 `20000 + 18000*N` 后单次在途时间更长，这个窗口也更长。
建议：超时下发取消信号（AbortController / 令牌）中断在途 `cdpAttach`，或落败方完成后回写结果供 UI 对账。

**P2-3 · 幂等守卫上溯 12 层逐层读 `innerText`，每层强制同步布局**
位置：`harness.ts:91-99`（`up.innerText` 在 95 行循环内）。
说明：单次附件一次性开销，非热路径，属性能观察项。
建议：先 `textContent`（不触发 reflow）匹配，未命中再回退 `innerText`。

**P2-4 · 文档过度承诺：停止生成后并未「把焦点还给 harness」**
位置：`.agents/plan-纯净模式投递焦点附件修复.md:33`；对照 `harness.ts:313-314`（纯净模式仅「不 `wc.focus()`」）、`project-context.ts:144-148`（主动归还只存在于选目录路径）。
建议：plan 改为「纯净模式下不主动聚焦 AI 视图（不抢焦点）」；若产品要求停止后拉回 harness，再在 `stopGeneration` 纯净分支补 `hv.webContents.focus()`。

**P2-5 · 文档遗漏：系统提示词重试的 1.5s 就绪窗口没写**
位置：`chat-input.ts:399`（`coldInitWait ? 10000 : (系统提示词 ? 1500 : 0)`）；文档侧 `plan:24`、`changelogs/2026-11.md:10`、`CHANGELOG.md:22`、`handoff.md:29` 均只写「10 秒冷启动窗口」。
建议：文档补一句「系统提示词重试轮询窗口 1.5s，其余框架消息 0ms」。

**P2-6 · plan 自审措辞不严谨，可能误导后人删掉编码**
位置：`.agents/plan-纯净模式投递焦点附件修复.md:78` 写「无文件名/用户内容拼进 JS」；实际 `harness.ts:620-623`、`cdp-attach.ts:102、169` **确实拼入了** `f.name/f.mime/f.data`，只是先经 `JSON.stringify` 编码成字符串字面量。
为什么是问题：结论（安全）成立但表述错误；按字面理解可能把 `JSON.stringify` 改成裸拼接，打开脚本注入面。
建议：改为「外部内容一律经 `JSON.stringify` 编码为字符串字面量后再拼接；脚本函数体来自本地内置函数或 provider 源码，不取自页面」。

**P2-7 · handoff 状态滞后：代码已入库仍标「待提交」**
位置：`.agents/handoff.md:4`（称与 master 同 commit `fded1b1`）、`:13`（「🟡 代码完成，待真机验 + 提交」）；事实是 HEAD = `24a16be`，`fded1b1` 是父提交。
建议：改为「代码已提交 24a16be，待真机验 + 发版；基线 fded1b1，HEAD 24a16be」。

**P2-8 · 新增用例 3 只守护原生注入通道，挡不住 DOM 通道二次回填**
位置：`test/overlay/chat-input.test.js:707-724`；对照 `chat-input.ts:506-508`。
说明：`alreadyFilled` 被绕过而改走 DOM 填充时，`nativeCalls` 仍为空，`deepStrictEqual(nativeCalls, [])` 照样通过；守卫本意是「不重复灌注长提示词」，DOM 回填同样是重复灌注。
建议：补一条断言（记录 DOM setter 调用次数，或断言发送前后输入框值未被覆写）；至少把用例注释写清「只守护原生通道」。

---

## 二、需要真机才能判定的猜测（静态推理不能定论）

**T-1 · `isHarnessActive` fail-open：上下文查不到时判不出纯净模式，会落回旧的抢焦点路径**
`renderer.ts:36-43`，调用点 `117`（chat-send-enter）、`136`（chat-insert-text）。三条分支（抛错 / `ctx` 为 null / `ctx.win` 缺失或已销毁）一律 `return false` → 继续 `sendInputEvent` 或 `sender.focus()+insertText`，即本提交要消灭的「打字串台」。
存疑点：`getContextByWebContents`（`src/app/window.ts:108-115`）遍历注册表匹配 view/harnessView/win，AI view 的 sender 应当能命中，且 `assertSenderOk` 已前置拦截非注册 sender（`112、131`）；多窗口 / 子代理 / 懒加载下是否真会 lookup miss，需真机复测。
建议（确认后）：纯净判定缺失时 fail-closed，或 lookup miss 时打一条日志便于归因。

**T-2 · 无键盘焦点时 contenteditable 的 `execCommand('delete')` 是否真的删得掉**
`chat-input.ts:240-255`。无焦点分支手动建 `Range`(`249`) 后无条件 `execCommand('delete')`(`255`)；Blink 在 document 未获焦点时该 selection 是否保持、delete 是否仍作用于该 range，代码层无法定论。若 selection 被清 → 旧内容残留 → 后续分段 paste(`295-310`) 只追加不覆盖 → 新旧文本混杂。
验证方法：纯净模式向 contenteditable 站点灌系统提示词，读回输入框文本核对。新增 3 条用例只覆盖 textarea，未覆盖该分支。

**T-3 · ChatGPT provider 在页面内自行 `input.focus()`，绕过了本次的主进程隔离**
`src/providers/chatgpt.ts:102-103`（`triggerSend` 先 `input.focus()`），`107` 在 `sendEnterToChat` 返回 false 后回退 `findSendButton().click()`（`112-113`）。`renderer.ts:136` 只挡主进程 `sender.focus()`，挡不住页面元素 `focus()`。是否命中取决于 ChatGPT provider 是否启用，需真机确认。

**T-4 · `document.hasFocus` 缺失时 `pageFocused` 默认 true**
`chat-input.ts:178`。Electron/Chromium 下该 Web API 必然存在，属纯防御兜底；若真缺失会退化回 IME 注入 + `input.focus()`（`181、226、241`）。概率极低，仅记录。

**T-5 · `consumed` 信号在真实站点的误判/漏判率**
`cdp-attach.ts:153-159` + `231-241`。上面 P1-2 已确认逻辑缺陷；真实站点「清空 files 的时机」「是否重建 file input」决定实际命中率，需在 volcengine / DeepSeek 纯文本文件卡片链路上实测统计。

**T-6 · `attachFn`「change 派发即成功」的静默丢弃概率**
`harness.ts:105-109`（`submitted=true` 即 return success）。这是任务已认可的取舍，不作为遗漏；丢弃概率需真机统计。

**T-7 · 文件名校验未覆盖全部 C0 控制字符**
`cdp-attach.ts:72` 的正则 `/[<>:"/\\|?*\x00]/` 未排除 `\n \r \t`。该名字经 `JSON.stringify` 进页内脚本是安全的，但会作为临时文件名落盘并传给 `DOM.setFileInputFiles`(`228、307`)；含换行的名字在个别文件系统/站点上的行为需真机验证。建议收紧为白名单或排除全部 C0。

**T-8 · 停止后焦点是否真的留在 harness**
`harness.ts:313-314` 纯净分支既不抢也不主动归还；焦点能否留在 harness 输入框取决于 Chromium 对离屏 webContents 的焦点行为。需真机验证「点停止后继续打字不串台」，这也是 P2-4 文档口径要修的原因。

---

## 三、已复核无问题的项

**N-1 · `AttachResult` 加可选 `injected` 不破坏契约**
读取方全部清点：`harness.ts:601-615`（读 `success/injected/error`，`injected===undefined` 走原有兜底）、`send-as-file.ts:52-53`（只读 `success/error`，类型兼容）、`chat-input.ts:455-457`（`r.success/r.error`）、`cdp-attach.ts` 内部 `35-47`/`218-219`。字段可选，旧调用方不读即无影响。

**N-2 · `onFrameworkSend` 新参数只有 2 个调用点，分支正确**
`harness.html:4589`（`framework-send`，`preparing=undefined` → 「已发送，等待 AI 响应…」，无气泡时补占位）、`4590`（`framework-preparing`，`true` → 「正在准备…」，`!cur && !preparing` 不建空气泡）。生产方：`harness-bridge.ts:202`（`onMessageDelivered` 回执 → framework-send）、`project-context.ts:256-258`（下发即 preparing）。语义闭环：准备态 ≠ 已发送。

**N-3 · `initialPromptColdWaitUsed` 无并发竞态**
复位点 `chat-input.ts:820-826`（`epoch++`、`initialPromptRun=null`、flag=false）；新初始化先 `cancelPendingSend` → `cancelInitialPrompt`(607) → 再 `waitForInitialPromptAndSend`；`initialPromptRun` 单飞去重(829)，旧 run 按 epoch 失效(835)，`finally` 仅当 `initialPromptRun===run` 才清(838-840)。跨初始化交接闭环成立。P1-1 是失败重试路径的逻辑缺陷，不是竞态。

**N-4 · 附件计数与提示口径未被结构变化破坏**
`harness.ts:633、635` 用 `results.filter(x=>x.success).length` 计 `uploaded`；`injected` 条目以 `success:true` 计入（既定取舍）。`harness.html:5212` 只读 `uploaded`，成功路径不读明细，字段名未变。

**N-5 · 四档等待窗口对串行链的阻塞属设计内**
`chat-input.ts:399`：harness 4000 / 冷启动 10000 / 系统提示词重试 1500 / 其余 0ms。0ms 不阻塞，其余仍在 `sendChain` 内 `await`，沿用既有串行语义；问题只在 P1-1 的重复消耗。

**N-6 · `stopGeneration` 的守卫完整**
`harness.ts:292`（view 已销毁直接返回失败）、`313-314`（纯净模式不 `wc.focus()`）、`393-407`（纯净模式走页面内合成 KeyboardEvent，否则 `sendInputEvent`）；`ctx.win` 缺失会退旧路径，与 T-1 同类 lookup 依赖，未单列为问题。

**N-7 · 选目录后焦点归还分支完整**
`project-context.ts:141-150`：`mainWindow.focus()` 后，`__ckHarnessVisible && harnessView` 存活 → `hv.webContents.focus()`(146)；否则 view 存活 → `view.webContents.focus()`(148)。两分支都查了 `isDestroyed()`。

**N-8 · 附件与发送的页面侧顺序闭环**
`harness.html:5202-5226`：先 `api.attach`，`uploaded>0` 后延迟 1500ms 才 `api.sendMessage`；主进程 `harness-attach` 内文件顺序 `await`(`harness.ts:597-633`)，同一次调用内无并行注入。

**N-9 · IPC 返回 false 后页面侧回退必然可达（逐跳核实）**
- `chat-insert-text`：`bridge/api.ts:53-55` → 唯一调用方 `chat-input.ts:206`；false → `208 nativeOk=false; break` → 跳过长度校验(210) → 落 DOM 填充（textarea 224-237 / contenteditable 239-275），中途无 early return；且 `181` 的 `pageFocused` 前置门在纯净模式下根本不进 IPC。
- `chat-send-enter`：调用方 A `chat-input.ts:1042-1048` → false → step4 合成 KeyboardEvent(1054-1060)；调用方 B `deepseek.ts:142-156`；调用方 C `chatgpt.ts:106-113` → 无按钮返回 false → 回到 `chat-input.ts:975-991` → `fallbackSend`(994) 再走调用方 A。三条都可达。
- `simulate-mouse`：`chat-input.ts:1020-1023` → false → DOM `btn.click()`(1032)。

**N-10 · 测试没有被弱化；用例 1、3 是真回归探针，用例 2 是护栏**
全文件无 `skip/only/todo`、无删断言、无放宽阈值、无硬编码结果（`test/overlay/chat-input.test.js`）。
- 用例 1（`678-690`）在父提交上会红：老 `setInputContent` 无 `hasFocus` 判断，`insertTextToChat` 存在即进原生通道 → 先 `input.focus()`（`__focus=1`，断言 `undefined` 红）→ 调 `insertTextToChat`（`nativeCalls` 非空，`deepStrictEqual([])` 红）。
- 用例 3（`707-724`）在父提交上会红：无 `alreadyFilled` 守卫 → 直接 `setInputContent` → 原生通道被调用 → `nativeCalls` 非空，断言红。
- 用例 2（`692-705`）**在新老代码上都通过**，它是护栏（防「有焦点也改走 DOM」的反向退化），不是回归探针，不应算作第 3 条「能变红」的用例。
- 全局污染已被兜住：`setupGlobals()` 每例重建 `window`/`document`(`25-45`)，`resetModules` 重取 `state.js`(52-57)，`vitest.config.mjs` 用 `pool:'forks'` 做文件级隔离；新用例在文件末尾，其后无同文件用例。残留注意：没有显式 teardown，属脆弱点而非缺陷。

**N-11 · 注入脚本拼接安全（恶意文件名无法逃逸）**
外部内容一律 `JSON.stringify` 后拼接（`harness.ts:620-623`、`cdp-attach.ts:102、169`）；静态脚本为纯常量（`cdp-attach.ts:234-240`、`harness.ts:395-402`）；点击坐标先判 `typeof r.x === 'number'`(`harness.ts:339`) 再取整直拼。示例：文件名 `x");alert(1);//.txt` 经 `JSON.stringify` 变 `"x\");alert(1);//.txt"`，字符串字面量不被打断。**结论安全**，但 P2-6 的文档表述要改。

**N-12 · 注入脚本不读敏感存储**
探针/就绪/诊断只读 DOM（坐标、类名、`aria-label`/`title`、输入框文本 40 字符切片 `cdp-attach.ts:195`）；未触碰 `document.cookie`/`localStorage`/`sessionStorage`/请求头。回传值仅坐标、候选标签、`ready`、切片文本。

**N-13 · 版本号与 changelog 一致，无历史丢失**
`package.json:4` = `0.10.231`；`CHANGELOG.md:11,18`；`changelogs/2026-11.md:3,6`；commit message 同版本。索引 26 条与月度文件 26 条 `## [0.10.` 对齐；从主文件移出的 0.10.225 / 0.10.222 仍在月度文件（`80、127`）。两条 0.10.231 条目只写用户可感知变更。

**N-14 · plan 的未提交改动已单独标注**
`git diff` 证实工作区相对 `24a16be` 仅给 `.agents/plan-纯净模式投递焦点附件修复.md` 追加「自审记录」一段（`73-82`），**尚未入库**。本报告按工作区内容读它，引用时已注明该状态。

---

## 四、验收 checklist 逐条对照

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 测试是否被弱化；新增 3 条能否变红 | 未弱化。用例 1、3 在父提交上会红；用例 2 不会红，是护栏 | N-10、P2-8 |
| 2 | 改动最小化 / 副作用 / 契约破坏 | `AttachResult` 向后兼容；`onFrameworkSend` 两调用点分支正确；IPC 返回值语义变化有逐跳回退；`send-as-file` 语义漏接一处（休眠通道） | N-1、N-2、N-9、P2-1 |
| 3 | 边界与异常路径 | `ctx.win` 缺失/视图销毁均有守卫；`hasFocus` 缺失为防御兜底；contenteditable 无焦点删除存疑；已注入未就绪的落点即 P1-2；部分成功计入口径不变 | N-6、N-7、T-1、T-2、T-4、P1-2、N-4 |
| 4 | 并发与竞态 | `initialPromptColdWaitUsed` 跨初始化交接闭环，无竞态；两次初始化叠加被 `initialPromptRun` + epoch 挡住；附件与发送顺序闭环；IPC false 回退三条链路均可达 | N-3、N-8、N-9、P1-1 |
| 5 | 安全 | 拼接内容一律 `JSON.stringify`，恶意文件名不可逃逸；脚本不读 cookie/存储；回传值仅坐标与切片文本 | N-11、N-12、P2-6 |
| 6 | 命名/注释/JSDoc/文档一致 | 命名与注释基本贴合实现；plan 有 1 处过度承诺、1 处漏写参数、1 处安全措辞错误；handoff 状态滞后；版本号与 changelog 一致 | P2-4、P2-5、P2-6、P2-7、N-13、N-14 |
| 7 | 性能退化点 | 10s 冷等待在失败路径被重复消耗（83.5s 上界，属退步）；窗口本身不新增阻塞；守卫 12 层 `innerText` 有 reflow 成本；附件超时放大加长在途窗口 | P1-1、N-5、P2-3、P2-2 |

---

## 五、总评

这个提交**可以合入**：三个真机现象（初始投递空转、打字串台、附件双份）在正常路径上都修到了根因——冷启动窗口 + 幂等跳过、`hasFocus` 门控 + 主进程不抢焦点、`injected` 契约 + 标记就绪信号；契约改动向后兼容，门禁全绿，测试没有被弱化（用例 1、3 是真探针）。

但**不建议直接发版**，建议同批带上三处小修：P1-1 把 `initialPromptColdWaitUsed` 提到「开始等待」时置真（一处一行，消灭 83.5s 兜底，同时不破坏「成功路径只用一次」的初衷）；P1-2 给就绪信号换独立属性名或按 `backendNodeId` 精确标记本次节点（复用现成的 `Runtime.evaluate → DOM.requestNode` 链路，成本很低），否则「附件已注入即成功」会在第二次及以后的附件上传上从「极小概率静默丢弃」放大成「结构性漏判并报成功」；P1-3 把幂等守卫的匹配范围收窄到附件区，避免文件名出现在页面文本里就静默漏传。

**剩余风险集中在失败路径和附件就绪判定**，正常路径无 P0 级问题。发版前还需要三处真机复核：纯净模式下 contenteditable 的旧内容能否真正清空（T-2）、`isHarnessActive` 在懒加载/多窗口下是否会 lookup miss（T-1）、ChatGPT provider 页面内 `input.focus()` 是否仍会抢焦点（T-3）。文档侧同步改 `handoff` 状态、补 1.5s 重试窗口、纠正 plan 的安全措辞，避免下一轮维护者按错误前提改代码。

（另注：审计期间工作区有 7 处非本提交的未提交改动，其中 3 处正在改本次被审函数；本报告结论只对 `24a16be` 负责，复核时请以 `git show 24a16be:<file>` 为准。）
