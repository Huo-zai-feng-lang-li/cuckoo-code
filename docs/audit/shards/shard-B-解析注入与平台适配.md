# Shard B 审计报告：解析注入与平台适配层

- 审计人：Shard B 审计员（只读）
- 日期：2026-10-17
- 项目：cuckoo-code v0.9.24（Electron 44）
- 范围：src/bridge 13 个 + src/providers 12 个 = 25 个 TS 文件
- 审计方式：逐文件通读 + 可运行 PoC（vitest）实证关键解析边界；hook 主世界逻辑无单测环境，部分结论为静态推演并已标注

---

## 一、已审文件清单（25/25，无遗漏）

### src/bridge（13）
| # | 文件 | 行数 |
|---|---|---|
| 1 | src/bridge/api.ts | 257 |
| 2 | src/bridge/entry.ts | 298 |
| 3 | src/bridge/harness-bridge.ts | 164 |
| 4 | src/bridge/intercept/observer.ts | 394 |
| 5 | src/bridge/loop/executor.ts | 80 |
| 6 | src/bridge/loop/retry.ts | 229 |
| 7 | src/bridge/loop/watchdog.ts | 119 |
| 8 | src/bridge/parser/js-detector.ts | 102 |
| 9 | src/bridge/parser/json-detector.ts | 18 |
| 10 | src/bridge/plugin-system.ts | 327 |
| 11 | src/bridge/probe.ts | 44 |
| 12 | src/bridge/remote-bridge.ts | 163 |
| 13 | src/bridge/subagent.ts | 125 |

### src/providers（12）
| # | 文件 | 行数 |
|---|---|---|
| 14 | src/providers/deepseek.ts | 99 |
| 15 | src/providers/chatgpt.ts | 158 |
| 16 | src/providers/claude.ts | 75 |
| 17 | src/providers/registry.ts | 35 |
| 18 | src/providers/validate.ts | 23 |
| 19 | src/providers/types.ts | 97 |
| 20 | src/providers/custom/loader.ts | 247 |
| 21 | src/providers/hooks/deepseek.ts | 605 |
| 22 | src/providers/hooks/chatgpt.ts | 564 |
| 23 | src/providers/hooks/claude.ts | 193 |
| 24 | src/providers/hooks/shared/sse.ts | 51 |
| 25 | src/providers/generated/hook-sources.ts | 5（生成物，三平台 hook 源码内联，与 21-23 同源） |

合计约 4336 行，全部逐行通读。清单外本片无其他同属文件（src/providers/hooks/ 下仅 deepseek/chatgpt/claude/shared 四个入口，已全覆盖）。

---

## 二、确认 Bug 条目（按级别排序）

### P0（必现崩溃 / 远程网页内容直达任意执行 / XSS）
**无。** 本片未发现 P0。
- bridge 层 DOM 写入全部用 `textContent`（executor.ts:16,45,53,77），retry.ts:139-143 的 innerHTML 为静态字符串无外部数据，无页面 XSS。
- AI 输出 → executeJs 是产品设计本身（信任 AI 回复），非越界。
- 未发现主链路必现崩溃。

---

### P1（高频功能错误 / 竞态 / 监听器泄漏 / 看门狗或重试失效）

#### B-001｜P1｜并发竞态（跨会话污染）
- **位置**：src/bridge/loop/retry.ts:191-201（`setTimeout` 回调）对照 watchdog.ts:53-62 的"发送前会话复核"。
- **原文**：
  ```js
  const timer = setTimeout(() => {
    ...
    sendToChat(cfg.prompt, is429 ? '重试(操作频繁)' : '重试', undefined);
  }, delay);
  ```
- **功能**：AI 请求失败后，延迟 4~10s（429 时 120s）自动把"刚才的回复似乎中断了，请重新完整回答上一个问题"发到当前输入框。
- **触发链路**：会话 A 流失败 → handleError 在 A 会话校验通过（retry.ts:153-159）→ 倒计时进行中用户切到会话 B（DeepSeek SPA 无刷新导航）→ 倒计时结束时**不复核当前会话**直接 `sendToChat` → 重试提示词被打进会话 B 的输入框并发出。
- **影响**：旧会话的失败重试消息污染新会话对话；新会话 AI 会被这句没头没尾的"重新回答上一个问题"误导。注意 watchdog.ts 的 onStreamIdle 在发送前**有**会话复核（watchdog.ts:56-62），retry.ts 缺失同样的复核，属不对称遗漏。
- **置信度**：9（代码直读确认；onSuccess 虽会在新会话有回复时 clearPending，但用户切到 B 后不发消息、B 无自动回复时窗口存在）。
- **现有测试**：test/bridge/loop/retry.test.js 覆盖配置/计数/退避，未覆盖"倒计时期间切会话"。
- **修复建议**：timer 回调开头取 `getCurrentSessionId()`，与调度时记录的 sessionId（可在 pending 里存一份）比对，不一致则取消发送；与 watchdog.ts 对齐。

#### B-002｜P1｜错误处理（Claude 流中断被误判为成功，且执行截断代码）
- **位置**：src/providers/hooks/claude.ts:127-129（fetch pump catch）与 claude.ts:195-203（XHR readyState=4 兜底）。
- **原文**：
  ```js
  }).catch(function () {
    if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
  });
  ```
  XHR 分支同样：readyState===4 时不看 xhr.status，直接 `dispatch(extractor.text, true)`。
- **功能**：流网络异常/非预期结束时的终态上报。
- **触发链路**：Claude 生成中途断网/连接被掐 → pump catch → `dispatch(extractor.text, true)` 把**截断的半段正文**当作"finished 成功"派发给隔离世界。对比 DeepSeek（deepseek.ts:391-398）与 ChatGPT（chatgpt.ts:436-448）在同样 catch 里都是 dispatch `'error'`。
- **影响**：
  1. 截断回复被当终态 → observer.processInterceptedResponse 当作"任务完成"，**自动重试引擎收不到 error，不会重试**；上层（压缩/子代理/手机端）以为成功。
  2. 若截断正好落在 ```cuckoo 块中途，js-detector.ts:100 的未闭合 flush 会把残缺代码提取出来执行（PoC-1 实证），随后 executeJsBlocksWithRetry 对同一段残缺代码空跑 3 次（每次隔 1s，见 B-006）。
- **置信度**：8（代码路径明确；实际断网概率中等，故不定 P0）。
- **现有测试**：hook 主世界逻辑无单测（hooks.md 明确"只能真机验证"）。
- **修复建议**：fetch catch 区分 AbortError（stopped）与其他错误（dispatch 'error' + reason:'stream'），对齐 deepseek.ts:391-398；XHR 兜底分支补 xhr.status 判断（status!==2xx 走 error）。

---

### P2（特定条件触发）

#### B-003｜P2｜安全（DeepSeek 完成请求匹配无 host 白名单）
- **位置**：src/providers/hooks/deepseek.ts:31-40（isCompletion）、:20-29（isStopStream）。
- **原文**：
  ```js
  function isCompletion(url, method) {
    ...
    var u = new URL(url, document.baseURI);
    return u.pathname === COMPLETION_PATH;   // 只比 pathname，不看 hostname
  }
  ```
- **对照**：chatgpt.ts:41-45 `isOurHost(u)`（chatgpt.com / chat.openai.com）+ claude.ts:21 `u.hostname.indexOf('claude.ai') === -1` 都有 host 校验；DeepSeek 是三者中唯一缺 host 校验的。
- **触发链路**：页面主世界里任何脚本（第三方 SDK、被投毒脚本、或页面自身 XSS）向 `https://任意域名/api/v0/chat/completion` 发 POST，其响应体会被 observeBody 当作 DeepSeek AI 流式回复解析并派发 `cuckoo-ai-response` → observer 据此提取 ```cuckoo 块并**以 node 权限执行**（executeJs）。
- **影响**：纵深防御缺口——本应用把"AI 回复"直接当可执行指令，host 白名单是防止"非 AI 站点响应被当指令"的最后一道闸。当前需页面内已有脚本执行权才能利用，故不定 P0，但与兄弟平台不一致，属明确缺失。
- **置信度**：7（代码直读确认差异；实际利用需页面内已有脚本执行权）。
- **修复建议**：isCompletion/isStopStream 增加 `u.hostname.indexOf('deepseek.com') === -1 → false`，对齐 ChatGPT/Claude。

#### B-004｜P2｜边界条件（流式截断的未闭合 cuckoo 块被 flush 后执行）
- **位置**：src/bridge/parser/js-detector.ts:100（`if (inBlock) flush()`）。
- **原文**：
  ```js
  for (let i = 0; i < lines.length; i++) { ... }
  if (inBlock) flush();   // 流结束仍未闭合的围栏 → 照样提取
  ```
- **功能**：提取 JS 工具块。
- **触发链路**：AI 回复在 ```cuckoo 块写到一半就结束（服务端截断/断流，且该平台把它判成 finished——见 B-002 Claude 路径）→ flush 把残缺代码（如 `await write({filePath:"x", content:"incomplete`）作为一个块返回 → executor 调 executeJs → 必抛 SyntaxError。
- **影响**：残缺代码被真实执行一次（失败），再触发 B-006 的 3 次空重试，徒增 ~3s 延迟与一条失败工具结果回传 AI。
- **置信度**：9（PoC-1 实证：未闭合块确实被返回）。
- **现有测试**：test/bridge/js-detector.test.js 未覆盖"未闭合围栏在文末"用例。
- **修复建议**：flush 时若块内代码含未闭合括号/引号（或上游 hook 已标 incomplete），不提取直接丢弃；至少在 observer 层对"未闭合块"跳过执行。

#### B-005｜P2｜健壮性（DeepSeek/Claude 的 XHR 观测路径无流静默看门狗）
- **位置**：src/providers/hooks/deepseek.ts:552-600（observeXhr 全程无 idleTimer）；claude.ts:169-205 同。
- **对照**：fetch 路径 observeBody 在 deepseek.ts:346-356 / chatgpt.ts:388-398 都装了 5s 轮询的 cuckoo-stream-idle 看门狗；XHR 路径只有 `readystatechange` 被动消费。
- **触发链路**：若某账号/灰度下 DeepSeek 或 Claude 用 XHR（而非 fetch）发 completion，且流挂起不发数据也不断开 → lastActiveAt 永不刷新但无人检测 → watchdog（bridge/loop/watchdog.ts）永远收不到 cuckoo-stream-idle → 任务静默卡死，无"请继续"催促。
- **影响**：看门狗在 XHR 通道失效。当前线上 DeepSeek/Claude 实测走 fetch，但协议一旦切换即盲。
- **置信度**：7（静态推演：observeXhr 内确无 idleTimer 代码；是否现网走 XHR 未抓包）。
- **修复建议**：把 idleTimer 逻辑抽成 shared，observeXhr 同样挂装；xhr 任何 readystatechange 都刷新 lastActiveAt。

#### B-006｜P2｜错误处理（残缺代码被重复执行 3 次）
- **位置**：src/bridge/intercept/observer.ts:129-144（executeJsBlocksWithRetry）。
- **原文**：
  ```js
  for (let attempt = 0; attempt <= MAX_JS_RETRY; attempt++) {   // MAX_JS_RETRY=3
    results = [];
    for (const code of blocks) { const r = await handleJsToolScript(code); ... }
    const hasIncompleteFailure = results.some(r => ... looksLikeIncompleteCodeError(r.result.error));
    if (!hasIncompleteFailure) break;
    if (attempt < MAX_JS_RETRY) await sleep(1000);
  }
  ```
- **功能**：遇"代码不完整"错误时重试。
- **触发链路**：observer 注释自承"拦截模式下文本已完整（finished），无需重新提取"——既然代码文本不变，重跑同一段必抛同样的 SyntaxError，重试 3 次（每次隔 1s）对语法错误毫无修复作用。
- **影响**：凡遇残缺块（B-004），固定多耗 ~3 秒并向沙箱重复提交同一段非法代码 3 次；偶发执行异常也被误判为"可重试"。
- **置信度**：8（逻辑推演确定）。
- **修复建议**：仅在"提取后文本变化/等待了页面重渲染"等真正可能自愈的条件下重试；对 finished 且 extractJsToolBlocks 已稳定的场景，SyntaxError 直接终态，不重跑。

---

### P3（健壮性 / 兼容性 / 代码质量）

#### B-007｜P3｜数据正确性（通知摘要正则写错，吞掉英文字母 s）
- **位置**：src/bridge/intercept/observer.ts:261。
- **原文**：
  ```js
  const summary = String(raw || '').replace(/s+/g, ' ').trim().slice(0, 120);
  ```
- **分析**：意图应是 `/\s+/g`（折叠空白），实写为 `/s+/g`——匹配**字面字母 s** 并替换为空格。PoC-9 实证：`Successfully saved the project settings now` → `Succe fully aved the project etting now`。
- **影响**：纯中文回复无字母 s，无症状；英文/混排回复的系统通知摘要被篡改（丢 s）。仅影响通知文案，不影响执行。
- **置信度**：10（PoC 实证）。
- **现有测试**：observer.test.js 未覆盖该通知摘要分支（fake window 的 showAiNotification 为空实现）。
- **修复建议**：改为 `/\s+/g`。

#### B-008｜P3｜兼容性（4 反引号围栏不识别为 cuckoo 块）
- **位置**：src/bridge/parser/js-detector.ts:88。
- **原文**：`lang = (trimmed.slice(3) || '').split(' ')[0];`（假定围栏固定 3 个反引号）。
- **分析**：Markdown 允许 ```` ````cuckoo ````（4+ 反引号）包围含三反引号的内容。slice(3) 会把第一个反引号吃进 lang，得 lang='`cuckoo'，与 'cuckoo' 不匹配 → 不执行。PoC-5 实证返回 []。
- **影响**：AI 若用 4 反引号围栏包工具块，会漏执行。当前提示词约定 3 反引号，概率低。
- **置信度**：9（PoC 实证）。
- **修复建议**：围栏识别用 `/^(`{3,})/`，lang = slice(围栏长度)。

#### B-009｜P3｜UX（harness 流式剥离正则误伤普通代码块的收尾围栏）
- **位置**：src/bridge/harness-bridge.ts:46（`out = out.replace(/```[a-z]*\s*$/i, '');`）。
- **分析**：该行本意是隐藏流式未收全的开标记（```cuck 半截）。但流式结束帧带全文时，若回复以一个**普通语言**代码块（如 ```python）收尾，其收尾 ``` 恰好落在行尾，会被该行一并剥掉——开标记与正文保留、收尾围栏丢失，harness 气泡显示异常。
- **影响**：仅纯净模式气泡文案渲染，不影响执行。
- **置信度**：7（静态推演，PoC 未单测 harness 此函数）。
- **修复建议**：该行只在"当前存在未闭合 cuckoo/js 开标记"时才剥离；或限定为 ```cuck/```js 前缀。

#### B-010｜P3｜数据正确性（DeepSeek 发送按钮选择器宽泛且重复）
- **位置**：src/providers/deepseek.ts:60-63。
- **原文**：
  ```js
  '[data-testid="send"]',
  '[data-testid="send-button"]',
  'button:has(svg[data-icon="send"])',
  'button:has(> svg)',                    // 宽泛
  'button:has(svg[data-icon="send"])',    // 与 60 行重复
  ```
- **分析**：`button:has(> svg)` 会命中页面上任何含直接 svg 子元素的按钮（新对话、分享、收藏都可能）。当前面具体选择器未命中时，可能点到错误按钮。第 60/63 行重复。
- **影响**：DeepSeek 页面 DOM 变更时偶发发错按钮。
- **置信度**：6（推测，未真机点选验证）。
- **修复建议**：删重复行；`button:has(> svg)` 收窄为带 aria-label/title 约束。

#### B-011｜P3｜健壮性（executor 执行锁仅写不检）
- **位置**：src/bridge/loop/executor.ts:8,25,81。
- **分析**：模块级 `isExecuting` 在 handleJsToolScript 开头置 true、finally 置 false，但**进入时不检查**是否已在执行。observer.processInterceptedResponse 亦无重入锁。若两条 finished 回复在工具执行 await 期间先后到达（handoff v0.9.18 所述旧任务尾巴场景的残余窗口），可能并发执行两组 JS。
- **影响**：理论重复执行；现网被遮罩+事件静默期大幅收敛。
- **置信度**：6（推测，需真机并发触发）。
- **修复建议**：handleJsToolScript 入口 `if (isExecuting) return;` 或在 observer 加执行中标志，新回复排队/丢弃。

#### B-012｜P3｜资源管理（retry 倒计时 interval 在 hidden 时仍跑）
- **位置**：src/bridge/loop/retry.ts:125-129（showCountdown 的 setInterval 1s 渲染）。
- **分析**：倒计时 box 隐藏后 interval 才在 clearPending 里 clearInterval（:94）。倒计时期间若用户切走标签页/窗口被节流，无碍；但倒计时 DOM 节点常驻 body，无泄漏。仅提示：cdTimer 引用存在 pending.countdownTimer，清理路径完整。本条记录为"已核查无实际泄漏"，仅说明。
- **置信度**：8。
- **结论**：非 bug，关闭。

---

## 三、推测区（置信度 ≤6，未坐实）

- **S-1**：DeepSeek extractor（deepseek.ts:282 `parsed.p === undefined && typeof parsed.v === 'string'`）按 currentIndex 判断 THINK/RESPONSE。若服务端在用户消息回显帧里也下发裸 `{p:undefined, v:"..."}` 字符串补丁，用户提问文本可能被并进正文。置信度 5——无真实抓包样本，现网 token 统计/任务正常，倾向未发生。
- **S-2**：chatgpt.ts:306-314 对 `/message/content/parts/N` 补丁，`o` 缺失时走 `text = node.v`（整段替换）。若该协议路径增量帧不带 `o`，会把增量 delta 当全量赋值、反而正确；反之若期望 append 却走到 replace，正文会被覆盖。置信度 5——依赖现网协议样本，无法静态定案。
- **S-3**：entry.ts:58 `webFrame.executeJavaScript(getHookSource())` 为异步注入，注释自称"必须在页面脚本执行前"。Electron preload 同步部分早于页面脚本，但 executeJavaScript 回调是否必然先于页面首批 fetch 发出，取决于事件队列；现网 hook 能拦到流说明时序基本成立，但首包竞态窗口未实测。置信度 5。
- **S-4**：custom/loader.ts:149 对 config.paths 直接 `require(p)`（未走 .cjs 临时副本）。若 userData/custom-providers/ 旁出现 package.json `"type":"module"`，.js 会被按 ESM 解析而加载失败。当前 userData 无 package.json，故未触发。置信度 4。

---

## 四、本片测试盲区清单

| 盲区 | 说明 |
|---|---|
| hooks/deepseek.ts / chatgpt.ts / claude.ts 本体 | 无任何单测（hooks.md 明确只能真机验证）；SSE 粘帧仅 shared/sse.test.js 覆盖，三平台 extractor 的状态机/终态判定零覆盖 |
| observer.ts:261 通知摘要 | 未测（B-007） |
| js-detector 未闭合围栏 flush | test/bridge/js-detector.test.js 未覆盖文末未闭合块（B-004） |
| retry 倒计时期间切会话 | retry.test.js 未覆盖（B-001） |
| executeJsBlocksWithRetry 对语法错误重试 | observer.test.js 未注入 SyntaxError 用例（B-006） |
| 4 反引号围栏 | js-detector.test.js 未覆盖（B-008） |
| Claude 流错误终态 | 无（B-002） |

---

## 五、PoC 清单与结果

PoC 目录：`D:\Desktop\Super-File\cuckoo-code\.agents\audit-poc\`
- `poc-parser-boundaries.test.js`（9 用例，全过）
- `vitest.poc.config.mjs`（独立 vitest 配置，避开主 include）

运行：`npx vitest run -c .agents/audit-poc/vitest.poc.config.mjs`

| PoC | 结论 |
|---|---|
| PoC-1 未闭合 cuckoo 块 | 被 flush 返回 `["await write({...content:\"incomplete\"]"]` → 截断代码会被提取执行（坐实 B-004） |
| PoC-2 带散文的 js 工具块 | 返回 []，不误执行（护栏正确） |
| PoC-3 纯 js 工具块 | 正确返回 1 块 |
| PoC-4 双 cuckoo 块 | 正确分 2 块（围栏 toggle 正常） |
| PoC-5 4 反引号围栏 | 返回 []，不识别（坐实 B-008） |
| PoC-6 looksLikeJsonToolCall | `{tool:` 无引号也命中，符合"宽松识别"设计 |
| PoC-7/8 SSE 跨 \r\n\r+、\n+ 分片 | 粘帧正确重组（解码器 scanFrom=len-3 尾保留逻辑正确，无 bug） |
| PoC-9 /s+/g 摘要 | `Successfully saved...` → `Succe fully aved...`（坐实 B-007） |

---

## 六、与 handoff 历史坑的回归核对

- **harness-stop-signal 乐观置 aiPageGenerating=false**：harness-bridge.ts:167-173 收到停止信号仍 `setAiGenerating(false)`。经查 harness.html 侧已按 handoff v0.9.18 叠加"事件静默期 + manualSendToken"校正，bridge 侧此乐观置位属设计内，未见回归。
- **session.ts 监听器泄漏**：本片 observer 的 responseListeners/errorListeners 等均为 Set + 返回取消函数，entry.ts 一次性注册 window listener 不重复注册；未见新增泄漏。
- **v0.9.18 旧任务尾巴回填**：observer.processInterceptedResponse 有 `lastProcessedText` 去重 + abortRequested 闸口；跨会话重试泄漏已单列为 B-001。
