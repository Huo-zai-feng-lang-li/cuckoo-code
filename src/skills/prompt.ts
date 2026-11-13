/**
 * 生成系统提示词里的「可用技能」章节
 *
 * 渐进式披露：只展示 name + description(+when_to_use)，路径给出 SKILL.md 位置，
 * 由 AI 按需 read 全文。description 与 when_to_use 合计截断 1536 字符（对齐 Claude Code）。
 *
 * 路径压缩：同一作用域的技能共享目录前缀，前缀只声明一次，每条只写 `<name>/SKILL.md`，
 * 避免每条重复 `C:\\Users\\xxx\\.agents\\skills\\` 这类绝对路径（24 条可省约 1.3KB）。
 */
import path from 'node:path';
import type { SkillMeta, SkillSource } from './types.js';

/** description + when_to_use 合计上限（对齐 Claude Code） */
const DESC_LIMIT = 1536;

/** 来源中文名（用于分组标题） */
const SOURCE_LABEL: Record<SkillSource, string> = {
  project: '项目级',
  user: '用户级',
  plugin: '插件级',
};

/** 按 source 分组并保持组内原顺序 */
function groupBySource(skills: SkillMeta[]): Array<[SkillSource, SkillMeta[]]> {
  const order: SkillSource[] = ['project', 'user', 'plugin'];
  const groups = new Map<SkillSource, SkillMeta[]>();
  for (const s of skills) {
    const list = groups.get(s.source);
    if (list) list.push(s);
    else groups.set(s.source, [s]);
  }
  return order.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)!]);
}

/** 计算该来源技能的公共根目录（即每个技能目录的父目录） */
function commonRoot(list: SkillMeta[]): string {
  const parents = list.map((s) => path.dirname(s.dir));
  const first = parents[0] || '';
  let end = first.length;
  for (const p of parents) {
    while (end > 0 && p.slice(0, end) !== first.slice(0, end)) end--;
  }
  // 回退到目录分隔符，避免出现半截目录名
  if (end > 0 && end < first.length) {
    const idx = Math.max(first.lastIndexOf('/', end), first.lastIndexOf('\\', end));
    end = idx >= 0 ? idx : 0;
  }
  return first.slice(0, end);
}

/** 拼单条技能的展示文本（name：description） */
function formatSkillLine(s: SkillMeta, root: string): string {
  let desc = s.description;
  if (s.whenToUse) desc += '；适用场景：' + s.whenToUse;
  if (desc.length > DESC_LIMIT) desc = desc.slice(0, DESC_LIMIT) + '…';
  const rel = root ? path.relative(root, s.skillPath) : s.skillPath;
  return '- ' + s.name + '：' + desc + '\n  路径：' + rel.split(path.sep).join('/');
}

/**
 * 生成「可用技能」章节。无技能时返回空串。
 * @param skills 技能列表
 */
export function buildSkillsSection(skills: SkillMeta[]): string {
  const list = skills || [];
  const lines: string[] = [];
  lines.push('## 可用技能（Skills）');
  lines.push('');
  if (list.length > 0) {
    lines.push('当任务与某个技能相关时，你必须先用 read 读取其 SKILL.md 全文，再按其中指令执行。');
    lines.push('技能若有附带脚本，按 SKILL.md 里的说明、用 bash/pwsh 运行（路径以该技能目录为准）。');
    lines.push('若 SKILL.md 内容被截断，用 read 的 offset 参数继续读取。');
    lines.push('下面的「路径」相对各自的「目录」前缀，读取时拼接成绝对路径。');
    lines.push('');
    for (const [source, group] of groupBySource(list)) {
      const root = commonRoot(group);
      if (root) lines.push(SOURCE_LABEL[source] + '技能目录：' + root);
      for (const s of group) lines.push(formatSkillLine(s, root));
      lines.push('');
    }
  } else {
    lines.push('（当前没有已安装的技能）');
    lines.push('');
  }
  lines.push('如果你需要某个技能（例如特定领域的流程/规范/脚本），可以提示用户安装——本应用支持技能（Skill）。');
  lines.push('');
  return lines.join('\n');
}
