'use strict';
/**
 * cuckoo-js 协议解析。
 *
 * 网页模型只输出 ```cuckoo 代码块；这里负责提取、从可见正文中剥离，
 * 以及把执行结果包成一条普通 user 消息。纯函数，不依赖 Electron。
 */

const CUCKOO_LANGS = new Set(['cuckoo', 'cuckoo-js']);
const FENCE_RE = /^(`{3,})([A-Za-z0-9_-]*)\s*$/;

/**
 * 提取所有已闭合的 ```cuckoo 代码块。
 * 未闭合的块不返回，避免执行半截脚本。
 * @param {string} text 模型完整回复
 * @returns {string[]} 代码块内容（已 trim）
 */
export function extractCuckooBlocks(text: string): string[] {
  const lines = String(text || '').split(/\r?\n/);
  const blocks: string[] = [];
  let inBlock = false;
  let fenceLen = 0;
  let buf: string[] = [];

  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(FENCE_RE);
      if (!m) continue;
      const lang = m[2].toLowerCase();
      if (CUCKOO_LANGS.has(lang)) {
        inBlock = true;
        fenceLen = m[1].length;
        buf = [];
      }
      continue;
    }
    const close = line.match(/^(`{3,})\s*$/);
    if (close && close[1].length >= fenceLen) {
      const code = buf.join('\n').trim();
      if (code) blocks.push(code);
      inBlock = false;
      fenceLen = 0;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  return blocks;
}

/**
 * 从模型回复里移除 cuckoo 代码块，只留可见正文。
 * 普通代码块（js、json 等）原样保留；未闭合的 cuckoo 块会一直隐藏到结尾，
 * 避免流式输出时把半截工具代码闪给用户。
 * @param {string} text 模型完整/累计回复
 * @returns {string} 可见正文
 */
export function stripCuckooBlocks(text: string): string {
  const lines = String(text || '').split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  let fenceLen = 0;

  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(FENCE_RE);
      if (m && CUCKOO_LANGS.has(m[2].toLowerCase())) {
        inBlock = true;
        fenceLen = m[1].length;
        continue;
      }
      out.push(line);
      continue;
    }
    const close = line.match(/^(`{3,})\s*$/);
    if (close && close[1].length >= fenceLen) {
      // 一块只留一个空行，保持前后文可读，不把整段工具代码漏出去。
      out.push('');
      inBlock = false;
      fenceLen = 0;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 把本地执行结果包成普通 user 消息。随机前缀让模型不会把结果误当成
 * 自己上一轮的 assistant 文本，也降低网页端「重复上下文」的机械感。
 * @param {{success:boolean, output?:string, error?:string}} result
 * @param {string} [prefix] 测试/自定义前缀；不传则随机
 * @returns {string}
 */
export function formatCuckooResult(
  result: { success: boolean; output?: string; error?: string },
  prefix?: string,
): string {
  const picked = prefix || pickPrefix();
  const body = result && result.success
    ? String(result.output || '(无输出)')
    : 'ERROR: ' + String((result && result.error) || '工具执行失败');
  return picked + '\n' + clipMiddle(body, 12000);
}

/**
 * 工具卡片的单行预览。
 * @param {string} code
 * @returns {string}
 */
export function codePreview(code: string): string {
  return String(code || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function pickPrefix(): string {
  const prefixes = [
    '跑完了，结果：',
    '执行完了，结果：',
    '做完了，结果：',
    '处理完了，结果：',
  ];
  return prefixes[Math.floor(Math.random() * prefixes.length)];
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.45);
  const tail = max - head - 24;
  return text.slice(0, head) + '\n...[结果过长，已截断]...\n' + text.slice(-tail);
}
