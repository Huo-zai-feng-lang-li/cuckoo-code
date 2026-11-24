/**
 * API transport 的 SSE 工具。
 *
 * 复用 hook 侧的纯函数解码器（不依赖运行时），并在这里补一个 OpenAI
 * chat.completion.chunk 的 delta 提取器，避免网页 hook 与主进程各写一套。
 */
export {
  createFrameDecoder,
  parseSseBlock,
} from '../providers/hooks/shared/sse.js';
export type { ParsedSseFrame } from '../providers/hooks/shared/sse.js';

export interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAiDelta {
  text: string;
  think: string;
  finishReason: string | null;
  toolCalls: OpenAiToolCallDelta[];
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * 从 OpenAI 兼容响应里取正文/思考/结束原因/工具调用。
 * 同时兼容：
 * - 流式 chunk：choices[0].delta.content / reasoning_content / tool_calls
 * - 服务端忽略 stream 的非流式：choices[0].message.content / tool_calls
 */
export function extractOpenAiDelta(payload: any): OpenAiDelta {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const source = (choice && (choice.delta || choice.message)) || {};
  const text = contentText(source.content);
  const think = typeof source.reasoning_content === 'string' ? source.reasoning_content : '';
  const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const toolCalls = Array.isArray(source.tool_calls) ? source.tool_calls : [];
  return { text, think, finishReason, toolCalls };
}
