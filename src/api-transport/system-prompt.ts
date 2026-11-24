/**
 * API 模式系统提示词。
 *
 * 复用网页模式的 prompt-builder：全局规则、项目规则、技能、用户记忆、
 * 项目介绍、MCP 说明都会进入 API 请求的 system message。
 */
import { buildPrompt } from '../session/prompt-builder.js';

const FALLBACK = [
  '你是 Cuckoo Code，一个在用户本机运行的 AI 编程助手。',
  '需要读文件、改代码、执行命令、查资料时，必须调用提供的工具，不要凭空编造执行结果。',
  '工具通过原生 function calling 调用；不要在回复正文里输出 JSON 工具块或代码块形式的工具调用。',
  '工具结果会以 tool message 返回，你根据结果继续完成任务；任务完成后再给用户简洁的最终答复。',
].join('\n');

/**
 * 构建 API 会话的系统提示词。
 * @param opts selectedDir=项目目录；customSystemPrompt=用户在 API 设置里填的额外指令
 */
export function buildApiSystemPrompt(opts: { selectedDir: string; customSystemPrompt?: string }): string {
  const selectedDir = String(opts.selectedDir || process.cwd());
  const custom = typeof opts.customSystemPrompt === 'string' ? opts.customSystemPrompt.trim() : '';
  try {
    const r = buildPrompt({
      providerId: 'api-key',
      selectedDir,
      customSystemPrompt: custom,
    });
    if (r.prompt) return r.prompt;
  } catch (err: any) {
    console.warn('[Cuckoo API] 系统提示词构建失败，使用兜底:', err && err.message ? err.message : String(err));
  }
  return FALLBACK + (custom ? '\n\n## 自定义指令\n' + custom : '');
}
