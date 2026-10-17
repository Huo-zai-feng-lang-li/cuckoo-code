/**
 * 受保护路径（用户数据目录）
 *
 * `~/.cuckoo/` 下的存档类数据不应被文件工具（write/edit/deleteFile）直接修改：
 *  - `snapshots/`：快照存档，语义上"冻结"，只能通过快照功能管理
 *  - `memories.json`：用户记忆，应通过 remember/forgetMemory 工具管理
 *
 * 本模块供 tools 层调用（infra 是最底层，无依赖违规）。
 * 注意：bash/pwsh 无法可靠拦截（任意命令），这是黑名单固有局限。
 */
import path from 'node:path';
import os from 'node:os';

/** 用户数据目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

/**
 * 判断绝对路径是否属于受保护路径。
 *
 * Windows NTFS 默认大小写不敏感，而 JS 字符串 === / startsWith 是大小写敏感的——
 * 不修的话 `Snapshots\evil.txt`、`Memories.json`（大写）能绕过守卫实际命中受保护对象（A-003）。
 * 修复：win32 上比较前两侧统一小写；大小写敏感平台（Linux/mac）保持原样。
 *
 * @param absPath 已解析的绝对路径
 * @returns 命中时返回原因（中文），否则 null
 */
function isProtectedPath(absPath: string): string | null {
  if (!absPath || typeof absPath !== 'string') return null;
  // win32 大小写不敏感文件系统：比较键统一小写（不改变对外返回的路径语义）
  const normalizeKey = process.platform === 'win32'
    ? (p: string) => p.toLowerCase()
    : (p: string) => p;

  const normalized = normalizeKey(path.resolve(absPath));
  const snapshotsDir = normalizeKey(path.resolve(path.join(getUserDir(), 'snapshots')));
  const memoriesFile = normalizeKey(path.resolve(path.join(getUserDir(), 'memories.json')));

  if (normalized === snapshotsDir || normalized.startsWith(snapshotsDir + path.sep)) {
    return '快照存档目录（受保护，禁止通过文件工具修改或删除；请用快照管理功能）';
  }
  if (normalized === memoriesFile) {
    return '用户记忆数据（受保护，请用 remember/forgetMemory 工具）';
  }
  return null;
}

export { isProtectedPath, getUserDir };
