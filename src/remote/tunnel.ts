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

/** 常见 Windows / 类 Unix 安装路径 */
const CANDIDATE_PATHS = [
  'D:\\cloudflared\\cloudflared.exe',
  'C:\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\tools\\cloudflared\\cloudflared.exe',
  'D:\\tools\\cloudflared\\cloudflared.exe',
  'cloudflared.exe',
  'cloudflared',
];

/** 寻找可用的 cloudflared 路径 */
export function findCloudflaredBinary(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const envPath = process.env.CLOUDFLARED_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  for (const p of CANDIDATE_PATHS) {
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

    if (pendingStartTimer) {
      clearTimeout(pendingStartTimer);
      pendingStartTimer = null;
    }

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

    try {
      tunnelProc = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      currentError = err.message || '启动 cloudflared 失败';
      currentMode = 'none';
      return resolve({ ok: false, error: currentError });
    }

    let resolved = false;

    const onExit = (code: number | null, signal: string | null) => {
      tunnelProc = null;
      currentMode = 'none';
      if (!resolved) {
        resolved = true;
        currentError = currentError || `cloudflared 进程异常退出 (code: ${code}, signal: ${signal})`;
        resolve({ ok: false, error: currentError });
      }
    };

    tunnelProc.on('exit', onExit);
    tunnelProc.on('error', (err: any) => {
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
          resolve({ ok: true, url: currentUrl });
        }
      }
    };

    if (tunnelProc.stdout) tunnelProc.stdout.on('data', checkOutput);
    if (tunnelProc.stderr) tunnelProc.stderr.on('data', checkOutput);

    // 固定模式下不会输出 trycloudflare URL，等待 1.5 秒无错误则视为启动成功
    if (currentMode === 'fixed') {
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!resolved && tunnelProc && !tunnelProc.killed) {
          resolved = true;
          resolve({ ok: true });
        }
      }, 1500);
    } else {
      // 临时隧道等待最多 12 秒捕获 URL
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!resolved) {
          resolved = true;
          if (tunnelProc && !tunnelProc.killed && currentUrl) {
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
