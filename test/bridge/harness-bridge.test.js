'use strict';
/**
 * harness-bridge 上报行为测试
 *
 * 回归背景（两次真实故障）：
 *  1. AI 页面每次导航/重载都会重建 preload，靠"切换时下发一次"的门控会永久失配 →
 *     所有上报被静默丢弃 → 界面空白 + 状态卡死。故**上报不再设门控**，一律放行
 *     （主进程在没有 harness 视图时本就会丢弃）。这里钉住"没有门控也不会哑"。
 *  2. harness 曾只能靠超时猜"是否结束"，出现"网页答完、界面还在跑"。
 *     现在由 ai-state（AI 页面生成状态心跳）作为权威校正信号，必须如实上报。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

/** 共享状态容器：vi.mock 工厂被提升到顶部，用对象属性保证闭包拿到同一容器 */
const S = {
  reported: [],
  invoked: [],
  userMsgListener: null,
  stopListener: null,
  intervals: [],
};

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({
      ipcRenderer: {
        on: (ch, fn) => {
          if (ch === 'harness-user-message') S.userMsgListener = fn;
          if (ch === 'harness-stop-signal') S.stopListener = fn;
        },
        invoke: (ch, payload) => {
          S.invoked.push(ch);
          if (ch === 'harness-event-report') { S.reported.push(payload); return Promise.resolve({ success: true }); }
          return Promise.resolve({});
        },
      },
    }),
  };
});

// observer 与 chat-input 是外部边界：只关心 bridge 是否按要求上报
const CB = { response: null, stream: null, tool: null, delivered: null, taskIdle: null, aiError: null, userStop: null };
vi.mock('../../src/bridge/intercept/observer.js', () => ({
  onInterceptedResponse: (cb) => { CB.response = cb; return () => {}; },
  onStream: (cb) => { CB.stream = cb; return () => {}; },
  onToolCall: (cb) => { CB.tool = cb; return () => {}; },
  onTaskIdle: (cb) => { CB.taskIdle = cb; return () => {}; },
  onAiError: (cb) => { CB.aiError = cb; return () => {}; },
  onUserStop: (cb) => { CB.userStop = cb; return () => {}; },
  requestAbort: () => {},
  clearAbort: () => {},
}));

vi.mock('../../src/overlay/chat-input.js', () => ({
  sendToChat: () => Promise.resolve(true),
  cancelPendingSend: () => {},
  clearInputArea: () => Promise.resolve(true),
  onMessageDelivered: (cb) => { CB.delivered = cb; return () => {}; },
}));

/** 便捷触发 */
function responseCb(t) { return CB.response(t); }
function streamCb(ev) { return CB.stream(ev); }
function toolCb(ev) { return CB.tool(ev); }
function deliveredCb(info) { return CB.delivered(info); }
function taskIdleCb() { return CB.taskIdle(); }
function userStopCb() { return CB.userStop(); }
function types() { return S.reported.map((p) => p.type); }
function lastAiState() {
  const list = S.reported.filter((p) => p.type === 'ai-state');
  return list.length ? list[list.length - 1].generating : null;
}

beforeEach(async () => {
  vi.resetModules();
  S.reported = [];
  S.invoked = [];
  S.userMsgListener = null;
  S.stopListener = null;
  S.intervals = [];
  CB.response = null;
  CB.stream = null;
  CB.tool = null;
  CB.delivered = null;
  CB.taskIdle = null;
  CB.aiError = null;
  globalThis.window = {};
  globalThis.document = { addEventListener: () => {} };
  // 捕获心跳定时器（不真跑），用于断言周期上报
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { S.intervals.push({ fn, ms }); return 0; };
  try {
    const mod = await import('../../../src/bridge/harness-bridge.js');
    mod.initHarnessBridge();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

// ===== 无门控：不再有"静默丢弃"整类故障 =====

test('未收到任何门控广播也照常上报（杜绝哑界面）', async () => {
  responseCb('回复内容');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(types().includes('assistant-done'), '应上报 assistant-done，实际: ' + types().join(','));
});

test('流式事件照常上报', async () => {
  streamCb({ think: '', text: '正在输出', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(types().includes('stream'), '应上报 stream');
});

test('工具事件照常上报', async () => {
  toolCb({ phase: 'start', code: 'await read("a")' });
  toolCb({ phase: 'end', code: 'await read("a")', success: true, output: 'ok' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(types().includes('tool-start'));
  assert.ok(types().includes('tool-end'));
});

test('任务空闲照常上报 task-idle', async () => {
  taskIdleCb();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(types().includes('task-idle'));
});

test('框架投递上报 framework-send，harness 自身消息不报', async () => {
  deliveredCb({ text: '【系统提示词】...', tag: '系统提示词', isSystem: true });
  deliveredCb({ text: '你好', tag: 'harness', isSystem: false });
  await new Promise((r) => setTimeout(r, 0));
  const fw = S.reported.filter((p) => p.type === 'framework-send');
  assert.strictEqual(fw.length, 1, '只应上报框架侧那一条');
  assert.strictEqual(fw[0].tag, '系统提示词');
});

// ===== ai-state：权威生成状态 =====

test('心跳定时器已注册（周期上报，harness 中途创建也能拿到状态）', () => {
  const hb = S.intervals.find((x) => x.ms === 2000);
  assert.ok(hb, '应注册 2 秒心跳');
});

test('心跳会周期性上报当前状态', async () => {
  const hb = S.intervals.find((x) => x.ms === 2000);
  S.reported.length = 0;
  hb.fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(types().includes('ai-state'), '心跳应上报 ai-state');
});

test('流式输出 → ai-state 置为生成中', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), true);
});

test('无工具调用的回复完成 → ai-state 置为已停止', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  responseCb('最终回复（无工具调用）');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), false, '无工具调用说明本轮结束');
});

test('含工具调用的回复不算结束（后面还有工具循环）', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  responseCb('看代码：\n```cuckoo\nawait read("a.js")\n```\n');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), true, '含工具调用时不能判为已停止');
});

test('task-idle → ai-state 置为已停止', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  taskIdleCb();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), false);
});

test('投递消息 → ai-state 置为生成中（AI 即将工作）', async () => {
  deliveredCb({ text: 'x', tag: '系统提示词', isSystem: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), true);
});

test('AI 请求失败 → ai-state 置为已停止', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  CB.aiError({ status: 500 });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), false);
});

// ===== aiGenerating 看门狗：陈旧残留必须能自愈 =====
// 回归背景：aiGenerating 只由事件驱动，任一关键帧丢失（页面重载 / hook 中断 /
// SSE 异常收尾）都会让它永久停在 true，心跳随即持续上报 g=true，
// 使 harness 的静默兜底永远失效 —— 界面卡「生成中…」，只能手动点停止解套。

test('看门狗：aiGenerating 长期无活动 → 心跳自动复位为已停止', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), true, '前置：应处于生成中');

  const hb = S.intervals.find((x) => x.ms === 2000);
  // 把"最近活动时间"推到看门狗阈值之外（真实 120s，测试用假时钟推进）
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000;
  try {
    S.reported.length = 0;
    hb.fn();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    Date.now = realNow;
  }
  assert.strictEqual(lastAiState(), false, '长时间无活动应收敛为已停止，否则界面永久卡生成中');
});

test('看门狗：持续有流式活动时不得误杀生成中', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  const hb = S.intervals.find((x) => x.ms === 2000);
  S.reported.length = 0;
  hb.fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), true, '刚有活动时不能被复位');
});

// ===== hasTool 透传：状态栏"就绪闪烁"的修复依据 =====
// 回归背景：observer 先通知 responseListeners（harness 收到 assistant-done），
// 之后才执行工具（发 tool-start）。此刻 harness 的 toolRunningCount 仍为 0，
// 若不透传 hasTool，状态栏会短暂显示「就绪」再跳「工具运行中…」，看着像任务已结束。

test('assistant-done 透传 hasTool=true（含可执行工具块）', async () => {
  CB.response('我来读一下\n```cuckoo\nawait read("a.js")\n```\n');
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.ok(p, '应上报 assistant-done');
  assert.strictEqual(p.hasTool, true, '含可执行工具块时 hasTool 应为 true');
});

test('assistant-done 透传 hasTool=false（普通文本回复）', async () => {
  CB.response('这是一段普通回答，没有工具调用。');
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.strictEqual(p.hasTool, false, '无工具块时 hasTool 应为 false');
});

// 关键回归：宽松正则 HAS_TOOL_BLOCK_RE 会把这两种情况误判为"有工具"，
// 但它们根本不会被执行（extractJsToolBlocks 要求 js 块是纯代码块且调了工具函数）。
// 误判后果：状态栏显示「工具运行中…」，随后被静默兜底收尾。

test('hasTool 判据：正常回答里附 js 示例 → false（不误报）', async () => {
  CB.response('给你个例子：\n```js\nconst a = 1;\n```\n就这些');
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.strictEqual(p.hasTool, false, '普通回答里的 js 示例不会被执行，不应算工具');
});

test('hasTool 判据：js 纯代码块但无工具调用 → false（不误报）', async () => {
  CB.response('```js\nconst a = 1;\n```');
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.strictEqual(p.hasTool, false, '纯代码块无工具调用，不会执行，不应算工具');
});

test('状态未变化时不重复上报（避免刷屏）', async () => {
  streamCb({ think: '', text: 'a', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  S.reported.length = 0;
  streamCb({ think: '', text: 'ab', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(types().filter((t) => t === 'ai-state').length, 0, '状态未变不应重复上报');
});

test('assistant-done 透传服务端 msgIds（供真截断定位）', async () => {
  CB.response('回复内容', { msgIds: { requestMessageId: 100, responseMessageId: 101 } });
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.ok(p, '应上报 assistant-done');
  assert.deepStrictEqual(p.msgIds, { requestMessageId: 100, responseMessageId: 101 }, '应透传 msgIds');
});

test('assistant-done：meta 缺失时 msgIds 为 null（不报错）', async () => {
  CB.response('回复内容');
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.ok(p, '应上报 assistant-done');
  assert.strictEqual(p.msgIds, null, '无 meta 时应为 null');
});

test('assistant-done：meta 无 msgIds 字段时也为 null', async () => {
  CB.response('回复内容', { tokenUsage: { accumulatedTokens: 5 } });
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'assistant-done');
  assert.strictEqual(p.msgIds, null);
});

test('收到停止信号 → ai-state 置为已停止', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  S.stopListener();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), false);
});

test('网页模式点停止（onUserStop）→ 纯净模式收尾（ai-state 停 + task-idle）', async () => {
  streamCb({ think: '', text: '输出中', finished: false });
  userStopCb();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(lastAiState(), false, '网页停止应同步 ai-state 停止');
  assert.ok(types().includes('task-idle'), '网页停止应上报 task-idle 让纯净模式收尾');
});

// ===== B-009：普通语言代码块收尾围栏不被误剥 =====

test('B-009: 回复以 ```python 块收尾时，其收尾围栏保留（不被当残缺开标记剥掉）', async () => {
  // 流式结束帧带全文：正文以 ```python 块收尾
  streamCb({ think: '', text: '请看：\n```python\nprint(1)\n```\n', finished: true });
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'stream');
  assert.ok(p, '应上报 stream');
  // 收尾 ``` 应保留：文本结尾仍有 python 块的闭合围栏
  assert.ok(/```python[\s\S]*```\s*$/.test(p.text.trimEnd()), 'python 收尾块闭合围栏应保留，实际: ' + JSON.stringify(p.text));
});

test('B-009: 残缺 cuckoo 开标记（```cuck）仍被隐藏', async () => {
  streamCb({ think: '', text: '正在写：\n```cuck', finished: false });
  await new Promise((r) => setTimeout(r, 0));
  const p = S.reported.find((x) => x.type === 'stream');
  assert.ok(p, '应上报 stream');
  assert.ok(!/```cuck/.test(p.text), '残缺 cuck 开标记应被剥离，实际: ' + JSON.stringify(p.text));
});
