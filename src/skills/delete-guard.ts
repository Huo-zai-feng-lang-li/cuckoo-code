/**
 * 技能目录删除的路径白名单校验（纯 node，供 app 层 IPC 调用）。
 *
 * 删除是破坏性操作，直接按渲染进程传来的路径下手有两类风险：
 *  1) 越权：传入 `..`、盘符根、项目外目录；
 *  2) 误删：指向技能根目录本身，或指向没有 SKILL.md 的普通目录。
 * 因此这里只承认「技能扫描根的直接子目录 + 内含 SKILL.md」，并拒绝符号链接逃逸。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 校验结果 */
export interface SkillDirCheck {
  ok: boolean;
  /** 校验通过时的技能目录绝对路径 */
  dir?: string;
  /** 校验失败时的原因（直接回给 UI） */
  error?: string;
}

/** realpath 失败（不存在 / 无权限）时返回 null，调用方按不通过处理 */
function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * target 是否为 root 的**直接子目录**（两者都按真实路径比较）。
 * 仅判定一层：删除只允许 `<root>/<skill>`，不允许更深或就是 root 本身。
 */
function isDirectChild(root: string, target: string): boolean {
  const rootReal = safeRealpath(root);
  const targetReal = safeRealpath(target);
  if (!rootReal || !targetReal) return false;
  const rel = path.relative(rootReal, targetReal);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).length === 1;
}

/**
 * 校验一个 SKILL.md 路径对应的技能目录是否可删。
 * @param skillPath 技能的 SKILL.md 绝对路径（来自 list-skills 的 skillPath）
 * @param roots 允许的技能根目录（用户级 / 项目级）
 * @returns 通过时返回目录路径，否则返回拒绝原因
 */
export function checkDeletableSkillDir(skillPath: string, roots: string[]): SkillDirCheck {
  if (!skillPath || typeof skillPath !== 'string') return { ok: false, error: '缺少技能路径' };
  if (!path.isAbsolute(skillPath)) return { ok: false, error: '技能路径必须是绝对路径' };
  if (path.basename(skillPath).toLowerCase() !== 'skill.md') {
    return { ok: false, error: '只接受 SKILL.md 路径' };
  }

  const dir = path.dirname(skillPath);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(dir);
  } catch {
    return { ok: false, error: '技能目录不存在' };
  }
  // 软链目录可能指向任意位置，删除等于删别人：直接拒绝
  if (lst.isSymbolicLink()) return { ok: false, error: '技能目录是符号链接，拒绝删除' };
  if (!lst.isDirectory()) return { ok: false, error: '技能路径不是目录' };
  if (!fs.existsSync(skillPath)) return { ok: false, error: 'SKILL.md 不存在' };

  const allowed = (roots || []).filter((r) => !!r);
  for (const root of allowed) {
    if (isDirectChild(root, dir)) return { ok: true, dir };
  }
  return { ok: false, error: '技能目录不在允许的扫描根内' };
}
