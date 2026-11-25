/**
 * 最小 OpenAI 兼容流式客户端（主进程使用）。
 *
 * 只负责 HTTP/SSE，不碰 Electron view、不碰工具、不碰拟人化。
 * 429/5xx 做有限退避重试；其它 4xx 立即抛出，让 UI 显示真实错误。
 */
import { createFrameDecoder, parseSseBlock, extractOpenAiDelta } from './sse.js';
import type { OpenAiToolCallDelta } from './sse.js';
import type { ApiTransportConfig } from './config.js';

export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: any };
}

export interface ApiAttachmentRef {
  name: string;
  mime: string;
  path: string;
  size: number;
  kind: 'image' | 'text';
}

export type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'high' | 'low' } };

export interface ApiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ApiContentPart[] | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
  /** 历史里只存附件引用；请求前由 materializeMessages 转成 content parts */
  attachments?: ApiAttachmentRef[];
  /**
   * 界面展示文本（仅本地持久化/恢复 UI 用，绝不发往模型）。
   * 用户 content 里可能拼了技能/计划隐藏指令，展示时必须用这份干净文本。
   */
  displayText?: string;
  /**
   * 内部续传消息：cuckoo-js 的工具结果以 user role 回传，但不是新的用户轮次。
   * UI 历史、上下文轮次和持久化裁剪都必须跳过它。
   */
  internal?: boolean;
}

export interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: any;
}

export interface StreamChatOptions {
  config: ApiTransportConfig;
  messages: ApiChatMessage[];
  signal?: AbortSignal;
  /** 可注入 fetch，便于单测与切换 Electron net.fetch */
  fetchImpl?: typeof fetch;
  onText?: (text: string, think: string) => void;
  /** 429/5xx 重试状态（进入等待/成功/耗尽），供 harness 显示倒计时 */
  onRetry?: (state: {
    state: 'pending' | 'success' | 'exhausted';
    delayMs?: number;
    is429?: boolean;
    count?: number;
  }) => void;
  maxRetries?: number;
  /** 单次请求总超时（含等待响应头与流式 body）；默认 5 分钟 */
  timeoutMs?: number;
  /** 传给 OpenAI 兼容接口的 function calling 工具定义 */
  tools?: OpenAiTool[];
  /** 推理强度；auto/undefined 不下发（不支持该字段的网关会 400） */
  reasoningEffort?: 'auto' | 'low' | 'medium' | 'high';
  /** 单次回复最大输出 tokens */
  maxOutputTokens?: number;
  /** usage 统计：on=请求 include_usage；auto/off 不主动请求，但网关返回也解析 */
  usageReporting?: 'auto' | 'on' | 'off';
  /**
   * 网关会话 ID（cuckoo-js 用）。走 body conversation_id，让 3000 复用
   * 同一个网页会话，而不是每轮把完整上下文重新灌给 Quick。
   */
  conversationId?: string;
}

export interface StreamChatResult {
  text: string;
  think: string;
  finishReason: string | null;
  toolCalls: ApiToolCall[];
  /** 网关返回的 usage（可能不存在） */
  usage?: ApiUsage;
}

export class ApiRequestError extends Error {
  status: number;
  body: string;
  retryAfterMs: number;

  constructor(message: string, status: number, body: string, retryAfterMs = 0) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 与用户主动停止区分：超时不是取消，必须明确告诉界面 */
export class ApiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiTimeoutError';
  }
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
      }
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 退避节奏：2s / 5s / 10s，带 ±20% 抖动；429 若带 Retry-After 优先用它。
 * @param attempt 第几次重试（0 起）
 * @param retryAfterMs 服务端 Retry-After 毫秒（0=没有）
 */
export function retryDelayMs(attempt: number, retryAfterMs = 0): number {
  if (retryAfterMs > 0) return Math.max(1000, Math.min(30000, retryAfterMs));
  const base = attempt <= 0 ? 2000 : attempt === 1 ? 5000 : 10000;
  const jitter = Math.round(base * 0.2);
  return base - jitter + Math.round(Math.random() * jitter * 2);
}

/** 解析 Retry-After（秒数或 HTTP 日期）→ 毫秒 */
function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return 0;
}

/**
 * 把流式 tool_calls 分片合并成完整调用。
 * OpenAI 约定同一 index 的 id/name 只在首片出现，arguments 逐片拼接；
 * 某些网关会一次性返回完整数组，这个函数同样兼容。
 * @param current 当前已累积的调用
 * @param delta 本帧 tool_calls 分片
 */
export function mergeToolCallDelta(current: ApiToolCall[], delta: OpenAiToolCallDelta[] | null | undefined): ApiToolCall[] {
  const out = current.map((c) => ({ ...c, function: { ...c.function } }));
  if (!Array.isArray(delta)) return out;
  for (const part of delta) {
    if (!part || typeof part !== 'object') continue;
    const index = Number.isInteger(part.index) ? Number(part.index) : out.length;
    while (out.length <= index) {
      out.push({ id: 'call_' + out.length, type: 'function', function: { name: '', arguments: '' } });
    }
    const tc = out[index];
    if (typeof part.id === 'string' && part.id) tc.id = part.id;
    if (typeof part.type === 'string' && part.type) tc.type = 'function';
    const fn = part.function || {};
    if (typeof fn.name === 'string' && fn.name && !tc.function.name) tc.function.name = fn.name;
    if (typeof fn.arguments === 'string') tc.function.arguments += fn.arguments;
  }
  return out.filter((c) => c.function.name);
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    return raw.length > 4000 ? raw.slice(0, 4000) + '…' : raw;
  } catch (_) {
    return '';
  }
}

/**
 * 发起一轮流式对话。
 * @throws {ApiRequestError} HTTP 非 2xx
 * @throws {Error} 网络错误 / AbortError
 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');
  const maxRetries = Number.isFinite(opts.maxRetries as number) ? Math.max(0, opts.maxRetries as number) : 2;
  const timeoutMs = Number.isFinite(opts.timeoutMs as number) ? Math.max(1000, opts.timeoutMs as number) : 300000;

  // 用户 signal + 总超时合并成一个内部 signal；超时不能被误判成用户主动停止。
  const timeout = new AbortController();
  let timedOut = false;
  const onUserAbort = () => { try { timeout.abort(); } catch (_) { /* ignore */ } };
  if (opts.signal) {
    if (opts.signal.aborted) onUserAbort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try { timeout.abort(); } catch (_) { /* ignore */ }
  }, timeoutMs);
  const inner: StreamChatOptions = { ...opts, signal: timeout.signal };
  let retried = false;

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await once(inner, fetchImpl);
        if (retried) opts.onRetry && opts.onRetry({ state: 'success', count: attempt });
        return result;
      } catch (err: any) {
        if ((opts.signal && opts.signal.aborted) || (err && err.name === 'AbortError' && !timedOut)) throw err;
        if (timedOut) throw new ApiTimeoutError('API 请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），已停止等待');
        const status = Number(err && err.status) || 0;
        if (attempt < maxRetries && retryable(status)) {
          const delayMs = retryDelayMs(attempt, Number(err && err.retryAfterMs) || 0);
          opts.onRetry && opts.onRetry({
            state: 'pending', delayMs, is429: status === 429, count: attempt + 1,
          });
          await sleep(delayMs, timeout.signal);
          retried = true;
          continue;
        }
        if (retryable(status)) {
          opts.onRetry && opts.onRetry({
            state: 'exhausted', is429: status === 429, count: maxRetries + 1,
          });
        }
        throw err;
      }
    }
  } finally {
    clearTimeout(timer);
    if (opts.signal) {
      try { opts.signal.removeEventListener('abort', onUserAbort); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * 显式通知本地网关停止某个会话的网页回合。
 *
 * 为什么不能只 abort fetch：实测某些 Electron fetch 中断后，网关侧的 HTTP
 * close 不会及时到达，网页端仍在生成。这个独立短请求给网关一个明确的
 * conversation_id，网关可以立刻点掉网页停止按钮；失败也不影响本地 abort。
 *
 * @param config API 连接配置
 * @param conversationId 与正常 chat 请求相同的 conversation_id
 * @param opts 测试注入与超时
 * @returns 网关是否确认收到停止请求
 */
export async function cancelChatTurn(
  config: ApiTransportConfig,
  conversationId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');
  if (!conversationId) return { ok: false, reason: 'missing_conversation_id' };
  const url = new URL(config.endpoint);
  if (!/\/chat\/completions\/?$/.test(url.pathname)) {
    return { ok: false, reason: 'unsupported_endpoint' };
  }
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/chat/completions/stop');
  const timeoutMs = Number.isFinite(opts.timeoutMs as number) ? Math.max(500, opts.timeoutMs as number) : 3000;
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) { /* ignore */ } }, timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, conversation_id: conversationId }),
      signal: ac.signal,
    });
    const raw = await res.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* ignore */ }
    return {
      ok: res.ok && (!parsed || parsed.ok !== false),
      status: res.status,
      reason: parsed && parsed.reason ? String(parsed.reason) : '',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 只把模型需要的字段发出去；displayText 是本地 UI 数据，不能被上游看到。 */
function toWireMessages(messages: ApiChatMessage[]): any[] {
  return messages.map((m) => {
    const out: any = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

async function once(opts: StreamChatOptions, fetchImpl: typeof fetch): Promise<StreamChatResult> {
  const { config, messages, signal, onText } = opts;
  if (signal && signal.aborted) throw abortError();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

  const body: Record<string, any> = {
    model: config.model,
    messages: toWireMessages(messages),
    stream: true,
  };
  if (Number.isFinite(opts.maxOutputTokens as number) && (opts.maxOutputTokens as number) > 0) {
    body.max_tokens = Math.round(opts.maxOutputTokens as number);
  }
  if (opts.reasoningEffort && opts.reasoningEffort !== 'auto') {
    body.reasoning_effort = opts.reasoningEffort;
  }
  if (opts.usageReporting === 'on') {
    body.stream_options = { include_usage: true };
  }
  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  if (opts.conversationId) {
    body.conversation_id = String(opts.conversationId);
  }

  const res = await fetchImpl(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw new ApiRequestError(
      'API 请求失败（' + res.status + '）' + (body ? '：' + body : ''),
      res.status,
      body,
      retryAfterMs,
    );
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const payload: any = await res.json();
    if (payload && payload.error) {
      throw new ApiRequestError('API 返回错误：' + JSON.stringify(payload.error).slice(0, 4000), 200, JSON.stringify(payload));
    }
    const d = extractOpenAiDelta(payload);
    const text = d.text;
    const toolCalls = mergeToolCallDelta([], d.toolCalls as OpenAiToolCallDelta[]);
    if (text || d.think) onText && onText(text, d.think);
    const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : undefined;
    return { text, think: d.think, finishReason: d.finishReason, toolCalls, usage };
  }

  if (!res.body) throw new Error('API 响应没有 body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frameDecoder = createFrameDecoder();
  let text = '';
  let think = '';
  let finishReason: string | null = null;
  let toolCalls: ApiToolCall[] = [];
  let usage: ApiUsage | undefined;
  let done = false;
  // 有的网关只发 finish_reason、不发 [DONE]，并保持 SSE 长连接不关闭。
  // 若一直等 [DONE] 会把"模型已答完"误判成仍在生成（界面卡在停止键）。
  // finish_reason 到达后给一个短暂窗口收尾帧（usage/最后 delta），超时主动取消 reader。
  let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  const armFinishTimer = () => {
    if (finishTimer) return;
    finishTimer = setTimeout(() => {
      try { readerRef && readerRef.cancel(); } catch (_) { /* ignore */ }
    }, 1200);
  };

  const consume = (frames: string[]) => {
    for (const block of frames) {
      const frame = parseSseBlock(block);
      if (!frame) continue;
      if (frame.data === '[DONE]') {
        done = true;
        continue;
      }
      if (!frame.json) continue;
      if (frame.json.error) {
        throw new ApiRequestError(
          'API 返回错误：' + JSON.stringify(frame.json.error).slice(0, 4000),
          200,
          JSON.stringify(frame.json),
        );
      }
      if (frame.json.usage && typeof frame.json.usage === 'object') usage = frame.json.usage;
      const d = extractOpenAiDelta(frame.json);
      if (d.text) text += d.text;
      if (d.think) think += d.think;
      if (d.toolCalls.length) toolCalls = mergeToolCallDelta(toolCalls, d.toolCalls as OpenAiToolCallDelta[]);
      if (d.finishReason) { finishReason = d.finishReason; armFinishTimer(); }
      if (d.text || d.think) onText && onText(text, think);
    }
  };

  try {
    readerRef = reader;
    while (!done) {
      const part = await reader.read();
      if (part.done) {
        consume(frameDecoder.finish());
        break;
      }
      consume(frameDecoder.push(decoder.decode(part.value, { stream: true })));
    }
  } finally {
    if (finishTimer) clearTimeout(finishTimer);
    try { await reader.cancel(); } catch (_) { /* ignore */ }
  }

  return { text, think, finishReason, toolCalls, usage };
}
