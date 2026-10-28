/**
 * DeepSeek 拦截模式下的回复处理器（隔离世界）
 * 监听主世界注入的 'cuckoo-ai-response' 事件，收到完整回复后走与 DOM 模式
 * 相同的工具调用/JS 代码块处理流程。
 */
import { extractJsToolBlocks, BT } from '../parser/js-detector.js';
import { looksLikeJsonToolCall } from '../parser/json-detector.js';
import { handleJsToolScript } from '../loop/executor.js';
import { buildNotificationSummary } from './notification-summary.js';
import { sendCombinedJsResultsToChat, sendMessageToChat, cancelPendingSend } from '../../overlay/chat-input.js';
import { showToolMask, hideToolMask } from '../../overlay/panel.js';
import * as watchdog from '../loop/watchdog.js';

/** 子代理/网关窗口抑制"任务完成"通知（它们的完成属内部过程；主进程侧有 ctx.isSubagent 兜底，
 *  但窗口销毁存在竞态——IPC 到达时 ctx 可能已失效回退主窗口，故在源头就拦住）。 */
let suppressAiNotification = false;
function setSuppressAiNotification(v: boolean): void { suppressAiNotification = !!v; }

// 正文标记：AI 回复里输出 [记忆]xxx / [快照]名称，软件据此自动创建
// 中文全角/半角方括号都支持；只匹配行首（可含前导空白），避免误伤正文中引用的字样
const MEMORY_MARKER_RE = /^[ \t]*[\[【]记忆[\]】]\s*([^\n]+)/gm;
const SNAPSHOT_MARKER_RE = /^[ \t]*[\[【]快照[\]】]\s*([^\n]+)/gm;

/**
 * 从 AI 回复正文中提取 [记忆]/[快照] 标记并触发主进程创建。
 * 失败静默（不影响主流程）。返回提取到的数量。
 */
async function processInlineMarkers(text: string): Promise<{ memories: number; snapshots: number }> {
  const result = { memories: 0, snapshots: 0 };
  if (!text) return result;
  const api = (window as any).electronAPI;
  if (!api) return result;

  const memMatches = Array.from(text.matchAll(MEMORY_MARKER_RE));
  for (const m of memMatches) {
    const content = (m[1] || '').trim();
    if (!content) continue;
    try {
      if (api.createMemoryFromMarker) { await api.createMemoryFromMarker(content); result.memories++; }
    } catch (_) { /* ignore */ }
  }

  const snapMatches = Array.from(text.matchAll(SNAPSHOT_MARKER_RE));
  for (const m of snapMatches) {
    const name = (m[1] || '').trim();
    if (!name) continue;
    try {
      if (api.createSnapshotFromMarker) { await api.createSnapshotFromMarker(name); result.snapshots++; }
    } catch (_) { /* ignore */ }
  }
  if (result.memories || result.snapshots) {
    console.log('[Cuckoo Code][标记] 记忆=' + result.memories + ' 快照=' + result.snapshots);
  }
  return result;
}

// 连续"格式提示"次数（JSON/XML 共用，防止 AI 来回切换格式绕过上限）
let formatHintCount = 0;
const FORMAT_HINT_MAX = 10;
// 上次已处理的文本（去重，防同一条回复重复处理）
let lastProcessedText = '';
// 最近一次拦截到的完整回复文本（供手动解析复用，不依赖 DOM）
let lastInterceptedText = '';
// 用户请求中止：停止工具循环的回传（停止按钮触发）
let abortRequested = false;
function requestAbort(): void {
  abortRequested = true;
  emitUserStop();
}
function clearAbort(): void { abortRequested = false; }

/**
 * 剥离合法工具容器（cuckoo/js/javascript 代码块），仅用于格式误报检测。
 * 原因：AI 在 cuckoo 块里写 JSON/XML 示例是正常的（解释/举例），不应触发格式纠正提示。
 * 不剥离 json/python 等其他块——那些块里出现工具调用语法，仍是真实错误
 * （项目取舍：宁可误报不漏报，确保模型用错格式时能被纠正）。
 */
function stripToolBlocks(text: string): string {
  if (text.indexOf('```') === -1) return text;
  return text
    .replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*?```/gi, '')
    .replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*$/gi, '');
}

/**
 * 剥离行内代码与引用块，仅用于格式误报检测。
 *
 * 原因：AI 在正文里讨论/举例工具调用语法是正常的（"旧提示会回显 xxx 标签"、
 * "例如 \`<invoke name=\"x\">\`"），不应被误判为真实工具调用。
 * 真实工具调用通常是整条回复独立的标签结构，而非嵌在中文句子里的引用。
 */
function stripInlineCodeAndQuotes(text: string): string {
  if (!text) return text;
  return text
    // 行内代码：单个反引号包裹、不跨行（三反引号块已由 stripToolBlocks 处理）
    .replace(/`[^`\n]*`/g, '')
    // 引用块：行首 > 开头的整行（引用他人/历史内容）
    .replace(/^[ \t]*>.*$/gm, '')
    // 中文引号包裹（「」『』“”，不跨行）：AI 用中文标点举例时最常见
    // 取舍：若模型用中文标点包裹真实工具调用，会被当作引用放过（不提示）。
    // 现实中真调用不会用中文标点包裹，且不跨行的限制保证多行裸标签仍能检出。
    .replace(/「[^「」\n]*」/g, '')
    .replace(/『[^『』\n]*』/g, '')
    .replace(/“[^“”\n]*”/g, '')
    // 中文括号包裹（不跨行）：同上
    .replace(/（[^（）\n]*）/g, '')
    // Markdown 表格行：整行以 | 开头且含 | 分隔，属结构化展示而非调用
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '');
}

/**
 * 识别 XML / DSML / antml 格式的工具调用（DeepSeek 原生格式等）。
 * 返回 { kind, intent } 或 null。intent 为提取到的原始调用意图（供自动纠正重试）。
 * 覆盖：<|DSML|calls>、<|DSML|invoke ...>、<antml:invoke ...>、<invoke name="...">、<parameter name=...>
 */
/**
 * 注意：返回的 kind / intent 目前**仅用于真值判断**，提示文案不再消费它们
 * （曾把 intent 原文回显给模型，造成二次污染与读不通的提示，已移除）。
 * 保留字段是为将来日志/诊断可能用到，不要据此以为下游还依赖具体值。
 */
function detectXmlToolCall(raw: string): { kind: string; intent: string } | null {
  const t = raw || '';
  // DSML（半角 | 与全角 ｜ 都认）
  const dsml = /<[|｜]+\s*DSML\s*[|｜]+\s*([a-zA-Z]+)\b([^>]*)>/i.exec(t);
  if (dsml) {
    const tag = dsml[1];
    const attrs = (dsml[2] || '').trim();
    return { kind: 'DSML（<|DSML|' + tag + '>）', intent: tag.toLowerCase() === 'invoke' ? attrs : '' };
  }
  // antml:invoke / invoke name="..."
  const invoke = /<\s*(?:[\w-]+:)?invoke\s+([^>]*)>/i.exec(t);
  if (invoke) return { kind: 'XML invoke', intent: (invoke[1] || '').trim() };
  // parameter 单独出现（无 invoke）也算
  if (/<\s*(?:[\w-]+:)?parameter\s+name=/i.test(t)) return { kind: 'XML parameter', intent: '' };
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送工具结果回 AI，带重试（防偶发失败导致模型停下）。
 *
 * 覆盖"可检测的机械失败"：找不到输入框（页面重渲染/导航中）、填入内容失败。
 * 这类失败在"偶发"场景里最常见，重试即可恢复。
 *
 * 不覆盖"triggerSend 假阳性"（发了但站点没接收）：该情况无法可靠检测
 * （输入框清空时机 / contenteditable 文本归一化都不可控），强行检测会导致
 * 同一条工具结果重复发送 → 工具重复执行（破坏性 > 原 bug）。故不做自动补发。
 *
 * 只作用于工具结果回传路径，不改 chat-input 任何函数签名 → Harness 零影响。
 * @returns 是否最终发送成功
 */
async function sendToolResultWithRetry(results: any, onSent?: () => void): Promise<boolean> {
  const MAX_ATTEMPTS = 3;     // 常规发送最多 3 次
  const RETRY_DELAY_MS = 600; // 重试间隔
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 每次重试前检查中止：用户已点停止 → 不再回传（防止旧任务结果混入新任务）
    if (abortRequested) {
      console.log('[Cuckoo Code][拦截] 重试期间已请求中止，放弃工具结果回传');
      return false;
    }
    const sent = await sendCombinedJsResultsToChat(results, onSent).catch(() => false);
    if (sent) return true;
    console.warn('[Cuckoo Code][拦截] 工具结果回传失败（第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次）');
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return false;
}

/**
 * 执行 JS 代码块（拦截模式下文本已完整/稳定，失败即终态，不重跑同一段代码）。
 *
 * B-006：历史实现在遇到"代码不完整"类错误（SyntaxError 等）时把同一段代码重跑最多 3 次。
 * 但 finished 路径下代码文本不会变化，解析期语法错误重跑必然复现同样的错误，纯属空转
 * （每次隔 1s，徒增 ~3s 延迟并向沙箱重复提交非法代码；多块时还会把已成功的块再执行一遍）。
 * 真正的截断代码已由 B-002（断流走 error）与 B-004（未闭合围栏丢弃）在源头拦截，这里一次执行即可。
 */
async function executeJsBlocksWithRetry(blocks: string[]): Promise<any[]> {
  // 工具开始（每个代码块一次）
  for (const code of blocks) emitToolCall({ phase: 'start', code });
  const results: any[] = [];
  for (const code of blocks) {
    const r = await handleJsToolScript(code);
    if (r) results.push(r);
  }
  // 工具结束（逐块上报结果）
  for (const r of results) {
    emitToolCall({
      phase: 'end',
      code: (r && r.code) || '',
      success: !!(r && r.result && r.result.success),
      output: (r && r.result && r.result.output) || '',
      error: (r && r.result && r.result.error) || '',
    });
  }
  return results;
}

/**
 * 处理一条已完成的 AI 回复文本
 * @param text 完整回复文本（Markdown 原文）
 * @param force 为 true 时跳过去重（手动解析重新执行同一条时使用）
 */
async function processInterceptedResponse(text: string, force?: boolean): Promise<void> {
  if (abortRequested) {
    abortRequested = false;
    console.log('[Cuckoo Code][拦截] 已请求中止，跳过本次处理并复位中止状态');
    return;
  }
  const raw = (text || '').trim();
  if (!raw) return;
  if (!force && raw === lastProcessedText) return;
  lastProcessedText = raw;

  console.log('[Cuckoo Code][拦截] 收到完整回复，长度=' + raw.length + '，开始解析工具调用');

  // 0. 正文标记：[记忆]xxx / [快照]xxx（独立于工具调用，无论后续走哪条路都先处理）
  try { await processInlineMarkers(raw); } catch (_) { /* ignore */ }

  // 1. 优先检测 JS 工具代码块（cuckoo / js 代码块）
  const jsBlocks = extractJsToolBlocks(raw);
  if (jsBlocks.length > 0) {
    console.log('[Cuckoo Code][拦截] 检测到 JS 工具代码块（' + jsBlocks.length + ' 个），开始执行');
    formatHintCount = 0;
    // 从检测到工具调用到结果发送完成，全程遮盖页面
    // 执行阶段即显示「停止」：点击 = 放弃等待（沙箱工具已在跑无法中断，但不再回传结果）
    let cancelled = false;
    showToolMask(() => {
      cancelled = true;
      // 真杀：通知主进程取消正在跑的子代理（销毁隐藏窗口）
      try {
        const api = (window as any).electronAPI;
        if (api && typeof api.cancelSubagents === 'function') api.cancelSubagents().catch(() => {});
      } catch (_) { /* ignore */ }
      hideToolMask();
    });
    let results: any[] = [];
    try {
      results = await executeJsBlocksWithRetry(jsBlocks);
    } catch (err) {
      hideToolMask();
      throw err;
    }
    if (cancelled) {
      console.log('[Cuckoo Code][拦截] 用户已取消工具执行，丢弃结果，不回传');
      return;
    }
    if (results.length === 0) {
      hideToolMask();
      return;
    }
    // 发送阶段：点击「停止」= 取消回传
    showToolMask(() => {
      cancelled = true;
      cancelPendingSend();
      hideToolMask();
    });
    if (abortRequested) { abortRequested = false; hideToolMask(); console.log('[Cuckoo Code][拦截] 已请求中止，不回传工具结果'); return; }
    // afterSent 在"结果已发出"时触发隐藏；发送失败（找不到输入框等）则立即隐藏兜底
    const sent = await sendToolResultWithRetry(results, hideToolMask);
    if (cancelled) return; // 用户已取消，不再处理
    if (!sent) {
      // 重试后仍失败：隐藏遮罩 + 提示用户（避免"模型莫名停下"无从察觉）
      hideToolMask();
      console.error('[Cuckoo Code][拦截] 工具结果回传最终失败，模型可能无法继续');
    }
    return;
  }

  // 2. JSON 格式工具调用（D11：已废除执行，仅识别并提示改用 cuckoo 代码块）
  // 剥离 cuckoo/js 块后再检测：避免把"块内的 JSON 示例"误判为格式错误
  const rawForFormatCheck = stripInlineCodeAndQuotes(stripToolBlocks(raw));
  if (looksLikeJsonToolCall(rawForFormatCheck)) {
    if (formatHintCount >= FORMAT_HINT_MAX) {
      console.log('[Cuckoo Code][拦截] 已连续提示 ' + formatHintCount + ' 次格式问题，停止发送');
      return;
    }
    formatHintCount++;
    console.log('[Cuckoo Code][拦截] 检测到 JSON 格式工具调用（第 ' + formatHintCount + ' 次提示）');
    // 格式纠正属系统即时指令：传 fixedDelay=0 立即发出。
    // 若走拟人化随机延迟（6-16s），延迟窗口内 harness 看不到"框架在驱动"，
    // 会把静默误判为任务结束 → 提前 flush 待发队列（本轮任务其实未完）。
    sendMessageToChat(
      '请使用' + BT + BT + BT + 'cuckoo' + BT + BT + BT + ' 代码块进行工具调用，不要输出 JSON 格式。',
      'JSON工具调用提示',
      undefined,
      0
    );
    return;
  }

  // 3. XML 格式工具调用提示
  const xmlTool = detectXmlToolCall(rawForFormatCheck);
  if (xmlTool) {
    if (formatHintCount >= FORMAT_HINT_MAX) {
      console.log('[Cuckoo Code][拦截] 已连续提示 ' + formatHintCount + ' 次格式问题，停止发送');
      return;
    }
    formatHintCount++;
    console.log('[Cuckoo Code][拦截] 检测到 XML/DSML 格式工具调用（第 ' + formatHintCount + ' 次提示）');
    // 不把具体的 xmlTool.kind（如 <|DSML|invoke>）写进提示，避免二次污染 AI 上下文
    // 不回显 intent 原文：它是标签的原始属性串（如 name="zzz"），
    // 拼进提示既读不通（属性不是「想执行的操作」），也属二次污染。
    const hint = '你刚才使用了错误格式的工具调用，被系统拒绝。' +
      '请改用 ' + BT + BT + BT + 'cuckoo' + BT + BT + BT + ' 代码块重新执行该操作。禁止使用任何 XML / 标签 / 特殊指令语法。';
    // 同上：格式纠正立即发出，避免延迟窗口内队列被误 flush
    sendMessageToChat(hint, 'XML工具调用纠正', undefined, 0);
    return;
  }

  // 4. 普通文本回复：任务完成，退出工具循环
  // 格式正确 → 清零连续错误计数（否则跨任务累计 10 次后永久静默，真出错也不提示）
  formatHintCount = 0;
  console.log('[Cuckoo Code][拦截] 正常文本回复，未检测到工具调用');
  if (!suppressAiNotification) {
    try {
      // 传回复正文作为通知摘要（主进程截断展示），让用户一眼看到 AI 说了什么
      const summary = buildNotificationSummary(raw, 120);
      (window as any).electronAPI.showAiNotification(summary).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  // 任务空闲信号（工具循环结束 = AI 给出普通文本回复）——供自动压缩等"任务边界"逻辑使用
  emitTaskIdle();
}

// 流式增量监听器（供纯净模式实时渲染；无监听者时零开销）
const streamListeners = new Set<(ev: any) => void>();

/** 注册"流式增量"监听器（{ think, text, finished }） */
function onStream(cb: (ev: any) => void): () => void {
  streamListeners.add(cb);
  return () => streamListeners.delete(cb);
}

/** 派发流式增量（无监听者时直接返回） */
function emitStream(ev: any): void {
  if (streamListeners.size === 0) return;
  for (const cb of streamListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

// 任务空闲监听器（工具循环结束：AI 给出普通文本回复时派发；无监听者时零开销）
const taskIdleListeners = new Set<() => void>();

/** 注册"任务空闲"监听器（工具循环结束） */
function onTaskIdle(cb: () => void): () => void {
  taskIdleListeners.add(cb);
  return () => taskIdleListeners.delete(cb);
}

/** 派发"任务空闲"（无监听者时直接返回） */
function emitTaskIdle(): void {
  if (taskIdleListeners.size === 0) return;
  for (const cb of taskIdleListeners) {
    try { cb(); } catch (_) { /* ignore */ }
  }
}

// 用户停止监听器（网页原生"停止"被点；供纯净模式同步收尾；无监听者时零开销）
const userStopListeners = new Set<() => void>();

/** 注册"用户停止生成"监听器 */
function onUserStop(cb: () => void): () => void {
  userStopListeners.add(cb);
  return () => userStopListeners.delete(cb);
}

/** 派发"用户停止生成"（无监听者时直接返回） */
function emitUserStop(): void {
  if (userStopListeners.size === 0) return;
  for (const cb of userStopListeners) {
    try { cb(); } catch (_) { /* ignore */ }
  }
}

// 工具调用监听器（供纯净模式等上报工具开始/结束；无监听者时零开销）
const toolCallListeners = new Set<(ev: any) => void>();

/**
 * 注册"工具调用"监听器
 * @param cb 工具开始/结束时调用，参数 { phase: 'start'|'end', code, success?, output?, error? }
 * @returns 取消注册
 */
function onToolCall(cb: (ev: any) => void): () => void {
  toolCallListeners.add(cb);
  return () => toolCallListeners.delete(cb);
}

/** 派发工具调用事件（无监听者时直接返回） */
function emitToolCall(ev: any): void {
  if (toolCallListeners.size === 0) return;
  for (const cb of toolCallListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

// 回复完成监听器（供压缩等流程等待 AI 回复完成）
// meta 携带服务端权威数据（tokenUsage / msgIds），由监听方按需取用，
// 避免共享状态跨层（bridge 不依赖 overlay）。
const responseListeners = new Set<(text: string, meta: any) => void>();
// 失败监听器（供自动重试引擎订阅）
const errorListeners = new Set<(detail: any) => void>();

/**
 * 注册"AI 回复完成"监听器
 * @param cb 收到完成回复时调用，参数为完整文本 + meta（{ tokenUsage, msgIds }）
 * @returns 取消注册
 */
function onInterceptedResponse(cb: (text: string, meta: any) => void): () => void {
  responseListeners.add(cb);
  return () => responseListeners.delete(cb);
}

/**
 * 注册"AI 请求失败"监听器
 * @param cb 收到失败事件时调用，参数为 detail { text, status, reason, httpStatus, name }
 * @returns 取消注册
 */
function onAiError(cb: (detail: any) => void): () => void {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

/**
 * 启动拦截事件监听
 */
function startInterceptObserver(): void {
  window.addEventListener('cuckoo-ai-response', (ev: any) => {
    try {
      const detail = ev && ev.detail;
      if (!detail) return;
      // 诊断日志已移除（高频 JSON.stringify + 每回复输出，会拖慢页面/累积日志）
      // 用户主动停止：不处理，也不通知监听器（等待方按超时处理）
      if (detail.status === 'stopped') {
        console.log('[Cuckoo Code][拦截] 检测到用户停止生成，忽略该回复');
        abortRequested = false;
        try { watchdog.onResponseReceived('stopped'); } catch (_) { /* ignore */ }
        try { emitUserStop(); } catch (_) { /* ignore */ }
        return;
      }
      if (!detail.finished) return;
      try { watchdog.onResponseReceived('finished'); } catch (_) { /* ignore */ }
      // 缓存最近一次完整回复文本，供手动解析复用（不依赖 DOM）
      lastInterceptedText = detail.text || '';
      // 通知监听器（每次成功回复都触发），携带服务端权威数据
      const meta = { tokenUsage: detail.tokenUsage || null, msgIds: detail.msgIds || null };
      for (const cb of responseListeners) {
        try { cb(detail.text || '', meta); } catch (_) { /* ignore */ }
      }
      processInterceptedResponse(detail.text);
    } catch (err) {
      console.error('[Cuckoo Code][拦截] 处理回复事件出错:', err);
    }
  });
  window.addEventListener('cuckoo-ai-stream', (ev: any) => {
    try {
      if (abortRequested) return; // 用户请求中止后，丢弃残余流帧
      const detail = ev && ev.detail;
      if (!detail) return;
      emitStream({
        think: detail.think || '',
        text: detail.text || '',
        finished: !!detail.finished,
        // 透传服务端权威 token（DeepSeek）；缺失时为 undefined，下游回退估算
        accumulatedTokens: typeof detail.accumulatedTokens === 'number' ? detail.accumulatedTokens : null,
        // 发起该流的会话 ID（DeepSeek 提供）；用于丢弃切会话后的残余流帧
        sessionId: typeof detail.sessionId === 'string' ? detail.sessionId : null,
      });
    } catch (_) { /* ignore */ }
  });
  window.addEventListener('cuckoo-ai-error', (ev: any) => {
    try {
      const detail = ev && ev.detail;
      try { watchdog.onResponseReceived('error'); } catch (_) { /* ignore */ }
      for (const cb of errorListeners) {
        try { cb(detail || {}); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.error('[Cuckoo Code][拦截] 处理失败事件出错:', err);
    }
  });
  console.log('[Cuckoo Code][拦截] 已启动 cuckoo-ai-response / cuckoo-ai-error 事件监听');
}

/** 取最近一次拦截到的完整回复文本（手动解析用） */
function getLastInterceptedText(): string {
  return lastInterceptedText;
}

export { startInterceptObserver, processInterceptedResponse, processInlineMarkers, getLastInterceptedText, onInterceptedResponse, onAiError, onToolCall, onStream, onTaskIdle, onUserStop, requestAbort, clearAbort, setSuppressAiNotification, stripToolBlocks, stripInlineCodeAndQuotes };
