/**
 * JSON 工具调用识别（D11：已废除 JSON 执行模式）
 *
 * 历史上支持 AI 输出 {"toolName":"...","params":{...}} 形式的工具调用。
 * D11 决定只保留 JS（cuckoo 代码块）一种调用方式。本模块仅保留"识别"能力：
 * 检测到 JSON 工具调用时，由调用方发提示引导 AI 改用 cuckoo 代码块。
 */

// 匹配 {"toolName": 或 {"tool": 后紧跟合法 JSON 值开头
// 曾只匹配到冒号就算命中，导致正文里的伪代码举例（如 {tool: ...}）被误报。
// 真实工具调用必有值，故要求冒号后（可有空白）必须是 { [ " ' 数字 或 true/false/null。
const JSON_TOOL_CALL_RE = /\{\s*["']?tool(?:Name)?["']?\s*:\s*(?:[\{\["']|[-\d]|true\b|false\b|null\b)/;

/**
 * 判断文本是否像 JSON 工具调用（仅识别，不解析）。
 * 用于检测到旧格式时向 AI 发提示，引导其改用 cuckoo 代码块。
 *
 * 注意：只认「形如合法 JSON 对象」的片段。散文里随手写的伪代码
 * （如「参数是一个 {tool: ...} 的对象」）若值部分不合法则不命中。
 */
function looksLikeJsonToolCall(text: any): boolean {
  if (!text || typeof text !== 'string') return false;
  return JSON_TOOL_CALL_RE.test(text);
}

export { looksLikeJsonToolCall };
