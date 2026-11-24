/**
 * API 上下文预算：按 token 而不是固定条数裁剪历史。
 *
 * 不同厂商/Key 的 contextWindow 不一样（128K/256K/512K），
 * 固定 24 条历史在长任务里会丢前文，或在小窗口模型上直接 400。
 */
import type { ApiChatMessage } from './client.js';

/** 单条图片按 high detail 的保守估算（1568 长边约 1k~1.5k tokens） */
const IMAGE_TOKENS = 1400;
/** 每条消息的 role/分隔符开销 */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * 估算一段文本的 token 数。
 * 中文/全角按 1.2 token/字，英文/数字按 3.5 字符/token，故意偏保守。
 * @param text 文本（非字符串返回 0）
 */
export function estimateTokens(text: any): number {
  if (typeof text !== 'string' || !text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x2e80 || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else if (code >= 0x20) ascii++;
  }
  return Math.ceil(cjk * 1.2 + ascii / 3.5);
}

/** 估算任意 JSON 结构（工具定义/arguments） */
export function estimateJsonTokens(value: any): number {
  try { return estimateTokens(JSON.stringify(value || {})); } catch (_) { return 0; }
}

/**
 * 估算一条消息的 token，包含 content、tool_calls 和图片。
 * @param message OpenAI 兼容消息
 */
export function estimateMessageTokens(message: ApiChatMessage): number {
  if (!message || typeof message !== 'object') return MESSAGE_OVERHEAD_TOKENS;
  let total = MESSAGE_OVERHEAD_TOKENS;
  const content: any = message.content;
  if (typeof content === 'string') {
    total += estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') total += estimateTokens(part.text);
      else if (part.type === 'image_url') total += IMAGE_TOKENS;
    }
  }
  if (Array.isArray(message.tool_calls)) total += estimateJsonTokens(message.tool_calls);
  if (Array.isArray(message.attachments)) {
    for (const a of message.attachments) {
      if (!a) continue;
      if (a.kind === 'image') total += IMAGE_TOKENS;
      // 文本附件在请求前会被读成最多 20k 字符塞进 content；只算图片会让长文本附件
      // 绕过预算，materialize 后直接超上下文。按 UTF-8 字节数保守估算。
      else if (a.kind === 'text') total += Math.ceil(Math.min(Number(a.size) || 0, 60000) / 2);
    }
  }
  return total;
}

export interface ContextBudget {
  /** 可留给 messages 的输入 token */
  inputBudget: number;
  /** 给模型输出保留的 token */
  outputReserve: number;
  /** 工具定义占用的 token */
  toolsTokens: number;
  safetyTokens: number;
}

/**
 * 计算输入预算。至少保留 512 token，避免小窗口模型算出负数。
 * @param opts contextWindow/maxOutputTokens/toolsTokens
 */
export function resolveContextBudget(opts: {
  contextWindow: number;
  maxOutputTokens: number;
  toolsTokens?: number;
}): ContextBudget {
  const total = Number.isFinite(opts.contextWindow) ? Math.max(1024, Math.round(opts.contextWindow)) : 131072;
  const requestedOutput = Number.isFinite(opts.maxOutputTokens)
    ? Math.max(256, Math.round(opts.maxOutputTokens))
    : 8192;
  const toolsTokens = Math.max(0, Math.round(Number(opts.toolsTokens) || 0));
  const safetyTokens = 1024;
  // 输出预留不能把输入挤成负数；小窗口下主动压低 max_tokens，避免请求总量
  // 超过厂商 contextWindow 被上游直接 400。
  const maxAffordableOutput = Math.max(256, total - toolsTokens - safetyTokens - 512);
  const outputReserve = Math.min(requestedOutput, maxAffordableOutput);
  return {
    inputBudget: Math.max(512, total - outputReserve - toolsTokens - safetyTokens),
    outputReserve,
    toolsTokens,
    safetyTokens,
  };
}

function cost(messages: ApiChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** 从 user 边界开始把消息切成轮次，保证 assistant(tool_calls) 与 tool 不被切开 */
function splitTurns(messages: ApiChatMessage[]): ApiChatMessage[][] {
  const turns: ApiChatMessage[][] = [];
  let current: ApiChatMessage[] | null = null;
  for (const m of messages) {
    if (m && m.role === 'user') {
      current = [m];
      turns.push(current);
    } else if (current) {
      current.push(m);
    }
  }
  return turns;
}

/**
 * 预算极小时截断最新用户消息。
 * 只保留一条 user：assistant(tool_calls) 与 tool 结果必须成对出现，预算放不下时
 * 整段丢弃比保留半截更安全（否则下一次请求会因孤儿 tool 消息 400）。
 */
function truncateLatestTurn(turn: ApiChatMessage[], budget: number): ApiChatMessage[] {
  const first = turn[0];
  if (!first || first.role !== 'user') return [];
  const content: any = first.content;
  const source = typeof content === 'string' ? content
    : Array.isArray(content)
      ? content.filter((p: any) => p && p.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n')
      : '';
  const marker = budget < 80 ? '…' : '\n\n…（消息过长，已按上下文预算截断）';
  if (!source) {
    return [{ ...first, content: '…（附件已因上下文预算省略）', attachments: undefined }];
  }
  let maxChars = Math.max(8, Math.floor(budget));
  let text = source.slice(0, maxChars);
  // 中文 1.2 token/字，循环收缩到 marker + 正文能落进预算
  while (estimateTokens(text + marker) > budget && maxChars > 8) {
    maxChars = Math.max(8, Math.floor(maxChars * 0.8));
    text = source.slice(0, maxChars);
  }
  return [{ ...first, content: text + marker, attachments: undefined }];
}

/**
 * 按 token 预算裁剪历史：保留 system + 最近能放下的若干完整轮次。
 * @param messages 完整历史（system 可选在首位）
 * @param budget 输入 token 预算（由 resolveContextBudget 得到）
 * @returns 可直接发给网关的新数组
 */
export function trimMessagesToBudget(messages: ApiChatMessage[], budget: number): ApiChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const system = messages[0] && messages[0].role === 'system' ? messages[0] : null;
  const body = system ? messages.slice(1) : messages;
  const totalCost = cost(messages);
  if (totalCost <= budget) return messages.slice();

  let remaining = Math.max(0, budget - (system ? estimateMessageTokens(system) : 0));
  const turns = splitTurns(body);
  const selected: ApiChatMessage[][] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnCost = cost(turns[i]);
    if (turnCost > remaining) break;
    selected.unshift(turns[i]);
    remaining -= turnCost;
  }

  let picked: ApiChatMessage[] = ([] as ApiChatMessage[]).concat(...selected);
  if (picked.length === 0 && turns.length > 0) {
    picked = truncateLatestTurn(turns[turns.length - 1], Math.max(64, remaining));
  }
  const out = system ? [system, ...picked] : picked;
  return out.length ? out : messages.slice(-1);
}
