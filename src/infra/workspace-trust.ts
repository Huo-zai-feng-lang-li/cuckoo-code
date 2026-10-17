/**
 * 工作区信任（D-002/D-004 地基，纯 node）
 *
 * 项目目录下若存在 .agents/mcp.json、.agents/rules/、.agents/skills/，
 * 首次使用前需用户在主进程信任门里选择：
 *  - trusted：持久化到 ~/.cuckoo/trusted-workspaces.json（原子写）
 *  - session：仅本次会话（内存 Set，不持久化）
 *  - untrusted：不启用项目级内容
 *
 * 本模块只管"信任记录 + 工件扫描"，弹窗编排由 app 层（workspace-trust-prompt）。
 * infra 层，不依赖 electron / 上层模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync, readJsonRobustSync, cuckooHomeDir } from './atomic-json.js';

export type TrustScope = 'trusted' | 'session' | 'untrusted';

export interface WorkspaceMcpEntry {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

export interface WorkspaceArtifacts {
  dir: string;
  mcp: WorkspaceMcpEntry[];
  rules: string[];
  skills: string[];
}

interface TrustRecord {
  path: string;
  since: string;
}

interface TrustFile {
  version: 1;
  trusted: Record<string, TrustRecord>;
}

/** 会话级信任（模块内存，不持久化） */
const sessionTrust = new Set<string>();

/** 信任记录文件路径（CUCKOO_HOME 覆盖） */
function trustFile(): string {
  return path.join(cuckooHomeDir(), 'trusted-workspaces.json');
}

function readTrustFile(): TrustFile {
  const data = readJsonRobustSync<TrustFile>(trustFile(), { version: 1, trusted: {} });
  if (!data || typeof data !== 'object' || !data.trusted || typeof data.trusted !== 'object') {
    return { version: 1, trusted: {} };
  }
  return data;
}

/**
 * 归一化项目路径（比较键）：win32 大小写不敏感（toLowerCase），其他平台精确。
 */
export function normalizeProjectPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 持久化信任判定（不查会话级） */
export function isWorkspaceTrustedPersistently(dir: string | null | undefined): boolean {
  if (!dir || typeof dir !== 'string') return false;
  const norm = normalizeProjectPath(dir);
  const data = readTrustFile();
  return Object.prototype.hasOwnProperty.call(data.trusted, norm);
}

/** 信任判定（持久或会话任一命中即 true） */
export function isWorkspaceTrusted(dir: string | null | undefined): boolean {
  if (!dir || typeof dir !== 'string') return false;
  const norm = normalizeProjectPath(dir);
  if (sessionTrust.has(norm)) return true;
  return isWorkspaceTrustedPersistently(dir);
}

/**
 * 设置信任范围。
 * @param dir 项目目录
 * @param scope trusted=持久 / session=仅本次会话 / untrusted=撤销
 */
export function setWorkspaceTrust(dir: string, scope: TrustScope): void {
  if (!dir || typeof dir !== 'string') return;
  const norm = normalizeProjectPath(dir);
  if (scope === 'session') {
    sessionTrust.add(norm);
    return;
  }
  if (scope === 'untrusted') {
    revokeWorkspaceTrust(dir);
    return;
  }
  const data = readTrustFile();
  data.trusted[norm] = { path: path.resolve(dir), since: new Date().toISOString() };
  writeJsonAtomicSync(trustFile(), data);
  sessionTrust.delete(norm); // 已持久化，会话标记多余
}

/** 撤销持久信任（同时清会话标记） */
export function revokeWorkspaceTrust(dir: string): void {
  if (!dir || typeof dir !== 'string') return;
  const norm = normalizeProjectPath(dir);
  sessionTrust.delete(norm);
  const data = readTrustFile();
  if (Object.prototype.hasOwnProperty.call(data.trusted, norm)) {
    delete data.trusted[norm];
    writeJsonAtomicSync(trustFile(), data);
  }
}

/** 列出全部持久信任的工作区 */
export function listTrustedWorkspaces(): Array<{ path: string; since?: string }> {
  const data = readTrustFile();
  return Object.values(data.trusted).map((r) => ({ path: r.path, since: r.since }));
}

/** 清空会话级信任（仅供测试） */
export function clearSessionTrustForTests(): void {
  sessionTrust.clear();
}

/**
 * 扫描项目目录下的 .agents 工件（只读元数据，不读全文）：
 *  - MCP：<dir>/.agents/mcp.json（mcpServers 各 name/command/args/url）
 *  - 规则：<dir>/.agents/rules/*.md（文件名去掉 .md）
 *  - 技能：<dir>/.agents/skills/<name>/SKILL.md（目录名）
 */
export function scanWorkspaceArtifacts(dir: string | null | undefined): WorkspaceArtifacts {
  const empty: WorkspaceArtifacts = { dir: dir || '', mcp: [], rules: [], skills: [] };
  if (!dir || typeof dir !== 'string' || !fs.existsSync(dir)) return empty;
  const agentsDir = path.join(dir, '.agents');
  if (!fs.existsSync(agentsDir)) return empty;

  // MCP
  const mcp: WorkspaceMcpEntry[] = [];
  try {
    const mcpFile = path.join(agentsDir, 'mcp.json');
    if (fs.existsSync(mcpFile)) {
      const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
      const servers = cfg && cfg.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const name of Object.keys(servers)) {
          const s = servers[name] || {};
          mcp.push({
            name,
            command: typeof s.command === 'string' ? s.command : undefined,
            args: Array.isArray(s.args) ? s.args : undefined,
            url: typeof s.url === 'string' ? s.url : undefined,
          });
        }
      }
    }
  } catch (_) { /* 损坏的 mcp.json 按"无 MCP"处理 */ }

  // 规则
  const rules: string[] = [];
  try {
    const rulesDir = path.join(agentsDir, 'rules');
    if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
      for (const f of fs.readdirSync(rulesDir)) {
        if (f.endsWith('.md')) rules.push(f.slice(0, -3));
      }
    }
  } catch (_) { /* 忽略 */ }

  // 技能
  const skills: string[] = [];
  try {
    const skillsDir = path.join(agentsDir, 'skills');
    if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
      for (const name of fs.readdirSync(skillsDir)) {
        if (fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))) skills.push(name);
      }
    }
  } catch (_) { /* 忽略 */ }

  return { dir, mcp, rules, skills };
}
