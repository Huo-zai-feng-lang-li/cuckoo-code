import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_RULE_FILE, DEFAULT_RULE_CONTENT } from './defaults.js';

export interface RuleFileRecord { name: string; fileName: string; rulePath: string; content: string; hash: string; updatedAt: string; }
function rulesDir(): string {
  const override = process.env.CUCKOO_HOME;
  if (override) {
    const agentsRules = path.resolve(override, '.agents', 'rules');
    if (fs.existsSync(agentsRules)) return agentsRules;
    const directRules = path.resolve(override, 'rules');
    if (fs.existsSync(directRules)) return directRules;
    return directRules;
  }
  return path.resolve(os.homedir(), '.agents', 'rules');
}
function hash(content: string): string { return crypto.createHash('sha256').update(content, 'utf8').digest('hex'); }
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function validFileName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.endsWith('.md')) return false;
  if (WINDOWS_RESERVED.test(trimmed)) return false;
  // 支持中英文、数字、中划线、下划线，严禁路径分隔符及控制字符
  return /^[\p{L}\p{N}][\p{L}\p{N}._ -]*\.md$/u.test(trimmed) && !trimmed.includes('..');
}
function contained(base: string, target: string): boolean { const rel = path.relative(base, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); }
function safePath(fileName: unknown): string | null { if (!validFileName(fileName)) return null; const base = rulesDir(); const target = path.resolve(base, fileName); return contained(base, target) && path.basename(target) === fileName ? target : null; }

function ensureDirectory(): string {
  const dir = rulesDir();
  const parts: string[] = [];
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); parts.push(current);
  }
  for (const candidate of parts) {
    try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('规则目录包含软链接'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('规则目录不是安全目录');
  return dir;
}
function readRecord(rulePath: string): RuleFileRecord | null { try { const stat = fs.lstatSync(rulePath); if (!stat.isFile() || stat.isSymbolicLink()) return null; const realDir = fs.realpathSync(rulesDir()); const realFile = fs.realpathSync(rulePath); if (!contained(realDir, realFile)) return null; const content = fs.readFileSync(rulePath, 'utf8'); return { name: path.basename(rulePath, '.md'), fileName: path.basename(rulePath), rulePath, content, hash: hash(content), updatedAt: stat.mtime.toISOString() }; } catch { return null; } }
export function listUserRules(): RuleFileRecord[] { const dir = ensureDirectory(); return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.isSymbolicLink() && /\.md$/i.test(e.name)).map((e) => readRecord(path.join(dir, e.name))).filter((r): r is RuleFileRecord => !!r).sort((a, b) => a.fileName.localeCompare(b.fileName)); }
export function createUserRule(fileName: unknown, content: unknown): RuleFileRecord { const rulePath = safePath(fileName); if (!rulePath) throw new Error('规则文件名非法'); ensureDirectory(); if (fs.existsSync(rulePath)) throw new Error('规则文件已存在'); fs.writeFileSync(rulePath, typeof content === 'string' ? content : '', { encoding: 'utf8', flag: 'wx' }); return readRecord(rulePath)!; }
export function saveUserRule(fileName: unknown, content: unknown, expectedHash: unknown): RuleFileRecord {
  const rulePath = safePath(fileName);
  if (!rulePath) throw new Error('规则文件名非法');
  const current = readRecord(rulePath);
  if (!current) throw new Error('规则文件不存在或不安全');
  if (typeof expectedHash !== 'string' || current.hash !== expectedHash) throw new Error('文件已被外部修改，请重新加载');
  const nonce = crypto.randomBytes(4).toString('hex');
  const tempPath = `${rulePath}.${process.pid}.${Date.now()}.${nonce}.tmp`;
  fs.writeFileSync(tempPath, typeof content === 'string' ? content : '', { encoding: 'utf8', flag: 'wx' });
  try {
    const before = readRecord(rulePath);
    if (!before || before.hash !== expectedHash) throw new Error('文件已被外部修改，请重新加载');
    try {
      fs.renameSync(tempPath, rulePath);
    } catch (renameErr: any) {
      if (renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST')) {
        fs.copyFileSync(tempPath, rulePath);
      } else {
        throw renameErr;
      }
    }
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* cleaned up */ }
  }
  return readRecord(rulePath)!;
}
export function deleteUserRule(fileName: unknown, expectedHash: unknown): void { const rulePath = safePath(fileName); if (!rulePath) throw new Error('规则文件名非法'); const current = readRecord(rulePath); if (!current) throw new Error('规则文件不存在或不安全'); if (typeof expectedHash !== 'string' || current.hash !== expectedHash) throw new Error('文件已被外部修改，请重新加载'); fs.unlinkSync(rulePath); }
export function openUserRulesDir(): string { return ensureDirectory(); }

function seedMarkerPath(): string {
  return path.join(path.dirname(rulesDir()), '.rules-seeded');
}

function legacySeedMarkerPath(): string {
  return path.join(os.homedir(), '.cuckoo', '.rules-seeded');
}

/**
 * 首次启动 seed 默认全局规则。
 * 条件：未 seed 过 且 规则目录为空 → 写入默认；否则跳过（绝不覆盖用户规则）。
 */
export function seedDefaultRules(): void {
  try {
    if (fs.existsSync(seedMarkerPath()) || fs.existsSync(legacySeedMarkerPath())) return; // 已 seed 过
    const dir = rulesDir();
    if (fs.existsSync(dir)) {
      const existing = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
      if (existing.length > 0) { markSeeded(); return; } // 用户已有规则
    }
    ensureDirectory();
    const target = path.join(dir, DEFAULT_RULE_FILE);
    fs.writeFileSync(target, DEFAULT_RULE_CONTENT, { encoding: 'utf8', flag: 'wx' });
    markSeeded();
    console.log('[Rules] 已写入默认全局规则:', target);
  } catch (err: any) {
    console.error('[Rules] seed 默认规则失败:', err.message);
  }
}

function markSeeded(): void {
  try { fs.writeFileSync(seedMarkerPath(), new Date().toISOString(), 'utf8'); } catch (_) { /* ignore */ }
}
