/**
 * 技能扫描：项目级 + 用户级目录 → SkillMeta[]
 *
 * 目录约定（对齐 Claude Code）：
 *  - 项目级：`<projectDir>/.cuckoo/skills/<name>/SKILL.md`
 *  - 用户级：`~/.cuckoo/skills/<name>/SKILL.md`
 *
 * 规则：
 *  - 只扫 skills 目录的**直接子目录**（一层），不递归
 *  - 每个子目录里的 SKILL.md 必须存在
 *  - 同名时项目级优先
 *  - 宽容：name 缺省取目录名，description 缺省取正文首段；YAML 解析失败则跳过
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseFrontmatter } from './frontmatter.js';
import { isWorkspaceTrusted } from '../infra/workspace-trust.js';
import type { SkillMeta, SkillSource } from './types.js';

/** 从正文取首段（非空、非标题行）作为缺省 description */
function firstParagraph(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    return line;
  }
  return '';
}

/**
 * 扫描一个具体的 skills 目录（`<dir>/<name>/SKILL.md`，只扫一层）。
 * @param skillsDir skills 目录绝对路径
 * @param source 作用域来源
 */
function scanSkillsRoot(skillsDir: string, source: SkillSource): SkillMeta[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在或无权限，静默跳过
  }

  const result: SkillMeta[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(skillsDir, ent.name);
    const skillPath = path.join(dir, 'SKILL.md');
    let raw: string;
    try {
      raw = fs.readFileSync(skillPath, 'utf-8');
    } catch {
      continue; // 无 SKILL.md，跳过
    }

    const { data, body } = parseFrontmatter(raw);
    // 注意：data.name 为纯空白时是 truthy，需 trim 后判断，空则回退目录名
    const name = (data.name && data.name.trim()) || ent.name;
    const description = (data.description || firstParagraph(body)).trim();
    if (!name.trim() || !description) continue; // 无名或无描述 → 无法展示，跳过

    const whenToUse = data.when_to_use ? data.when_to_use.trim() : undefined;
    let allowedTools: string[] | undefined;
    if (data['allowed-tools']) {
      allowedTools = data['allowed-tools'].split(',').map((s) => s.trim()).filter(Boolean);
    }

    result.push({
      name,
      description,
      whenToUse,
      allowedTools,
      skillPath,
      dir,
      source,
    });
  }
  return result;
}

/** 用户级 skills 目录（统一为 ~/.agents/skills，可用 CUCKOO_HOME 覆盖供测试隔离） */
export function getUserSkillsDir(): string {
  const override = process.env.CUCKOO_HOME;
  if (override) {
    const agentsSkills = path.join(override, '.agents', 'skills');
    if (fs.existsSync(agentsSkills)) return agentsSkills;
    const directSkills = path.join(override, 'skills');
    if (fs.existsSync(directSkills)) return directSkills;
    return directSkills;
  }
  return path.join(os.homedir(), '.agents', 'skills');
}

/** 项目级 skills 目录：统一为 `<projectDir>/.agents/skills` */
export function getProjectSkillsDir(projectDir: string): string {
  return path.join(projectDir, '.agents', 'skills');
}

/** 合并技能列表：同名时 项目级 > 用户级 > 插件级 */
export function mergeSkills(project: SkillMeta[], user: SkillMeta[], plugin: SkillMeta[] = []): SkillMeta[] {
  const byName = new Map<string, SkillMeta>();
  for (const s of plugin) byName.set(s.name, s); // 最低优先级
  for (const s of user) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s); // 项目级覆盖同名用户级
  return Array.from(byName.values());
}

/**
 * 扫描并合并技能。
 * 目录约定：
 *  - 项目级：`<projectDir>/.agents/skills/<name>/SKILL.md`
 *  - 用户级：`~/.agents/skills/<name>/SKILL.md`
 *  - 插件级：由 `extraSkillDirs` 传入的绝对目录（形如 `~/.cuckoo/plugins/<id>/skills`）
 *
 * @param projectDir 项目根目录（可为 null，表示未初始化项目）
 * @param extraSkillDirs 额外的 skills 目录（绝对路径）。由上层（session）计算后传入，
 *   本模块**不 import plugins**，避免形成依赖环（见 docs/arch/02-dependency.md）。
 * @returns 合并后的技能列表（项目级 > 用户级 > 插件级）
 *
 * D-004（prompt injection 数据层兜底）：当 projectDir 存在但工作区未被信任时，
 * 不扫描/不返回项目级技能。这样所有消费方（prompt-builder、list-skills IPC、
 * DSH host、harness 等）自动获得过滤，不依赖各入口自觉调用。用户级/插件级不受影响。
 */
export function scanSkills(projectDir: string | null, extraSkillDirs: string[] = []): SkillMeta[] {
  const user = scanSkillsRoot(getUserSkillsDir(), 'user');
  const project = projectDir && isWorkspaceTrusted(projectDir)
    ? scanSkillsRoot(getProjectSkillsDir(projectDir), 'project')
    : [];

  const plugin: SkillMeta[] = [];
  for (const dir of extraSkillDirs) {
    if (!dir) continue;
    plugin.push(...scanSkillsRoot(dir, 'plugin'));
  }
  return mergeSkills(project, user, plugin);
}
