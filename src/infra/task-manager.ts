/**
 * 后台任务管理器（唯一真相源）
 *
 * 负责 spawn / 跟踪 / 停止长驻命令（dev server、watch、tail -f 等）。
 * 手动命令、package.json scripts、AI 后台命令，三者在同一张进程表里管理。
 *
 * 分层：infra 层，只依赖 node 内置模块。
 * 通知 UI 用回调注入（setChangeListener）——不依赖上层（bridge/app/session）。
 *
 * 停止策略（精准杀进程树）：
 *  - Windows：taskkill /pid <pid> /T /F（/T 连带子进程）
 *  - Unix：spawn 时 detached:true（自成进程组）→ process.kill(-pid, SIGTERM)
 *
 * 输出缓冲：环形，单任务上限 MAX_OUTPUT_BYTES（默认 256KB），超出丢头部，防无界内存。
 */
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { decodeOutput } from './decode-output.js';

/** 单任务输出缓冲上限（字节，按 UTF-8 估算） */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** 同时运行的最大后台任务数 */
const MAX_TASKS = 20;
/** 已退出任务的历史保留上限（防止 tasks Map 无界增长） */
const MAX_EXITED_HISTORY = 50;
/** 停止时的宽限：先温和终止，超时未退再强杀 */
const STOP_GRACE_MS = 3000;

export type TaskSource = 'manual' | 'script' | 'ai';
export type TaskStatus = 'running' | 'exited';

export interface TaskInfo {
  id: string;
  command: string;
  cwd: string;
  source: TaskSource;
  label?: string;
  pid?: number;
  status: TaskStatus;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  /** 该任务是否有子进程（用于提示"杀进程树"） */
  hasChild?: boolean;
  /** 停止中：已发起停止、等进程退出（UI 据此显示"停止中…"） */
  stopping?: boolean;
}

interface TaskRecord extends TaskInfo {
  child: any;
  /** 输出环形缓冲（已解码文本） */
  output: string;
  outputBytes: number;
}

/** 变更通知回调（主进程注入 → 推给壳页面） */
type ChangeListener = () => void;
let _onChange: ChangeListener | null = null;
export function setChangeListener(fn: ChangeListener | null): void {
  _onChange = fn;
}

/** 通知去抖：短时间多次变更合并成一次（防高频输出刷爆 IPC） */
let _notifyTimer: any = null;
function notifyChange(): void {
  if (!_onChange) return;
  if (_notifyTimer) return;
  _notifyTimer = setTimeout(() => {
    _notifyTimer = null;
    try { _onChange && _onChange(); } catch (_) { /* ignore */ }
  }, 120);
  // 允许进程退出前不阻塞事件循环
  if (_notifyTimer && typeof _notifyTimer.unref === 'function') _notifyTimer.unref();
}

const tasks = new Map<string, TaskRecord>();
let _seq = 0;

/** 生成任务 id（时间戳 + 递增序号，避免同 ms 冲突） */
function nextId(): string {
  _seq = (_seq + 1) % 100000;
  return 'task-' + Date.now().toString(36) + '-' + _seq.toString(36);
}

/** 运行中的任务数 */
function runningCount(): number {
  let n = 0;
  for (const t of tasks.values()) if (t.status === 'running') n++;
  return n;
}

/**
 * 修剪已退出的历史任务，防止 tasks Map 随命令数无界增长。
 * 仅保留最近 MAX_EXITED_HISTORY 个已退出任务（按结束时间），运行中的一律不动。
 */
function pruneExited(): void {
  const exited: TaskRecord[] = [];
  for (const rec of tasks.values()) {
    if (rec.status === 'exited') exited.push(rec);
  }
  if (exited.length <= MAX_EXITED_HISTORY) return;
  exited.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0)); // 最旧在前
  const removeCount = exited.length - MAX_EXITED_HISTORY;
  for (let i = 0; i < removeCount; i++) tasks.delete(exited[i].id);
}

/** 追加输出到环形缓冲（超出上限丢头部，尽量按行丢弃） */
function appendOutput(rec: TaskRecord, text: string): void {
  if (!text) return;
  rec.output += text;
  rec.outputBytes += Buffer.byteLength(text, 'utf-8');
  if (rec.outputBytes > MAX_OUTPUT_BYTES) {
    // 超限：从头部裁掉，保留尾部；按换行对齐，避免半个字
    const drop = rec.outputBytes - MAX_OUTPUT_BYTES;
    // 单次遍历累加 UTF-8 字节数，找到应丢弃的字符数（O(n)，避免逐字符 slice+byteLength 的 O(n²)）。
    // 按码点边界前进：高位代理与随后的低位代理合为一个 4 字节码点，避免切出半个字符。
    let cut = 0;
    let droppedBytes = 0;
    while (cut < rec.output.length && droppedBytes < drop) {
      const code = rec.output.charCodeAt(cut);
      let step = 1;
      let bytes: number;
      if (code < 0x80) {
        bytes = 1;
      } else if (code < 0x800) {
        bytes = 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = rec.output.charCodeAt(cut + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { step = 2; bytes = 4; } // 完整代理对
        else bytes = 3; // 孤立高位代理（异常输入，按 3 字节兜底）
      } else {
        bytes = 3;
      }
      droppedBytes += bytes;
      cut += step;
    }
    // 对齐到下一个换行（丢头更干净）
    const nl = rec.output.indexOf('\n', cut);
    if (nl >= 0 && nl < rec.output.length - 1) cut = nl + 1;
    const removed = rec.output.slice(0, cut);
    rec.output = rec.output.slice(cut);
    rec.outputBytes -= Buffer.byteLength(removed, 'utf-8');
    if (rec.outputBytes < 0) rec.outputBytes = 0;
    // 头部加截断提示（只加一次）。前缀也计入 outputBytes，维持"字节数=实际内容"的不变量。
    if (!rec.output.startsWith('[输出已截断]')) {
      const prefix = '[输出已截断]\n';
      rec.output = prefix + rec.output;
      rec.outputBytes += Buffer.byteLength(prefix, 'utf-8');
    }
  }
}

export interface StartOptions {
  command: string;
  cwd: string;
  source: TaskSource;
  label?: string;
}

/**
 * 启动一个后台任务。
 * @returns 任务信息（含 id）；失败时抛出 Error（并发超限 / 命令为空）
 */
export function start(opts: StartOptions): TaskInfo {
  const command = (opts.command || '').trim();
  if (!command) throw new Error('命令为空');
  if (runningCount() >= MAX_TASKS) {
    throw new Error('后台任务已达上限（' + MAX_TASKS + '），请先停止一些任务');
  }
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();

  const isWin = process.platform === 'win32';
  // Windows：用 shell 跑（cmd.exe /c）；Unix：用 sh -c
  const child = isWin
    ? spawn(command, { cwd, windowsHide: true, shell: true, env: { ...process.env } })
    : spawn('sh', ['-c', command], { cwd, env: { ...process.env }, detached: true });

  const info: TaskInfo = {
    id: nextId(),
    command,
    cwd,
    source: opts.source,
    label: opts.label,
    pid: child.pid,
    status: 'running',
    startedAt: Date.now(),
  };
  const rec: TaskRecord = { ...info, child, output: '', outputBytes: 0 };
  tasks.set(info.id, rec);

  const onData = (buf: any) => {
    // 中文 Windows 的 cmd 输出是 GBK，需智能解码（否则乱码）
    appendOutput(rec, decodeOutput(buf));
    notifyChange();
  };
  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) child.stderr.on('data', onData);

  const finish = (code: number | null) => {
    if (rec.status === 'exited') return;
    rec.status = 'exited';
    rec.exitCode = code;
    rec.endedAt = Date.now();
    rec.stopping = false; // 已退出：清"停止中"标记，避免语义残留
    pruneExited(); // 修剪历史，防 tasks Map 无界增长
    notifyChange();
  };
  child.on('error', (err: any) => {
    appendOutput(rec, '\n[启动失败] ' + (err && err.message ? err.message : String(err)) + '\n');
    finish(-1);
  });
  child.on('close', (code: number | null) => { finish(code); });

  notifyChange();
  return { ...info };
}

/** 取任务信息（不含 child / 输出） */
export function get(id: string): TaskInfo | null {
  const rec = tasks.get(id);
  if (!rec) return null;
  return toInfo(rec);
}

/** 列出全部任务（新→旧） */
export function list(): TaskInfo[] {
  return Array.from(tasks.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toInfo);
}

/** 取任务输出 */
export function getOutput(id: string): string {
  const rec = tasks.get(id);
  return rec ? rec.output : '';
}

function toInfo(rec: TaskRecord): TaskInfo {
  return {
    id: rec.id,
    command: rec.command,
    cwd: rec.cwd,
    source: rec.source,
    label: rec.label,
    pid: rec.pid,
    status: rec.status,
    exitCode: rec.exitCode,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    hasChild: rec.hasChild,
    stopping: rec.stopping,
  };
}

/**
 * 杀整个进程树（后台任务 + 前台命令共用，修 A-006）。
 * Windows：taskkill /T /F 连带子孙进程；Unix：杀整个进程组（spawn 时 detached 成为组长）。
 *
 * A-016：先探活（process.kill(pid, 0)）——进程已退出则不发 taskkill，
 * 避免 OS 把该 pid 复给新进程后被 /T /F 误伤。探活与杀之间仍有微秒级窗口，属残余风险。
 *
 * @param pid 根进程 pid
 * @param signal Unix 信号（默认 SIGTERM；前台超时可传 SIGKILL 立即强杀）
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid || pid <= 0) return;
  try { process.kill(pid, 0); } catch (_) { return; } // ESRCH：进程已退出，不动（防 pid 复用误伤）
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) console.warn('[task-manager] taskkill /T 失败 pid=' + pid + ': ' + (err.message || err));
    });
  } else {
    try { process.kill(-pid, signal); } catch (_) {
      try { process.kill(pid, signal); } catch (_) { /* 已退出 */ }
    }
  }
}

/**
 * 停止一个任务（精准杀进程树）。
 * @returns 是否发起了停止（任务不存在或已退出返回 false）
 */
export function stop(id: string): boolean {
  const rec = tasks.get(id);
  if (!rec || rec.status !== 'running') return false;
  if (rec.stopping) return true;
  rec.stopping = true;

  const pid = rec.pid;
  if (!pid) {
    rec.status = 'exited';
    rec.endedAt = Date.now();
    rec.exitCode = rec.exitCode ?? null;
    rec.stopping = false;
    notifyChange();
    return true;
  }

  const isWin = process.platform === 'win32';
  if (isWin) {
    // Windows：taskkill /T 连带子进程树；/F 强制。
    // ⚠️ 必须只走 taskkill——若同时 rec.child.kill() 抢先杀掉父进程，
    //    异步的 taskkill 执行时父 PID 已死，/T 就找不到子进程树了（子进程残留）。
    killProcessTree(pid);
  } else {
    // Unix：杀整个进程组（detached 使其成为组长）
    try { process.kill(-pid, 'SIGTERM'); } catch (_) {
      try { rec.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }
    // 宽限后强杀
    const t = setTimeout(() => {
      if (rec.status === 'running') {
        try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* ignore */ }
      }
    }, STOP_GRACE_MS);
    if (t && typeof (t as any).unref === 'function') (t as any).unref();
  }

  // 不立即置 exited——等 close 事件；但若 3s 后仍未退，标记 exited（避免 UI 卡"停止中"）
  const t2 = setTimeout(() => {
    if (rec.status === 'running') {
      rec.status = 'exited';
      rec.endedAt = Date.now();
      rec.exitCode = rec.exitCode ?? null; // 兜底：避免渲染层显示"退出码 undefined"
      rec.stopping = false;
      pruneExited();
      notifyChange();
    }
  }, STOP_GRACE_MS + 500);
  if (t2 && typeof (t2 as any).unref === 'function') (t2 as any).unref();

  notifyChange();
  return true;
}

/** 移除一条已退出的任务记录（从列表里清掉） */
export function remove(id: string): boolean {
  const rec = tasks.get(id);
  if (!rec) return false;
  if (rec.status === 'running') return false; // 运行中不允许移除
  tasks.delete(id);
  notifyChange();
  return true;
}

/** 清空所有已退出的任务 */
export function clearExited(): number {
  let n = 0;
  for (const [id, rec] of tasks) {
    if (rec.status === 'exited') { tasks.delete(id); n++; }
  }
  if (n) notifyChange();
  return n;
}

/** 杀掉全部任务（退出 / 切项目时调用，防孤儿进程） */
export function dispose(): void {
  for (const rec of tasks.values()) {
    if (rec.status !== 'running') continue;
    const pid = rec.pid;
    if (!pid) continue;
    try {
      killProcessTree(pid, 'SIGKILL');
    } catch (_) { /* ignore */ }
    rec.status = 'exited';
    rec.endedAt = Date.now();
  }
  pruneExited();
  notifyChange();
}

/** 读取指定项目目录下 package.json 的 scripts（供「任务」页一键运行） */
export function readPackageScripts(projectDir: string): Array<{ name: string; command: string }> {
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return [];
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return Object.keys(scripts).map((name) => ({ name, command: String(scripts[name]) }));
  } catch (_) {
    return [];
  }
}

// 供测试/调试：重置
export function _resetForTest(): void {
  dispose();
  tasks.clear();
  _seq = 0;
}
