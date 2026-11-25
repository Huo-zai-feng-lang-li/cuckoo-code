/**
 * cuckoo-js 单轮循环。
 *
 * 网页模型（Quick 等）不接受 native tools，只接受：
 *   模型输出 ```cuckoo 代码块
 *   → 本地 JsRunner 执行
 *   → 结果作为普通 user 消息回传
 *   → 模型继续写下一段代码/给最终回答
 *
 * 该循环不发送 tools/tool_calls，不产生 tool role；停止、切会话、超轮数都在
 * 这里统一收尾，避免把内部工具消息污染成用户气泡。
 */
import { streamChat, ApiRequestError, ApiTimeoutError } from './client.js';
import type { ApiChatMessage, ApiUsage } from './client.js';
import type { ApiConnectionPrefs, ApiToolMode } from '../app/ui-prefs.js';
import type { ContextBudget } from './context.js';
import { estimateMessageTokens } from './context.js';
import { materializeMessages } from './attachments.js';
import { executeCuckooJs } from './cuckoo-js-exec.js';
import { extractCuckooBlocks, stripCuckooBlocks, formatCuckooResult, codePreview } from './cuckoo-js.js';

export interface CuckooRuntimeOptions {
  config: any;
  connection: ApiConnectionPrefs;
  toolsEnabled: boolean;
  maxToolRounds: number;
  budget: ContextBudget;
  systemPrompt: string;
  systemKey: string;
  toolMode: ApiToolMode;
}

export interface CuckooTurnState {
  sessionId: string;
  title: string;
  createdAt: number;
  messages: ApiChatMessage[];
  controller: AbortController | null;
  projectDir: string | null;
  toolMode: ApiToolMode;
  turn: Promise<void> | null;
  pendingReset: boolean;
  systemKey: string;
  visionUnsupported: boolean;
  visionUnsupportedModel?: string;
  disposed?: boolean;
  usageTotal: ApiUsage;
}

export interface CuckooTurnHooks {
  emit: (ctx: any, payload: any) => void;
  persist: (ctx: any, state: CuckooTurnState) => void;
  trimHistory: (state: CuckooTurnState, budget: number) => void;
  uiDropped: (state: CuckooTurnState) => boolean;
}

type CuckooCode = 'stopped' | 'tools_disabled' | 'rounds_limit' | 'request_failed' | 'mode_mismatch';

export interface CuckooSendResult {
  success: boolean;
  error?: string;
  text?: string;
  code?: CuckooCode;
}

export async function runCuckooJsTurn(input: {
  ctx: any;
  state: CuckooTurnState;
  controller: AbortController;
  runtime: CuckooRuntimeOptions;
  hooks: CuckooTurnHooks;
}): Promise<CuckooSendResult> {
  const { ctx, state, controller, runtime, hooks } = input;
  const { config, connection, budget, toolsEnabled, maxToolRounds } = runtime;

  let finishTurn: () => void = () => { /* set below */ };
  const turn = new Promise<void>((resolve) => { finishTurn = resolve; });
  state.turn = turn;
  let lastVisible = '';

  try {
    for (let round = 0; round < maxToolRounds; round++) {
      if (controller.signal.aborted || hooks.uiDropped(state)) {
        return { success: false, error: '已停止', code: 'stopped' };
      }
      hooks.emit(ctx, { type: 'status', text: '模型思考中…', busy: true });

      hooks.trimHistory(state, budget.inputBudget);
      const requestMessages = await materializeMessages(
        state.messages,
        connection.vision && !state.visionUnsupported ? 8 : 0,
      );
      const roundStartedAt = Date.now();
      let lastTpsAt = 0;
      const requestOptions = {
        config,
        signal: controller.signal,
        reasoningEffort: connection.reasoningEffort,
        maxOutputTokens: budget.outputReserve,
        usageReporting: connection.usageReporting,
        conversationId: 'cuckoo-js:' + state.sessionId,
        onRetry: (retry: any) => {
          hooks.emit(ctx, {
            type: 'retry-state',
            state: retry && retry.state,
            delayMs: retry && retry.delayMs,
            is429: !!(retry && retry.is429),
            count: retry && retry.count,
          });
        },
        onText: (textSoFar: string, thinkSoFar: string) => {
          if (hooks.uiDropped(state)) return;
          const visible = stripCuckooBlocks(textSoFar);
          hooks.emit(ctx, { type: 'stream', think: thinkSoFar, text: visible, finished: false });
          const now = Date.now();
          if (now - lastTpsAt >= 600) {
            lastTpsAt = now;
            const est = estimateTokens(textSoFar) + estimateTokens(thinkSoFar);
            const sec = Math.max(0.2, (now - roundStartedAt) / 1000);
            hooks.emit(ctx, { type: 'tps', tps: Math.round((est / sec) * 10) / 10 });
          }
        },
      };

      let result;
      try {
        result = await streamChat({ ...requestOptions, messages: requestMessages });
      } catch (err: any) {
        // 视觉是尽力而为：上游 400 拒绝图片时自动降级纯文本重试一次。
        const hasImage = requestMessages.some((m) => Array.isArray(m.content)
          && m.content.some((p: any) => p && p.type === 'image_url'));
        if (Number(err && err.status) !== 400 || !hasImage) throw err;
        if (controller.signal.aborted || hooks.uiDropped(state)) {
          return { success: false, error: '已停止', code: 'stopped' };
        }
        const errDetail = String((err && err.message) || '') + ' ' + String((err && (err as any).body) || '');
        const imageRelated = /image|vision|multimodal|image_url|unknown|content/i.test(errDetail);
        if (imageRelated) {
          state.visionUnsupported = true;
          state.visionUnsupportedModel = String(config.model || '');
        }
        hooks.emit(ctx, {
          type: 'notice',
          text: imageRelated
            ? '上游网关不支持图片内容块（400），已自动去掉图片、改为纯文本重试；本次图片没有进入模型上下文。'
            : '上游拒绝带图片的请求（400），已自动去掉图片重试；未禁用后续图片输入。',
        });
        const textOnly = await materializeMessages(state.messages, 0, {
          zeroImagePlaceholder: '[图片未发送：上游网关拒绝图片输入（400），本轮对话没有图片内容，不能描述或猜测图片内容]',
        });
        result = await streamChat({ ...requestOptions, messages: textOnly });
      }

      if (controller.signal.aborted || hooks.uiDropped(state)) {
        return { success: false, error: '已停止', code: 'stopped' };
      }

      const elapsedSec = Math.max(0.2, (Date.now() - roundStartedAt) / 1000);
      const promptTokens = Number(result.usage && result.usage.prompt_tokens) || 0;
      const completionTokens = Number(result.usage && result.usage.completion_tokens) || 0;
      const tps = completionTokens > 0
        ? Math.round((completionTokens / elapsedSec) * 10) / 10
        : Math.round(((result.text || '').length / 3.5 / elapsedSec) * 10) / 10;
      const contextTokens = (promptTokens + completionTokens) > 0
        ? promptTokens + completionTokens
        : state.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
      if (result.usage) {
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          state.usageTotal[key] = (Number(state.usageTotal[key]) || 0) + (Number(result.usage[key]) || 0);
        }
      }
      hooks.emit(ctx, {
        type: 'usage',
        usage: result.usage || {},
        total: { ...state.usageTotal },
        context: contextTokens,
        tps: tps > 0 ? tps : 0,
      });

      const raw = result.text || '';
      const visible = stripCuckooBlocks(raw);
      const blocks = extractCuckooBlocks(raw);
      lastVisible = visible;

      if (blocks.length === 0) {
        // 未闭合的 cuckoo 块不会执行；也不能让原始代码回落到历史正文里。
        // stripCuckooBlocks 会把未闭合块隐藏到结尾，visible 可能为空，这时给一条
        // 明确的可见提示，避免重载后把半截代码当成普通回答显示。
        const fenceState = cuckooFenceState(raw);
        const unclosedNotice = fenceState === 'unclosed'
          ? '模型输出了未闭合的 cuckoo 代码块，已忽略且没有执行。'
          : fenceState === 'closed'
            ? '模型输出了空的 cuckoo 代码块，没有执行。'
            : '';
        const shown = visible || unclosedNotice;
        if (raw) {
          state.messages.push({ role: 'assistant', content: raw, displayText: shown || undefined });
          hooks.trimHistory(state, budget.inputBudget);
          hooks.persist(ctx, state);
        }
        if (unclosedNotice) hooks.emit(ctx, { type: 'notice', text: unclosedNotice });
        hooks.emit(ctx, { type: 'stream', think: result.think || '', text: shown, finished: true });
        hooks.emit(ctx, { type: 'assistant-done', text: shown, hasTool: false });
        hooks.emit(ctx, { type: 'status', text: '就绪', busy: false });
        hooks.emit(ctx, { type: 'task-idle' });
        return { success: true, text: shown };
      }

      // 中间轮：assistant 的原始文本必须留在模型上下文里，但 UI 不能显示代码块。
      state.messages.push({
        role: 'assistant',
        content: raw || '',
        displayText: visible || undefined,
        internal: true,
      });
      hooks.trimHistory(state, budget.inputBudget);
      hooks.persist(ctx, state);
      if (visible) hooks.emit(ctx, { type: 'assistant', text: visible, hasTool: true });

      if (!toolsEnabled) {
        const msg = '模型输出了工具代码块，但当前 API 连接的工具调用开关是关闭的。可在“API 设置”里打开。';
        hooks.emit(ctx, { type: 'notice', text: msg });
        hooks.emit(ctx, { type: 'assistant-done', text: visible || msg, hasTool: false });
        hooks.emit(ctx, { type: 'status', text: 'API 工具调用已关闭', busy: false });
        hooks.emit(ctx, { type: 'task-idle' });
        return { success: false, error: msg, code: 'tools_disabled' };
      }

      const results: string[] = [];
      for (const block of blocks) {
        if (controller.signal.aborted || hooks.uiDropped(state)) {
          return { success: false, error: '已停止', code: 'stopped' };
        }
        const preview = codePreview(block);
        hooks.emit(ctx, { type: 'tool-start', code: preview });
        const projectDir = state.projectDir
          || (ctx && ctx.sessionStore && ctx.sessionStore.state ? ctx.sessionStore.state.selectedProjectDir : null);
        const exec = await executeCuckooJs(ctx, block, projectDir || null, state.sessionId, controller.signal);
        // 执行期间用户点了新对话/关窗：结果已经产生，但不能再画到新会话里。
        if (controller.signal.aborted || hooks.uiDropped(state)) {
          return { success: false, error: '已停止', code: 'stopped' };
        }
        hooks.emit(ctx, {
          type: 'tool-end',
          success: exec.success,
          output: exec.output,
          error: exec.error || '',
          code: preview,
        });
        results.push(formatCuckooResult(exec));
      }
      // 同一轮可能有多块代码；合并成一条 user 消息，否则 3000 的续接逻辑
      // 只会把最后一条 user 结果发给 Quick，前面几块的结果会被丢掉。
      if (results.length > 0) {
        const merged = results.length === 1
          ? results[0]
          : formatCuckooResult({ success: true, output: results.join('\n\n') }, '多块执行结果：');
        state.messages.push({
          role: 'user',
          content: merged,
          internal: true,
        });
        hooks.trimHistory(state, budget.inputBudget);
        hooks.persist(ctx, state);
      }
    }

    if (hooks.uiDropped(state)) return { success: false, error: '已停止', code: 'stopped' };
    const msg = '工具调用超过最大轮数（' + maxToolRounds + '），已停止。可在“API 设置”里调大轮数（上限 500），或把任务拆小。';
    hooks.emit(ctx, { type: 'notice', text: msg });
    hooks.emit(ctx, { type: 'assistant-done', text: lastVisible || msg, hasTool: false });
    hooks.emit(ctx, { type: 'status', text: '工具轮数超限', busy: false });
    hooks.emit(ctx, { type: 'task-idle' });
    return { success: false, error: msg, code: 'rounds_limit' };
  } catch (err: any) {
    if (controller.signal.aborted || hooks.uiDropped(state)) {
      return { success: false, error: '已停止', code: 'stopped' };
    }
    const msg = formatError(err);
    hooks.emit(ctx, { type: 'notice', text: msg });
    hooks.emit(ctx, { type: 'status', text: 'API 请求失败', busy: false });
    hooks.emit(ctx, { type: 'task-idle' });
    return { success: false, error: msg, code: 'request_failed' };
  } finally {
    if (!state.disposed) {
      if (state.pendingReset) {
        state.messages = [];
        state.pendingReset = false;
      }
      hooks.persist(ctx, state);
    }
    if (state.turn === turn) state.turn = null;
    finishTurn();
    if (state.controller === controller) state.controller = null;
    hooks.emit(ctx, { type: 'ai-state', generating: false });
  }
}

function formatError(err: any): string {
  if (err instanceof ApiTimeoutError) return err.message;
  if (err instanceof ApiRequestError) return err.message;
  return 'API 请求失败：' + ((err && err.message) || String(err));
}

/** 检查 cuckoo 围栏状态；空代码块闭合算 closed，半截代码算 unclosed。 */
function cuckooFenceState(text: string): 'none' | 'closed' | 'unclosed' {
  let seen = false;
  let inBlock = false;
  let fenceLen = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!inBlock) {
      const m = line.match(/^[ \t]*(`{3,})\s*(cuckoo|cuckoo-js)\s*$/i);
      if (m) {
        seen = true;
        inBlock = true;
        fenceLen = m[1].length;
      }
      continue;
    }
    const close = line.match(/^[ \t]*(`{3,})\s*$/);
    if (close && close[1].length >= fenceLen) {
      inBlock = false;
      fenceLen = 0;
    }
  }
  if (inBlock) return 'unclosed';
  return seen ? 'closed' : 'none';
}

function estimateTokens(text: string): number {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  return Math.ceil(cjk * 1.2 + (s.length - cjk) / 4);
}
