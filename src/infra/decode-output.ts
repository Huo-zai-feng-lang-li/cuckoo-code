/**
 * 命令输出智能解码
 * 中文 Windows 上控制台默认代码页是 GBK（cp936），而 Node 的 exec 默认按 UTF-8 解码，
 * 导致 PowerShell/cmd 输出的中文变成 "�"。
 * 策略：先严格按 UTF-8 解码（fatal）；抛错才说明字节流不是合法 UTF-8，
 * 回退按 GBK 解码。
 */

// ANSI 转义序列（彩色/光标控制）。命令输出常带这些控制码，
// 在纯文本预览里会显示为 "[90m"、"esc[0m" 等乱码。分三类剥离：
//   CSI：\x1b[ + 参数字节 + 终止字母（如 \x1b[31m、\x1b[2K）
//   OSC：\x1b] + 内容 + BEL(\x07) 或 ST(\x1b\\)（如设置窗口标题）
//   单字符转义：\x1b + 单个字符（如 \x1bM）
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE = /\x1b[@-Z\\-_]/g;

/**
 * 剥离文本中的 ANSI 转义序列（彩色/光标控制码）。
 * @param text - 可能含 ANSI 控制码的文本
 * @returns 剥离后的纯文本
 */
function stripAnsi(text: string): string {
  if (!text || text.indexOf('\x1b') === -1) return text;
  return text.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_SINGLE, '');
}

/**
 * 解码 exec 输出的原始字节，并剥离 ANSI 控制码。
 * @param buf - exec 输出的原始字节（可能为空/null）
 * @returns 解码后的纯文本
 */
function decodeOutput(buf: Buffer | null | undefined): string {
  if (!buf || buf.length === 0) return '';
  // A-010：用「严格 UTF-8 解码是否抛错」判定编码，而不是看结果里有没有 U+FFFD——
  // 合法 UTF-8 输出本身就可能含替换符（文件里写了 �），旧逻辑会误判为 GBK 再解一遍，
  // 乱码反而加重。
  let isUtf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    isUtf8 = false;
  }
  if (!isUtf8) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if (!gbk.includes('�')) return stripAnsi(gbk);
    } catch (e) {
      // TextDecoder 不支持 gbk 的环境，退回 UTF-8 结果
    }
  }
  return stripAnsi(buf.toString('utf8'));
}

/**
 * A-011：把命令里「调用位」的 Get-Content 替换为 Get-Content -Encoding UTF8，
 * 但**不动字符串字面量内部**的 Get-Content（旧实现全局 replace 会把
 * `'请执行 Get-Content 查看日志'` 这类引号内文本也改掉，命令行为被篡改）。
 * 逐字符扫描跟踪 PowerShell 单/双引号状态，仅在引号外做替换。
 */
function injectUtf8OutsideQuotes(command: string): string {
  const KEY = 'Get-Content';
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < command.length) {
    const ch = command[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      // PowerShell 双引号内 ` 为转义符，吞掉下一个字符
      if (ch === '`' && i + 1 < command.length) {
        out += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    // 引号外：匹配 Get-Content 且后接词边界（与原 /Get-Content\b/g 语义一致）
    if (command.startsWith(KEY, i)) {
      const next = command[i + KEY.length];
      if (next === undefined || !/[\w-]/.test(next)) {
        out += KEY + ' -Encoding UTF8';
        i += KEY.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 修正 AI 生成的 PowerShell 命令的编码问题：
 * Windows PowerShell 5.1 的 Get-Content 默认按 GBK（ANSI）读取文件，导致 UTF-8 文件中文乱码
 * （表现为"绛夊緟鏂"这类字符）。若命令调用 powershell/pwsh 且包含 Get-Content，
 * 自动注入 -Encoding UTF8（已带 -Encoding 的命令不动；引号内的 Get-Content 不动）。
 * @param command - 原始命令
 * @returns 修正后的命令
 */
function normalizeCommand(command: string): string {
  if (typeof command !== 'string' || !command) return command;
  const trimmed = command.trim();
  // 仅处理 powershell / pwsh 调用
  if (!/^(powershell|pwsh)(\.exe)?(\s|$)/i.test(trimmed)) return command;
  if (!trimmed.includes('Get-Content')) return command;
  // 已显式指定编码的命令不动
  if (/-Encoding\s+/i.test(trimmed)) return command;
  return injectUtf8OutsideQuotes(command);
}

export { decodeOutput, normalizeCommand, stripAnsi };
