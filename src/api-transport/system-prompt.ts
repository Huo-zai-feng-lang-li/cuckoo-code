/**
 * API 模式系统提示词。
 *
 * 复用网页模式的 prompt-builder：全局规则、项目规则、技能、用户记忆、
 * 项目介绍、MCP 说明都会进入 API 请求的 system message。
 *
 * cuckoo-js 模式走独立的 quick 模板：网页模型不接受 native tools，只接受
 * 「输出 ```cuckoo 代码块 → 本地执行 → 结果作为 user 消息回传」这一套协议。
 */
import { buildPrompt } from '../session/prompt-builder.js';

const FALLBACK = [
  '你是 Cuckoo Code，一个在用户本机运行的 AI 编程助手。',
  '需要读文件、改代码、执行命令、查资料时，必须调用提供的工具，不要凭空编造执行结果。',
  '工具通过原生 function calling 调用；不要在回复正文里输出 JSON 工具块或代码块形式的工具调用。',
  '工具结果会以 tool message 返回，你根据结果继续完成任务；任务完成后再给用户简洁的最终答复。',
].join('\n');

const CUCKOO_FALLBACK = [
  '你是 Cuckoo Code 的编码代理，在用户本地项目里完成真实的软件工程任务。',
  '需要工具时，输出一个 ```cuckoo 代码块；代码块里是 async 函数体，可以直接写顶层 await。',
  '示例：',
  '```cuckoo',
  'const out = await bash("dir");',
  'log(out);',
  '```',
  '可用工具：bash(command, options)、pwsh(command, options)、read(filePath, options)、readLines(filePath, options)、write(filePath, content)、edit(filePath, oldString, newString, replaceAll?, dryRun?)、glob(pattern, searchPath?)、grep(pattern, options)、todoWrite(todos)、mcpListServers()、mcpGetTools(server)、mcpCall(server, tool, args?)。',
  '工具结果会作为普通用户消息发回；看到结果后继续写下一个代码块，直到不需要工具。',
  '不要输出 JSON tool_calls、<tool_call>，也不要说无法访问本地文件。',
  '修改前先读文件，改完跑测试；最终回答不要放在 cuckoo 块里。',
].join('\n');

const MAX_QUICK_PROMPT_CHARS = 16000;

/**
 * 构建 native API 会话的系统提示词。
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

/**
 * 构建 cuckoo-js 会话的系统提示词。
 *
 * quick 模板只保留工具协议、项目规则、技能索引、记忆摘要和 MCP 章节；自定义
 * 指令截到 1600 字符。整体预算 16000 字符，避免把网关头段窗口挤爆、
 * 导致 bash/MCP 签名被裁掉。
 * @param opts selectedDir=项目目录；customSystemPrompt=用户在 API 设置里填的额外指令
 */
export function buildCuckooApiSystemPrompt(opts: { selectedDir: string; customSystemPrompt?: string }): string {
  const selectedDir = String(opts.selectedDir || process.cwd());
  const custom = typeof opts.customSystemPrompt === 'string'
    ? opts.customSystemPrompt.trim().slice(0, 1600)
    : '';
  try {
    const r = buildPrompt({
      providerId: 'quick',
      selectedDir,
      customSystemPrompt: custom,
      compact: true,
    });
    if (r.prompt) return clipQuickPrompt(r.prompt);
  } catch (err: any) {
    console.warn('[Cuckoo API] cuckoo-js 提示词构建失败，使用兜底:', err && err.message ? err.message : String(err));
  }
  const fallback = CUCKOO_FALLBACK + '\n\n当前项目目录：`' + selectedDir + '`';
  return clipQuickPrompt(fallback + (custom ? '\n\n## 自定义指令\n' + custom : ''));
}

/**
 * 网关会保留头 12000 + 尾 16000；quick 模板必须整体落在头段，
 * 否则工具签名会被裁掉。这里按行截断并留下明确日志。
 */
function clipQuickPrompt(prompt: string): string {
  const text = String(prompt || '');
  if (text.length <= MAX_QUICK_PROMPT_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_QUICK_PROMPT_CHARS - 80);
  const kept = text.slice(0, cut > 0 ? cut : MAX_QUICK_PROMPT_CHARS - 80);
  console.warn('[Cuckoo API] cuckoo-js 提示词超过 ' + MAX_QUICK_PROMPT_CHARS + ' 字符，已截断尾部:', text.length);
  return kept + '\n\n（提示词过长，尾部已截断；需要项目规则请直接 read 对应文件）';
}
