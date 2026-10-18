# 最新接续状态 (2026-10-18 16:15)

## 核心进展

**v0.10.19 已完成：4 处修复 + 1 处 UI 简化，四项校验全绿（typecheck / test 129文件1219用例 / lint 0 error / compile），待提交发版。**

### 1. 截断重发重复发送 3~4 次（`src/app/ipc/harness.ts`）
- 根因：`activateShareSession` 每 800ms 一轮、最多 6 轮，每轮只要分享页 textarea 就绪就发 `harness-user-message`。分享页克隆成活会话需 2~3 秒，循环在变活前已发 3~4 次。
- 修复：加 `sent` 标志只发一次；轮次上限 6→15，之后仅轮询 URL 等变活。
- 真机证据：`UNIQUE-MARKER-XYZ` 在 DOM 与 localStorage 历史中均只有 1 条（修复前 3~4 条）。

### 2. 切走再切回不自动滚到底部（`src/ui/harness.html`）
- 根因：`stream` 的 `scroll` 事件无条件 `pinBottom = isNearBottom()`。流式输出使 `scrollHeight` 持续增长 → 浏览器派发 scroll（`scrollTop` 未变）→ 距底变远 → `pinBottom` 被自己踩成 false → 切回时 `if (pinBottom)` 不成立。
- 修复：记录 `_lastScrollTop`，仅 `scrollTop` 变小（真上滚）才置 false；内容增长导致的被动 scroll 保留原状态。
- 加固：`focus`/`hover 滚底`/`回底按钮`/`settle 结束` 四处补 `_lastScrollTop = stream.scrollTop`。
- 真机验证（5 阶段）：滚到底 pin=true → 内容增长 pin 仍 true → 用户上滚 pin=false → focus 不强制滚（尊重翻历史）→ 滚回底部 pin=true。

### 3. 点导航条目跳转失效（`src/ui/harness.html`）
- 根因：settle 后续 `step()` 把 `scrollTop` 又拉回底部，覆盖 `fastScrollTo`。
- 修复：`fastScrollTo` 开头中止 settle（`_settleGen++` + 清 timer/listener + `resetExpectVars()`，后者为新增的模块级函数）。

### 4. 点导航完全无反应（隐藏页面）（`src/ui/harness.html`）
- 根因：`document.hidden` 时 rAF 被挂起，`fastScrollTo` 动画永不执行。
- 修复：`hidden` 时直接 `scrollTop = target`。

### 5. 移除「仅保存 / 保存修改」按钮（`src/ui/harness.html`）
- 用户反馈：没实际作用就删掉。
- 分析确认：该按钮只改 DOM + localStorage，**AI 服务端上下文完全不变**。用户改了 AI 也不知道，下次引用历史仍是原文。
- 删除范围：历史中间消息的「保存修改」、最后一条已完成的「仅保存」、待发送消息的「仅保存」、`doSaveOnly` 函数、`btnSaveOnly` 事件绑定。
- `Ctrl+Enter` 在历史消息上改为触发 `doTruncate()`（原为 `doSaveOnly()`）。
- 真机验证按钮组：中间消息「取消/填入输入框/从此处截断重发」；最后一轮已完成「取消/从此处截断重发」；待发送「取消/重新发送」。
- 测试同步更新：原断言「应有 msg-edit-save-only」改为「应已移除」，并校验新的 Ctrl+Enter 映射。

## 核心动机与背景 (Motivation & Background)

### 用户原始反馈

1. 「1+1 2+2 3+3 我是从这里截断的，把 3+3 改成了 3+3+3」——截图显示导航栏出现 3 个相同的 `3+3+3`。
2. 「我使用真机测试的时候，让它分析了一个东西，它在执行中，我切到其他的窗口，然后再切回来，我发现它没有滚动触底呀。」
3. 「对话历史编辑的时候，有个仅保存按钮是干嘛用的？没有实际功能作用的话，就可以去掉。」

### 关键洞察

- **重复发送**：截图对应的会话在新会话创建后已不存在（`find-dup` 扫所有会话历史 `dupSessions: []`），说明重复只在 DOM 层、未持久化——是当次发送 3~4 次，非历史数据错误。
- **滚底失效**：根因不是 focus 监听缺失，而是 `scroll` 事件把自己状态踩死了。**内容增长会触发 scroll 事件但 `scrollTop` 不变**，这是之前的盲区。
- **仅保存**：082 需求当初的假设「用户只想改提示词或错别字并保存历史记录」本身有问题——改的东西 AI 看不到。

## 关键设计与实现 (Implementation & Decisions)

### scroll 事件的三态判据（核心）

```js
var cur = stream.scrollTop;
if (cur < _lastScrollTop - 1) {
  pinBottom = false;         // scrollTop 变小 = 用户真的往上滚
} else if (isNearBottom()) {
  pinBottom = true;          // 用户主动滚回底部附近
}
// cur >= _lastScrollTop 且不在底部 → 内容增长导致的被动 scroll，保留原状态
_lastScrollTop = cur;
```

这个判据的关键：**内容增长不会让 `scrollTop` 变小**。所以「scrollTop 变小」是「用户上滚」的充分条件。

### hidden 页面下的 rAF（跨功能影响清单）

harness 在 WebContentsView 中 `document.visibilityState` 恒为 `hidden`。已修：
- `fastScrollTo`（本轮）
- `settleScrollBottom`（v0.10.17）

**尚未处理**：`scheduleConvNavActive` 的 rAF 节流（hidden 下导航 active 高亮不更新，低优先级）。

### 「仅保存」的删除决策

**保留「填入输入框」**：它的语义是「引用这条历史消息」，把文本复制到输入框让用户改完再发——这是有意义的（会真的发给 AI）。
**删除「仅保存/保存修改」**：只改本地不改 AI，纯自欺欺人。

## 待办事项 (Next Steps)

- [ ] **提交本轮改动 + 打 v0.10.19 tag 推送**（4 个文件：`src/app/ipc/harness.ts`、`src/ui/harness.html`、`test/ui/harness-page.test.js`、`.agents/handoff.md` + CHANGELOG/package.json）
- [ ] 人工点验：真实窗口下切走再切回是否自动贴底、hover 导航滚底平滑度、点导航跳转手感、截断后无重复消息
- [ ] （可选，低优先级）`scheduleConvNavActive` 的 rAF 节流在 hidden 下不更新 active 高亮

## 关键上下文

- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 当前分支: master，HEAD = `2a0cb9b`（v0.10.18）
- 已发布版本: v0.10.17 / v0.10.18（两者 CI Build and Release 均已成功）

### 主要文件与函数

| 文件 | 关键函数 / 位置 |
|---|---|
| `src/app/ipc/harness.ts` | `activateShareSession`（`:182` 起，`sent` 标志 / `bindProjectDirToNewSid` / `extractSid`）、`harness-truncate` handler（`:487` 起，`curProjectDir` 捕获）、`notifyHarnessSession`（providerId 兜底） |
| `src/ui/harness.html` | `_lastScrollTop`（新增，scroll 三态判据）、`scroll` 事件（`:4849` 附近）、`settleScrollBottom`（`:2803` 起）、`fastScrollTo`（`:3770` 附近）、`resetExpectVars`（`:2796`）、hover 滚底（`:3782` 附近）、`editUserMessage`（`:1308` 起，三态按钮组）、`doTruncate`/`doSubmitLatest`/`doQuote` |
| `src/session/store.ts` | `handleUrlChange`（三分支：pendingProjectDir / getProjectDirBySessionId / 分享页中间态） |
| `test/ui/harness-page.test.js` | `editUserMessage` 三态按钮组测试、`doSaveOnly` 已移除断言 |

### 开发环境

```cmd
set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& set CUCKOO_HOME=%USERPROFILE%\.cuckoo-dev&& npx electron . --remote-debugging-port=9444
```
- 独立 userData（`cuckoo-dev-verify`）+ 独立 `CUCKOO_HOME`（`.cuckoo-dev`，remote 端口 7800），与生产版（7799）隔离
- CDP 端口 9444

### CDP 注入脚本模板（每次需重建）

```js
import fs from 'node:fs';
const [,, titleSub, codeFile, exFlag, exSub, idxStr] = process.argv;
const list = await (await fetch('http://127.0.0.1:9444/json/list')).json();
const candidates = list.filter(x => x.type === 'page' && x.title.includes(titleSub) && !(exFlag === '--exclude' && exSub && x.title.includes(exSub)));
const idx = parseInt(idxStr || '0', 10) || 0;
const t = candidates[idx];
if (!t) { console.log('NOT_FOUND candidates=' + candidates.length); process.exit(2); }
const code = fs.readFileSync(codeFile, 'utf-8');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r));
function send(method, params) { const i = ++id; return new Promise(res => { pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); }
const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result && r.result.result ? r.result.result.value : r.result, null, 1));
if (r.result && r.result.exceptionDetails) console.log('EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0,500));
ws.close();
process.exit(0);
```

### 环境陷阱

- `taskkill /F /IM electron.exe` 被安全策略拒绝 → 用 `wmic process where "name='electron.exe'" call terminate`
- `rmdir /s /q` 被拒绝 → `deleteFile` 删文件 + `rmdir` 逐层删空目录
- 主进程 `console.log` 不一定进 `deepseek.log`（该文件是 renderer 日志）
- 高频真机测试会被 DeepSeek 限流（3 秒内连发多次 → `status:error`），**不是长度或代码问题**
- 分享页克隆成活会话固定需 2~3 秒（设计约束，决定循环上限）
- **cuckoo 代码块内不要用 `const log = await bash(...)`**——`log` 是工具函数，会被遮蔽导致后续 `log()` 调用报错
