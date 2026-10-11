/**
 * 规则扫描：项目级 + 用户级目录 → RuleMeta[]
 *
 * 目录约定（对齐 Claude Code）：
 *  - 项目级：`<projectDir>/.cuckoo/rules/*.md`
 *  - 用户级：`~/.cuckoo/rules/*.md`
 *
 * 规则：
 *  - 只扫 rules 目录的直接子目录（一层）
 *  - 同名规则不覆盖（用户级 + 项目级都保留，靠路径区分）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseRuleFrontmatter } from './frontmatter.js';
import type { RuleMeta, RuleSource } from './types.js';

/** 用户级目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserRulesDir(): string {
  const base = process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo');
  return path.join(base, 'rules');
}

type ScanCacheEntry = { signature: string; result: RuleMeta[] };
const scanCache = new Map<string, ScanCacheEntry>();

/** 只用目录/文件元数据判断规则目录是否变化，避免每次提示词构建重复读全文。 */
function directorySignature(rulesDir: string): string | null {
  let entries: fs.Dirent[];
  let dirStat: fs.Stats;
  try {
    entries = fs.readdirSync(rulesDir, { withFileTypes: true });
    dirStat = fs.statSync(rulesDir);
  } catch {
    return null;
  }
  const files: string[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    try {
      const stat = fs.statSync(path.join(rulesDir, ent.name));
      files.push(ent.name + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs);
    } catch { /* 文件在扫描期间消失，按未命中处理 */ }
  }
  files.sort();
  return dirStat.mtimeMs + ':' + dirStat.ctimeMs + '|' + files.join('|');
}

function scanDir(rulesDir: string, source: RuleSource): RuleMeta[] {
  const signature = directorySignature(rulesDir);
  if (signature === null) return [];
  const cacheKey = source + '\0' + rulesDir;
  const cached = scanCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.result;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: RuleMeta[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    const rulePath = path.join(rulesDir, ent.name);
    let raw: string;
    try {
      raw = fs.readFileSync(rulePath, 'utf-8');
    } catch {
      continue;
    }
    const { name, paths, body } = parseRuleFrontmatter(raw);
    const finalName = name || ent.name.replace(/\.md$/i, '');
    if (!finalName.trim() || !body.trim()) continue; // 无名或无正文，跳过
    result.push({ name: finalName, paths, rulePath, body: body.trim(), source });
  }
  scanCache.set(cacheKey, { signature, result });
  return result;
}

/**
 * 扫描并合并规则（项目级 + 用户级 + 插件级都保留，同名不覆盖）。
 * @param projectDir 项目根（可为 null）
 * @param extraRulesDirs 额外的 rules 目录（绝对路径）。由上层（session）计算后传入，
 *   本模块**不 import plugins**，避免形成依赖环。
 */
export function scanRules(projectDir: string | null, extraRulesDirs: string[] = []): RuleMeta[] {
  const user = scanDir(getUserRulesDir(), 'user');
  const project = projectDir ? scanDir(path.join(projectDir, '.cuckoo', 'rules'), 'project') : [];
  const plugin: RuleMeta[] = [];
  for (const dir of extraRulesDirs) {
    if (!dir) continue;
    plugin.push(...scanDir(dir, 'plugin'));
  }
  // 项目级在前（展示顺序），插件级最后（优先级最低）；同名不去重
  return [...project, ...user, ...plugin];
}

/** 只取"无 paths"的规则（初始化时注入） */
export function getUnscopedRules(rules: RuleMeta[]): RuleMeta[] {
  return rules.filter((r) => r.paths.length === 0);
}

/** 只取"有 paths"的规则（read 匹配时注入） */
export function getScopedRules(rules: RuleMeta[]): RuleMeta[] {
  return rules.filter((r) => r.paths.length > 0);
}
