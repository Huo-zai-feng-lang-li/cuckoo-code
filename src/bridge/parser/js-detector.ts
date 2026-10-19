/**
 * JS 工具脚本检测与代码块提取
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
// ========== JS 工具脚本检测与执行 ==========

// 反引号与围栏（共享常量，见 infra/markdown）
import { BT, FENCE } from '../../infra/markdown.js';

// 工具调用特征：必须出现 "await 工具函数名(" 形式的调用（防止 fs.readFile 等普通示例误判）
const JS_TOOL_CALL_RE = /\bawait\s+(?:read|readLines|write|edit|glob|grep|todoWrite|bash|pwsh|deleteFile|webFetch|mysql|mcpCall|mcpListServers|mcpGetTools|openBrowserWindow|injectJS|attachFile)\s*\(/;
/**
 * 判断一段 JS 代码是否调用了工具函数
 */
function looksLikeIncompleteCodeError(error: any): boolean {
  if (!error || typeof error !== 'string') return false;
  return /SyntaxError|Missing initializer|Unexpected end of input|Unexpected token|Unexpected identifier|Unexpected reserved word|Invalid or unexpected token/i.test(error);
}

function looksLikeToolScript(code: any): boolean {
  const c = code || '';
  // 1. 内置工具白名单：await write( 等
  if (JS_TOOL_CALL_RE.test(c)) return true;
  // 2. MCP 工具：await mcpXxx(（MCP server 工具名动态，无法进白名单，按 mcp 前缀识别）
  if (/\bawait\s+mcp[A-Za-z_$][\w$]*\s*\(/.test(c)) return true;
  // 3. Cuckoo 输出封装：log(await xxx( ...（log 包裹的任意工具调用，含 MCP）
  if (/\blog\s*\(\s*await\s+[A-Za-z_$][\w$]*\s*\(/.test(c)) return true;
  return false;
}

/**
 * 从一段工具脚本里提取首个工具函数名（供远程控制显示"正在执行：bash"）。
 *
 * 只用于**展示**，不做执行决策，因此容错优先：
 * 找不到返回空串，调用方退化为通用文案。
 * 识别优先级与 looksLikeToolScript 一致：内置白名单 → mcp 前缀 → log(await xxx( 包裹。
 */
function extractFirstToolName(code: any): string {
  const c = code || '';
  // 1. 内置工具白名单（与 JS_TOOL_CALL_RE 同一组名字）
  const builtin = /\bawait\s+(readLines|read|write|edit|glob|grep|todoWrite|bash|pwsh|deleteFile|webFetch|mysql|mcpCall|mcpListServers|mcpGetTools|openBrowserWindow|injectJS|attachFile|runAgent|runAgents|goalDone|nameConversation|remember|forgetMemory|createSnapshot|listSnapshots|restoreSnapshot)\s*\(/.exec(c);
  if (builtin) return builtin[1];
  // 2. MCP 工具（mcpXxx）
  const mcp = /\bawait\s+(mcp[A-Za-z_$][\w$]*)\s*\(/.exec(c);
  if (mcp) return mcp[1];
  // 3. log(await xxx( 包裹
  const wrapped = /\blog\s*\(\s*await\s+([A-Za-z_$][\w$]*)\s*\(/.exec(c);
  if (wrapped) return wrapped[1];
  return '';
}

/**
 * 判断原始文本去掉所有围栏代码块后是否只剩空白（整条回复只包含代码块）
 */
function hasOnlyFences(text: any): boolean {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split(String.fromCharCode(10));
  const rest: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(FENCE)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) rest.push(t);
  }
  return rest.join(' ').trim() === '';
}

/**
 * 统计一行 trim 后开头连续反引号的数量；不足 3 个返回 0（不是围栏）。
 * 用字符码判定避免正则里转义反引号。Markdown 围栏允许 3 个及以上反引号。
 */
function leadingFenceLen(line: string): number {
  let n = 0;
  const len = line.length;
  while (n < len && line.charCodeAt(n) === 96) n++;
  return n >= 3 ? n : 0;
}

/**
 * 从原始文本（含 Markdown 围栏）中提取 JS 工具代码块
 * 规则：
 * - cuckoo 代码块：一律视为工具脚本
 * - js / javascript 代码块：仅当整条回复只包含代码块、且代码调用了工具函数时才视为工具脚本
 *   （避免把正常回答里的示例代码误当作工具脚本执行）
 *
 * 边界处理：
 * - B-008：围栏反引号数量可变（``` 或 ```` 等），按实际开围栏长度截取 lang，闭合围栏
 *   反引号数需 >= 开围栏数（Markdown 规则）。
 * - B-004：流结束时仍未闭合的围栏 = 流式截断，其内部是残缺代码，一律丢弃、不提取执行。
 */
function extractJsToolBlocks(text: any): string[] {
  const blocks: string[] = [];
  if (!text || typeof text !== 'string') return blocks;

  const onlyFences = hasOnlyFences(text);

  const lines = text.split(String.fromCharCode(10));
  let inBlock = false;
  let lang = '';
  let openFenceLen = 0;
  let buf: string[] = [];

  // closed=false 表示是 EOF 截断的未闭合块（B-004），残缺代码不提取
  const flush = (closed: boolean) => {
    const code = buf.join(String.fromCharCode(10)).trim();
    const l = (lang || '').toLowerCase();
    if (code && closed) {
      if (l === 'cuckoo') {
        blocks.push(code);
      } else if ((l === 'js' || l === 'javascript') && onlyFences && looksLikeToolScript(code)) {
        blocks.push(code);
      }
    }
    inBlock = false;
    lang = '';
    buf = [];
    openFenceLen = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inBlock) {
      const n = leadingFenceLen(trimmed);
      if (n >= 3) {
        lang = (trimmed.slice(n) || '').split(' ')[0];
        inBlock = true;
        openFenceLen = n;
        buf = [];
      }
      continue;
    }
    // 闭合围栏：反引号数 >= 开围栏数（Markdown 规则），避免块内 ``` 示例提前闭合
    if (leadingFenceLen(trimmed) >= openFenceLen) {
      flush(true);
      continue;
    }
    buf.push(line.replace(String.fromCharCode(13), ''));
  }
  // B-004：流结束仍未闭合 → 截断块，丢弃（不提取残缺代码执行）
  if (inBlock) flush(false);
  return blocks;
}

export {
  BT,
  FENCE,
  JS_TOOL_CALL_RE,
  looksLikeIncompleteCodeError,
  looksLikeToolScript,
  hasOnlyFences,
  extractJsToolBlocks,
  extractFirstToolName,
};
