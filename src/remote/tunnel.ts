/**
 * Cloudflare Tunnel 子进程托管管理
 *
 * 职责：
 * 1. 查找并启动 cloudflared 子进程（支持固定 Tunnel Token 模式与临时 URL 模式）；
 * 2. 捕获临时隧道生成的 trycloudflare.com 域名；
 * 3. 优雅停止与生命周期防孤儿进程清理；
 * 4. 状态查询与错误回显。
 */
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface TunnelOptions {
  port: number;
  tunnelToken?: string;
  customPath?: string;
  onUrlDetected?: (url: string) => void;
  onError?: (err: string) => void;
}

export interface TunnelStatus {
  running: boolean;
  mode: 'fixed' | 'quick' | 'none';
  url: string;
  pid: number | null;
  error: string;
}

let tunnelProc: ChildProcess | null = null;
let currentUrl = '';
let currentError = '';
let currentMode: 'fixed' | 'quick' | 'none' = 'none';
let pendingStartTimer: any = null;

// ===== 自愈（意外退出后自动重启）=====
/** 最近一次启动参数（供自动重启复用） */
let lastStartOpts: TunnelOptions | null = null;
/** 自动重启定时器 */
let restartTimer: any = null;
/** 连续重启失败次数（成功启动后清零；超上限放弃） */
let restartAttempts = 0;
/** 连续重启失败上限 */
const MAX_RESTART_ATTEMPTS = 5;
/** 重启退避基数（ms） */
const RESTART_BASE_MS = 3000;
/** 代际号：每次 start/stop 自增。onExit 只处理"自己那一代"的退出，
 *  避免旧进程的异步 exit 抹掉新进程引用（僵尸/重复进程）或误触发重启。 */
let tunnelGen = 0;

/** 安排一次自动重启（带退避）；超上限则放弃并记录错误。
 *  myGen：发起时的代际；执行时若已换代（stop / 手动重启）则放弃。 */
function scheduleRestart(myGen: number): void {
  if (myGen !== tunnelGen) return; // 已被新代取代
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    currentError = 'cloudflared 连续重启失败 ' + MAX_RESTART_ATTEMPTS + ' 次，已放弃（请检查网络/安装）';
    console.warn('[Remote] ' + currentError);
    return;
  }
  if (restartTimer) return;
  restartAttempts++;
  const delay = Math.min(RESTART_BASE_MS * restartAttempts, 30000);
  console.log('[Remote] cloudflared 意外退出，' + delay + 'ms 后自动重启（第 ' + restartAttempts + ' 次）');
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (myGen !== tunnelGen || !lastStartOpts) return; // 已被取代或无可复用参数
    startTunnel(lastStartOpts).then((r) => {
      if (r.ok) {
        console.log('[Remote] cloudflared 已自动恢复' + (r.url ? '：' + r.url : ''));
      } else {
        console.warn('[Remote] cloudflared 自动重启未成功:', r.error);
        scheduleRestart(tunnelGen); // 继续退避重试（当前代）
      }
    }).catch(() => scheduleRestart(tunnelGen));
  }, delay);
}

/**
 * S-003：按"谁可写"排序 cloudflared 候选路径。
 * 优先受 ACL 保护的 Program Files（仅管理员可写）与用户目录 LocalAppData，
 * 最后才是 C:\cloudflared、C:\tools 这类任意用户可写的根目录。
 * 单位置安装无回归（只有一个存在就被选中）。纯函数，可单测。
 */
export function buildCloudflaredCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return ['cloudflared'];
  const out: string[] = [
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  ];
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe'));
  out.push(
    'C:\\cloudflared\\cloudflared.exe',
    'C:\\tools\\cloudflared\\cloudflared.exe',
    'D:\\cloudflared\\cloudflared.exe',
    'D:\\tools\\cloudflared\\cloudflared.exe',
  );
  return out;
}

/** 寻找可用的 cloudflared 路径 */
export function findCloudflaredBinary(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const envPath = process.env.CLOUDFLARED_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  for (const p of buildCloudflaredCandidates(process.platform, process.env)) {
    if (p.includes('\\') || p.includes('/')) {
      if (fs.existsSync(p)) return p;
    }
  }
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** 彻底杀死子进程（兼容跨平台与 Windows 进程树） */
function killProcTree(proc: ChildProcess | null): void {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    proc.kill('SIGTERM');
  } catch (_) {
    try { proc.kill(); } catch (__) {}
  }
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    } catch (_) {}
  }
}

/** 启动 Cloudflare 隧道子进程 */
export function startTunnel(opts: TunnelOptions): Promise<{ ok: boolean; url?: string; error?: string }> {
  return new Promise((resolve) => {
    if (tunnelProc && !tunnelProc.killed) {
      return resolve({ ok: true, url: currentUrl });
    }

    // 记录本次启动参数（供自动重启复用）；自增代际（作废上一代的 onExit 回调）
    lastStartOpts = opts;
    const myGen = ++tunnelGen;

    if (pendingStartTimer) {
      clearTimeout(pendingStartTimer);
      pendingStartTimer = null;
    }
    // 清残留的重启计划：本函数代表"新一代"，旧代的待触发重启必须作废，
    // 否则新进程若又死亡，scheduleRestart 会因 restartTimer 非空而直接 return（自愈失效）
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

    const bin = findCloudflaredBinary(opts.customPath);
    if (!bin) {
      currentError = '未找到 cloudflared 可执行文件';
      return resolve({ ok: false, error: currentError });
    }

    currentUrl = '';
    currentError = '';
    const args: string[] = [];

    if (opts.tunnelToken && opts.tunnelToken.trim()) {
      currentMode = 'fixed';
      args.push('tunnel', 'run', '--token', opts.tunnelToken.trim());
    } else {
      currentMode = 'quick';
      args.push('tunnel', '--url', `http://127.0.0.1:${opts.port}`);
    }

    let myProc: any = null;
    try {
      myProc = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      tunnelProc = myProc;
    } catch (err: any) {
      currentError = err.message || '启动 cloudflared 失败';
      currentMode = 'none';
      return resolve({ ok: false, error: currentError });
    }

    let resolved = false;

    const onExit = (code: number | null, signal: string | null) => {
      // 只处理"自己这一代"的退出；若是旧代（已被 stop / 新 start 取代）则完全忽略，
      // 否则异步到达的旧 exit 会抹掉新进程引用 / 误触发重启（僵尸与重复进程）。
      if (myGen !== tunnelGen) return;
      if (tunnelProc === myProc) {
        tunnelProc = null;
        currentMode = 'none';
      }
      if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
      if (!resolved) {
        resolved = true;
        currentError = currentError || `cloudflared 进程异常退出 (code: ${code}, signal: ${signal})`;
        resolve({ ok: false, error: currentError });
      }
      // 意外退出（当前代、非主动停止、非致命启动错误）→ 自动重启，避免隧道永久失效
      if (myGen === tunnelGen && !fatalStartError) scheduleRestart(myGen);
    };

    myProc.on('exit', onExit);
    // 致命启动错误（找不到/无法执行二进制）：不进入自动重启（重试无意义）
    let fatalStartError = false;
    myProc.on('error', (err: any) => {
      if (myGen !== tunnelGen) return; // 旧代（已被 stop / 新 start 取代）忽略，防污染状态
      if (err.code === 'ENOENT' || err.code === 'EACCES') fatalStartError = true;
      currentError = err.code === 'ENOENT'
        ? '系统中未检测到 cloudflared，请先安装或将 cloudflared 加入环境变量 PATH'
        : (err.message || 'cloudflared 执行错误');
      if (opts.onError) opts.onError(currentError);
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: currentError });
      }
    });

    const checkOutput = (data: Buffer) => {
      // 性能防护：若已有 URL 或固定隧道模式，直接跳过正则匹配，降低 CPU 消耗
      if (currentUrl || currentMode === 'fixed') return;
      const text = data.toString('utf-8');
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        currentUrl = match[0];
        if (opts.onUrlDetected) opts.onUrlDetected(currentUrl);
        if (!resolved) {
          resolved = true;
          if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
          restartAttempts = 0; // 启动成功，重置退避计数（含手动重启）
          resolve({ ok: true, url: currentUrl });
        }
      }
    };

    if (myProc.stdout) myProc.stdout.on('data', checkOutput);
    if (myProc.stderr) myProc.stderr.on('data', checkOutput);

    // 固定模式下不会输出 trycloudflare URL，等待 1.5 秒无错误则视为启动成功
    if (currentMode === 'fixed') {
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!resolved && myProc && !myProc.killed) {
          resolved = true;
          restartAttempts = 0; // 启动成功，重置退避计数
          resolve({ ok: true });
        }
      }, 1500);
    } else {
      // 临时隧道等待最多 12 秒捕获 URL
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!resolved) {
          resolved = true;
          if (myProc && !myProc.killed && currentUrl) {
            restartAttempts = 0;
            resolve({ ok: true, url: currentUrl });
          } else {
            resolve({ ok: false, error: currentError || '启动临时隧道超时（未获取到公网地址）' });
          }
        }
      }, 12000);
    }
  });
}

/** 停止 Cloudflare 隧道子进程 */
export function stopTunnel(): Promise<void> {
  return new Promise((resolve) => {
    // 主动停止：自增代际（作废在途 onExit）+ 清重启计划（防 stop 触发 onExit 后又自动重启）
    tunnelGen++;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartAttempts = 0;
    lastStartOpts = null; // 清启动参数：停止后不应被任何残留逻辑复用重启
    if (pendingStartTimer) {
      clearTimeout(pendingStartTimer);
      pendingStartTimer = null;
    }
    if (!tunnelProc) {
      currentMode = 'none';
      currentUrl = '';
      currentError = '';
      return resolve();
    }
    const proc = tunnelProc;
    tunnelProc = null;
    currentMode = 'none';
    currentUrl = '';
    currentError = '';

    let timer: any = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };

    proc.once('exit', finish);
    killProcTree(proc);

    // 1 秒未能退出则强杀
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      finish();
    }, 1000);
  });
}

/** 获取当前隧道运行状态 */
export function getTunnelStatus(): TunnelStatus {
  return {
    running: !!(tunnelProc && !tunnelProc.killed),
    mode: currentMode,
    url: currentUrl,
    pid: tunnelProc ? tunnelProc.pid || null : null,
    error: currentError,
  };
}

// 防孤儿进程退出钩子
process.on('exit', () => {
  if (tunnelProc && !tunnelProc.killed) {
    killProcTree(tunnelProc);
  }
});
