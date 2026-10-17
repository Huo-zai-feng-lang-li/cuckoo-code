/**
 * 原子 JSON 读写（C-001/002/003 地基）
 *
 * 目标：替换 store.ts / profile.ts / window-groups / token-stats / snippets /
 * ui-prefs / recent-tools / theme-manager 共 8 处的裸 JSON 写。
 *
 * 写：同目录临时文件（.basename.<pid>.<seq>.tmp）→ 写完整 + fsync（尽力）
 *    → fsyncSync 目录（尽力）→ rename 覆盖。Windows 上 rename 可能撞
 *    EPERM/EBUSY/EACCES（Defender/索引器短暂占用），最多重试 10 次 × 50ms。
 *    keepBackup 时 rename 前把旧文件另存为 .bak。
 * 读：readJsonRobustSync——主文件 JSON 损坏时回退 .bak，再退回 fallback；
 *    不静默吞成"空"（损坏事件记 warning，避免用户无感知丢数据）。
 *
 * 注意：防"进程崩溃留下半截 JSON"，不承诺防断电（未 fsync 磁盘层）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let _seq = 0;

/** 用户数据目录（CUCKOO_HOME 覆盖，否则 ~/.cuckoo；与 protected-paths.ts 一致） */
export function cuckooHomeDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

export interface AtomicWriteOptions {
  /** rename 前把旧文件备份为 <file>.bak（供 readJsonRobustSync 回退） */
  keepBackup?: boolean;
}

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_MAX = 10;
const RETRY_WAIT_MS = 50;

/** 同目录临时文件名：.<base>.<pid>.<seq>.tmp */
function tmpPath(file: string): string {
  _seq = (_seq + 1) % 100000;
  return path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + _seq + '.tmp');
}

/** 写临时文件（完整内容 + fsync 尽力），返回临时路径 */
function prepareTempFile(file: string, json: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPath(file);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf-8');
    try { fs.fsyncSync(fd); } catch (_) { /* fsync 尽力 */ }
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 同步等待（本函数本来就是 sync 路径） */ }
}

/** rename 覆盖目标；Windows 占用错误按约定重试 */
function renameWithRetrySync(tmp: string, file: string): void {
  let attempt = 0;
  for (;;) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e: any) {
      attempt++;
      if (!RETRYABLE_CODES.has(e.code) || attempt >= RETRY_MAX) throw e;
      sleepSync(RETRY_WAIT_MS);
    }
  }
}

async function renameWithRetry(tmp: string, file: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e: any) {
      attempt++;
      if (!RETRYABLE_CODES.has(e.code) || attempt >= RETRY_MAX) throw e;
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
}

/** rename 后尽力 fsync 目录（Windows 上目录句柄 fsync 会失败，吞掉） */
function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } catch (_) { /* Windows 不支持，忽略 */ }
    finally { fs.closeSync(fd); }
  } catch (_) { /* 忽略 */ }
}

/**
 * 同步原子写 JSON。
 * @returns 成功 true；失败 false（已记日志，不抛）
 */
export function writeJsonAtomicSync(file: string, data: unknown, opts?: AtomicWriteOptions): boolean {
  try {
    const json = JSON.stringify(data, null, 2);
    const tmp = prepareTempFile(file, json);
    try {
      if (opts?.keepBackup && fs.existsSync(file)) {
        try { fs.copyFileSync(file, file + '.bak'); } catch (_) { /* 备份失败不阻塞主写 */ }
      }
      renameWithRetrySync(tmp, file);
      syncDir(path.dirname(file));
      return true;
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 清理临时文件 */ }
      throw e;
    }
  } catch (e: any) {
    console.error('[atomic-json] 写入失败:', file, e && e.message);
    return false;
  }
}

/**
 * 异步原子写 JSON（与 sync 同语义，重试间隔用 await）。
 * @returns 成功 true；失败 false（已记日志，不抛）
 */
export async function writeJsonAtomic(file: string, data: unknown, opts?: AtomicWriteOptions): Promise<boolean> {
  try {
    const json = JSON.stringify(data, null, 2);
    const tmp = prepareTempFile(file, json);
    try {
      if (opts?.keepBackup && fs.existsSync(file)) {
        try { fs.copyFileSync(file, file + '.bak'); } catch (_) { /* 备份失败不阻塞主写 */ }
      }
      await renameWithRetry(tmp, file);
      syncDir(path.dirname(file));
      return true;
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 清理临时文件 */ }
      throw e;
    }
  } catch (e: any) {
    console.error('[atomic-json] 写入失败:', file, e && e.message);
    return false;
  }
}

/** 读并 parse JSON；文件不存在/损坏均返回 null */
function tryParseFile<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (_) {
    return null;
  }
}

/**
 * 鲁棒读 JSON：主文件 → 损坏回退 .bak → 再退回 fallback。
 * 损坏事件记 warning（不静默吞成"空"而丢数据）。
 * @param file JSON 文件路径
 * @param fallback 文件不存在且 .bak 也不存在时的默认值
 */
export function readJsonRobustSync<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (_) {
    return fallback; // 文件不存在：首次运行，静默用默认
  }
  try {
    return JSON.parse(raw) as T;
  } catch (_) {
    console.warn('[atomic-json] ' + file + ' JSON 损坏，尝试回退 .bak');
  }
  const bak = tryParseFile<T>(file + '.bak');
  if (bak !== null) return bak;
  console.warn('[atomic-json] ' + file + ' .bak 也不可用，退回默认值（用户数据已损坏）');
  return fallback;
}
