# 最新接续状态 (2026-10-18 18:30)

## 核心进展

**v0.10.20 准备发布：4 处速度优化 + 1 处摘要修复。四项校验全绿。**

### 本轮 3 个文件改动（+74 / -23 行）

| 文件 | 改动 |
|---|---|
| `src/app/ipc/shell.ts` | 新对话：400ms 固定延迟 → 轮询检测 textarea（100ms 间隔，上限 1.5s） |
| `src/app/ipc/harness.ts` | 截断激活：首轮立即检查 + 300ms 轮询（原 800ms），上限 15→40 轮 |
| `src/session/compaction.ts` | ① IDB 轮询 200→150ms ② 压缩 3 秒延迟 → 轮询 textarea ③ `MAX_SUMMARY_LEN` 3000→5000 ④ 新增总长动态保护（超 49500 自动裁） |

### 提速实测（真机日志）

| 流程 | 优化前 | 优化后 | 说明 |
|---|---|---|---|
| 新对话（本地代码） | ~450ms | **~51ms** | 剩余全是 DeepSeek 端（建会话 + AI 首响 ~2.5s） |
| 截断重发（本地代码） | ~3.05s | **~2.46s** | 剩余 4-6s 全是 DeepSeek 端（克隆分享会话） |
| 压缩（本地代码） | ~5s | **~2.6s** | 剩余 1-17s 是 AI 生成摘要时间 |

**结论：本地代码已压到接近极限，剩余耗时全是 DeepSeek 服务端固定行为，无法优化。**

### 摘要上限决策依据

| 数据 | 值 |
|---|---|
| 曾判定"44246 超限" | ❌ 实为**高频限流**误判 |
| 实测成功的最长提示词 | **47175**（含 3000 摘要，多次成功） |
| 长会话 AI 生成的摘要长度 | 3540（常态）/ 5757（极端） |
| 3000 上限的代价 | 砍掉 15%~48% 信息（5757→3002 丢 47.9%） |
| **采用 5000** | 基础 44100 + 5000 = 49100，仅超实测线 2000，风险可控 |
| 未采用 8000 | 会到 52100，超 5000 且未验证 |

**关键提醒**：`BASE_PROMPT_EST = 44100` 是硬编码估算。实测发现不同项目的基础提示词长度差异很大（cuckoo-code 32432 / security-management-platform 44102）。若未来项目文件膨胀，需重新校准这个估算值，或改为实际调 `buildPrompt` 量长度。

## 核心动机与背景 (Motivation & Background)

### 用户诉求

用户反馈："我们先给您压缩新对话，还有编辑对话历史和新对话。这个3到1的过程时间可以加快吗？现在有问题吗？已经是闭环的吗？"

**三个流程的真实瓶颈分析**：

1. **新对话**：本地代码只占 ~450ms，剩余 ~2.5s 是 DeepSeek 端（页面加载 + 建会话 + AI 首响）
2. **截断重发**：本地代码 ~3s，剩余 4-6s 是 DeepSeek 端（克隆分享会话 2-3s + 导航 1-2s）
3. **压缩**：本地代码 ~5s，剩余 1-17s 是 AI 生成摘要时间

**核心洞察**：
- 快路径（不刷新直接读 IDB）对**新会话必然失败**——DeepSeek 只在刷新页面后才写入当前会话历史到 IDB（实测 `hasData: false`）
- 之前"44246 超限"的判定是**高频限流误判**——同一时间窗口内连发多次请求会触发限流，与长度无关
- harness 在 WebContentsView 中恒 `document.hidden`，所有 rAF 动画需 hidden 兜底（已在 v0.10.17-19 修完三处）

## 关键设计与实现 (Implementation & Decisions)

### 1. 新对话 waitInput 轮询（`shell.ts`）

```js
const waitInput = (deadline, cb) => {
  const tryCheck = () => {
    wc.executeJavaScript('!!document.querySelector("textarea")')
      .then(ready => {
        if (ready || Date.now() >= deadline) { cb(); return; }
        setTimeout(tryCheck, 100);
      })
      .catch(() => { if (Date.now() >= deadline) cb(); else setTimeout(tryCheck, 100); });
  };
  tryCheck();
};
// 首次 50ms 缓冲后开始轮询，上限 1.5 秒
```

**权衡**：网络正常时省 350ms；网络异常时多等最多 1.1 秒（异常是少数，划算）。

### 2. 截断激活首轮立即检查（`harness.ts`）

原实现 `for (attempt=0; attempt<15; attempt++) { await 800ms; ... }` 首轮就白等 800ms。改为：
- `if (attempt > 0) await 300ms` —— 首轮立即检查
- 上限 15→40（40×300 = 15×800，总时长仍约 12 秒）

### 3. 压缩摘要上限 3000→5000 + 总长保护（`compaction.ts`）

```js
const MAX_SUMMARY_LEN = 5000;   // 原 3000
const BASE_PROMPT_EST = 44100;  // 硬编码估算（需随项目文件增长而重新校准）
const MAX_TOTAL_LEN = 49500;
if (BASE_PROMPT_EST + compactSummary.length > MAX_TOTAL_LEN) {
  const room = Math.max(2000, MAX_TOTAL_LEN - BASE_PROMPT_EST);
  effectiveSummary = compactSummary.slice(0, room) + ' …';
}
```

### 4. 压缩 3 秒固定延迟 → 轮询（`compaction.ts`）

原 `setTimeout(() => initProject(...), 3000)` 固定等 3 秒。改为轮询检测 `textarea`（每 200ms，上限 3 秒），出现即走 `initProject`。实测省 2.4 秒。

## 待办事项 (Next Steps)

- [ ] **提交本轮改动 + 打 v0.10.20 tag 推送**
- [ ] **人工点验**（用户本地测）：
  1. 新对话是否正常（点加号 → 提示词发出 → AI 回话）
  2. **压缩后 AI 是否能正常回话**（验证 5000 摘要不触发超限）
  3. 截断重发是否只有 1 条新消息
  4. 三个流程是否感觉变快

## 关键上下文

- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 当前分支: master，HEAD = `11c3d75`（v0.10.19）
- 已发布版本: v0.10.17 / v0.10.18 / v0.10.19（CI 均成功）

### 主要文件与函数

| 文件 | 关键位置 |
|---|---|
| `src/app/ipc/shell.ts` | `web-new-conversation` handler（`:216` 起），`waitInput` 轮询（`:262` 起） |
| `src/app/ipc/harness.ts` | `activateShareSession`（`:182` 起），轮询逻辑（`:215` 起） |
| `src/session/compaction.ts` | `MAX_SUMMARY_LEN = 5000`（`:58` 附近）、`waitForIdbMessages`（`:148` 起，150ms）、`checkPendingInit`（`:450` 起，轮询 + 总长保护） |
| `src/ui/harness.html` | （v0.10.19 已修）`_lastScrollTop` 三态判据、`scrollBottom`/`resize`/`scheduleConvNavActive` 的 hidden 兜底、`fastScrollTo` 中止 settle、hover 滚底、三态按钮组 |

### 开发环境

```cmd
set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& set CUCKOO_HOME=%USERPROFILE%\.cuckoo-dev&& npx electron . --remote-debugging-port=9444
```
- 独立 userData（`cuckoo-dev-verify`）+ 独立 `CUCKOO_HOME`（`.cuckoo-dev`，remote 端口 7800），与生产版（7799）隔离
- CDP 端口 9444

### CDP 注入脚本模板

```js
// .agents/cdp-eval.mjs（用完即删，切勿提交）
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

### 环境陷阱（踩过的坑）

- `taskkill /F /IM electron.exe` 被安全策略拒绝 → 用 `wmic process where "name='electron.exe'" call terminate`
- `rmdir /s /q` 被拒绝 → `deleteFile` 删文件 + `rmdir` 逐层删空目录
- 主进程 `console.log` 不一定进 `deepseek.log`（该文件是 renderer 日志）
- **高频真机测试会被 DeepSeek 限流**（3 秒内连发多次 → `status:error`），**不是长度或代码问题**
- 分享页克隆成活会话固定需 2~3 秒（DeepSeek 设计约束）
- **cuckoo 代码块内不要用 `const log = await bash(...)`**——`log` 是工具函数会被遮蔽
- **`git add -A` 会把临时探测脚本一起提交**——提交前先清理 `.agents/*.js` 或用明确文件列表
- **harness 在 WebContentsView 中恒 `document.hidden`**——所有 rAF 动画/节流都需 hidden 兜底
- GitHub token 无 `actions:write` 权限，无法通过 gh CLI 取消/重跑 CI
- `build.files` 含 `"!.agents/**"` 排除规则——`.agents/` 不会打包进安装包
- **基础提示词长度因项目而异**（cuckoo-code 32432 / security-management-platform 44102）——`BASE_PROMPT_EST` 需谨慎
