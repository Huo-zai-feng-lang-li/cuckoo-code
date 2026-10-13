/**
 * 解析规则 frontmatter。支持两种生态的写法：
 *
 * ① Cuckoo 原生（paths 数组）：
 *      paths: 后接 - "src/api/**" 列表，或 paths: ["src/api/**"] 单行数组
 *
 * ② Cursor 风格（trigger + globs）——无 paths 时自动兼容：
 *      trigger: glob 且 globs 为逗号分隔的路径模式
 *      trigger: always_on 表示始终注入（paths 为空）
 *
 * 优先级：有 paths 用 paths；否则用 globs；都没有则始终注入。
 */
import { parseFrontmatter } from '../skills/frontmatter.js';

/** 从 markdown 原文提取规则 frontmatter（含 paths 数组） */
export function parseRuleFrontmatter(content: string): { name: string; paths: string[]; body: string } {
  // 先用通用解析拿 key:value（name 在这里）
  const { data, body } = parseFrontmatter(content);
  const name = (data.name || '').trim();

  // 优先 Cuckoo 原生 paths
  let paths = parsePaths(content);
  // 无 paths → 兼容 Cursor 的 trigger/globs
  if (paths.length === 0) paths = parseCursorGlobs(content);

  return { name, paths, body };
}

/**
 * 解析 Cursor 风格 frontmatter：trigger + globs → paths 数组。
 * - trigger: always_on → 始终注入（返回空数组）
 * - 其余有 globs 时：按逗号拆分，过滤掉"等于 * / ** / **"的项（那是"全部"语义，等于始终注入）
 */
function parseCursorGlobs(content: string): string[] {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return [];
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx === -1) return [];
  const fmText = text.slice(4, endIdx);

  let trigger = '';
  let globsRaw = '';
  for (const line of fmText.split('\n')) {
    const t = line.trim();
    const tm = t.match(/^trigger\s*:\s*(.+)$/);
    if (tm) { trigger = stripQuotes(tm[1].trim()); continue; }
    const gm = t.match(/^globs\s*:\s*(.+)$/);
    if (gm) { globsRaw = stripQuotes(gm[1].trim()); continue; }
  }

  // always_on → 无 paths（始终注入）
  if (trigger === 'always_on') return [];
  if (!globsRaw) return [];

  // 逗号分隔 → 拆分为多条路径，过滤"全部"语义项
  return globsRaw
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s && s !== '*' && s !== '**' && s !== '**/*');
}

/** 从原文的 frontmatter 块中提取 paths 数组 */
function parsePaths(content: string): string[] {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return [];
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx === -1) return [];
  const fmText = text.slice(4, endIdx);

  const lines = fmText.split('\n');
  const out: string[] = [];
  let inPaths = false;
  let baseIndent = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    // 进入 paths 块：`paths:` 或 `paths: [ ... ]`
    const m = trimmed.match(/^paths\s*:\s*(.*)$/);
    if (m) {
      const inline = m[1].trim();
      if (inline.startsWith('[')) {
        // 单行数组：["a", "b"]
        const items = inline.replace(/^\[/, '').replace(/\]$/, '').split(',');
        for (const it of items) {
          const v = stripQuotes(it.trim());
          if (v) out.push(v);
        }
        inPaths = false;
      } else if (inline) {
        // paths: xxx （单个值）
        const v = stripQuotes(inline);
        if (v) out.push(v);
        inPaths = false;
      } else {
        inPaths = true;
        baseIndent = line.length - line.trimStart().length;
      }
      continue;
    }

    if (inPaths) {
      const indent = line.length - line.trimStart().length;
      // 缩进回到 <= baseIndent（新顶层键）→ 退出 paths
      if (trimmed && indent <= baseIndent) { inPaths = false; }
      else if (trimmed.startsWith('-')) {
        const v = stripQuotes(trimmed.slice(1).trim());
        if (v) out.push(v);
        continue;
      } else if (trimmed) {
        inPaths = false;
      }
    }
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const f = v[0], l = v[v.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return v.slice(1, -1);
  }
  return v;
}
