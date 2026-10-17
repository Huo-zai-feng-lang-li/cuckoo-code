/**
 * 前台命令捕获执行（bash/pwsh 工具共用，修 A-006）
 *
 * 与 child_process.exec 的区别：
 *  - 用 spawn 拿到 child.pid，超时/结束时走 killProcessTree 杀整个进程树
 *    （Windows taskkill /T 连带子孙进程；Unix detached 进程组 kill(-pgid)），
 *    杜绝 exec 只杀 shell 本体、孙进程孤儿化的问题。
 *  - stdout/stderr 缓冲上限 maxBuffer（与原 exec 一致，默认 1MB）。
 *
 * 残余限制：Windows 上 `start /b` 主动脱离 shell 的长驻进程无法事后回收
 * （shell 已退出，taskkill /T 无根可寻）——这类场景应提示 AI 用 background:true
 * （task-manager 全程跟踪 + 可停止）。
 */
import { spawn } from 'node:child_process';
import { killProcessTree } from './task-manager.js';
import { trackProcess } from './process-tracker.js';

export interface RunCapturedOptions {
  cwd: string;
  /** 超时毫秒；到点强杀整个进程树 */
  timeout: number;
  /** stdout/stderr 缓冲上限（字节），默认 1MB */
  maxBuffer?: number;
  /** command 是整条 shell 命令时传 true（等价 exec 的 shell:true） */
  shell?: boolean;
  /** 发起调用的窗口 id（用于用户点“停止”时按窗口强杀） */
  windowId?: number | null;
}

export interface RunCapturedResult {
  stdout: Buffer;
  stderr: Buffer;
  /** 退出码；被强杀时为 null */
  code: number | null;
  /** 是否因超时被强杀 */
  timedOut: boolean;
  /** spawn 层错误（如命令不存在），无则 undefined */
  spawnError?: string;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * 执行命令并捕获 stdout/stderr。
 * @param command shell 命令串（shell=true 时）或可执行文件路径
 * @param args command 为可执行文件时的参数；shell=true 时传 null
 */
export function runCaptured(
  command: string,
  args: string[] | null,
  opts: RunCapturedOptions,
): Promise<RunCapturedResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = args === null
      ? spawn(command, {
          cwd: opts.cwd,
          windowsHide: true,
          shell: opts.shell === true,
          detached: !isWin, // Unix：自成进程组，超时可整组 kill
          env: { ...process.env },
        })
      : spawn(command, args, {
          cwd: opts.cwd,
          windowsHide: true,
          detached: !isWin,
          env: { ...process.env },
        });

    // 登记到全局追踪器，允许外部（如停止按钮）强杀
    trackProcess(child, opts.windowId ?? null);

    const max = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let done = false;

    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid as number, 'SIGKILL');
    }, opts.timeout);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout = Buffer.concat([stdout, d]);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr = Buffer.concat([stderr, d]);
    });
    child.on('error', (err: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut: false, spawnError: String((err && err.message) || err) });
    });
    child.on('close', (code: number | null) => finish(code));
  });
}
