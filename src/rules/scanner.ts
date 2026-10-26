/**
 * 规则扫描：项目级 + 用户级目录 → RuleMeta[]
 *
 * 目录约定：
 *  - 项目级：`<projectDir>/.agents/rules/*.md`（多 AI 工具统一入口，不回退旧路径）
 *  - 用户级：`~/.agents/rules/*.md`
 *
 * 规则：
 *  - 只扫 rules 目录的直接子目录（一层）
 *  - 同名规则不覆盖（用户级 + 项目级都保留，靠路径区分）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseRuleFrontmatter } from './frontmatter.js';
import { isWorkspaceTrusted } from '../infra/workspace-trust.js';
import type { RuleMeta, RuleSource } from './types.js';

/** 用户级目录（统一为 ~/.agents/rules，可用 CUCKOO_HOME 覆盖，供测试隔离） */
export function getUserRulesDir(): string {
  const override = process.env.CUCKOO_HOME;
  if (override) {
    const agentsRules = path.join(override, '.agents', 'rules');
    if (fs.existsSync(agentsRules)) return agentsRules;
    const directRules = path.join(override, 'rules');
    if (fs.existsSync(directRules)) return directRules;
    return directRules;
  }
  return path.join(os.homedir(), '.agents', 'rules');
}

function scanDir(rulesDir: string, source: RuleSource): RuleMeta[] {
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
  return result;
}

/**
 * 扫描项目级规则目录：统一为 `<projectDir>/.agents/rules/`（不回退旧路径）。
 */
function scanProjectRules(projectDir: string): RuleMeta[] {
  return scanDir(path.join(projectDir, '.agents', 'rules'), 'project');
}

/**
 * 扫描并合并规则（项目级 + 用户级 + 插件级都保留，同名不覆盖）。
 * @param projectDir 项目根（可为 null）
 * @param extraRulesDirs 额外的 rules 目录（绝对路径）。由上层（session）计算后传入，
 *   本模块**不 import plugins**，避免形成依赖环。
 *
 * D-004（prompt injection 数据层兜底）：当 projectDir 存在但工作区未被信任时，
 * 不扫描/不返回项目级规则。所有消费方（prompt-builder、list-skills IPC、JsRunner 按路径
 * 注入 scoped 规则、harness 等）自动获得过滤，不依赖各入口自觉调用。用户级/插件级不受影响。
 */
export function scanRules(projectDir: string | null, extraRulesDirs: string[] = []): RuleMeta[] {
  const user = scanDir(getUserRulesDir(), 'user');
  const project = projectDir && isWorkspaceTrusted(projectDir)
    ? scanProjectRules(projectDir)
    : [];
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
