/**
 * IPC：源代码管理（Git 暂存 / 提交 / 撤销 / 历史）
 * 壳页面通过 window.shellAPI 调用：
 *  - git-status       ：列出改动（git status --porcelain）
 *  - git-stage        ：暂存单个文件（git add）
 *  - git-unstage      ：取消暂存（git restore --staged）
 *  - git-restore      ：撤销工作区改动（git restore，危险）
 *  - git-commit       ：提交已暂存改动（git commit）
 *  - git-log          ：提交历史列表（git log）
 *  - git-show-commit  ：某次提交的改动摘要（git show --stat）
 *  - git-watch-start  ：监听项目目录变化（自动刷新用，递归 fs.watch）
 *
 * 安全：execFile('git', [参数数组])，绝不拼 shell 字符串（防注入）；
 *       路径过 resolveProjectPath 校验（防目录穿越）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as windowState from '../window.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

// ===== 项目目录 watcher（Git 面板自动刷新用） =====
/** 按 webContents id 管理 watcher */
const gitWatchers = new Map<number, { watcher: any; root: string; timer: any }>();
const gitWatcherBound = new Set<number>();

/** 清理指定 webContents 的 watcher */
function clearGitWatcher(wcId: number): void {
  const w = gitWatchers.get(wcId);
  if (!w) return;
  try { if (w.timer) clearTimeout(w.timer); } catch (_) { /* ignore */ }
  try { w.watcher.close(); } catch (_) { /* ignore */ }
  gitWatchers.delete(wcId);
}

/**
 * 噪声路径过滤：这些目录的高频变动与 git 状态无关，忽略以免频繁刷新。
 * 注意保留 .git/index、.git/refs、.git/HEAD——它们变化正是"暂存/提交"的体现。
 */
function isNoisePath(p: any): boolean {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/');
  return /(^|\/)(node_modules|\.git\/objects|\.git\/logs|dist|out|build|\.cache|\.next|coverage|wyp|release|dist-verify|\.playwright-mcp|\.turbo|target|__pycache__|\.venv)(\/|$)/.test(s);
}

/** 解析并校验项目内相对路径（防目录穿越），返回绝对路径或 null */
function resolveProjectPath(store: any, relPath: string): string | null {
  const rootDir = (store && store.state && store.state.selectedProjectDir) || null;
  if (!rootDir || !relPath || typeof relPath !== 'string') return null;
  const abs = path.resolve(rootDir, relPath);
  const rootAbs = path.resolve(rootDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

/** 取当前窗口的项目根目录（绝对路径），无则 null */
function getProjectRoot(event: any): string | null {
  const ctx = windowState.getContextByWebContents(event.sender);
  const store = ctx ? ctx.sessionStore : null;
  const rootDir = (store && store.state && store.state.selectedProjectDir) || null;
  return rootDir ? path.resolve(rootDir) : null;
}

/**
 * git 命令全局串行队列。
 * 原因：git 写操作（add/reset/restore/commit）与 git status 都会争抢 .git/index.lock。
 * git status 为刷新 stat 缓存也会写 index，因此它和写操作并发时同样会导致
 * "fatal: Unable to create '.git/index.lock': File exists"，表现为用户点了按钮没反应。
 * 串行化后所有 git 命令按发起顺序执行，从根上消除锁竞争。
 */
let gitQueue: Promise<unknown> = Promise.resolve();

/** 单条 git 命令的超时上限。
 *  串行队列的代价是"前一条卡住，后面全等"——没超时的话一条挂死会拖垮整个面板。
 *  30 秒足够覆盖超大仓库的 status/log，超过就是异常，强制终止让队列继续走。 */
const GIT_TIMEOUT_MS = 30000;

/** 执行 git 命令（参数数组，cwd=项目根），返回 { success, stdout, stderr }
 *  所有调用都经过全局串行队列，按发起顺序执行。 */
function runGit(root: string, args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const exec = () => new Promise<{ success: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err: any, stdout: string, stderr: string) => {
      if (err) {
        // 超时被强制终止：给出可操作的中文提示，而不是 Node 原始的 "Command failed"
        if (err.killed || err.signal) {
          return resolve({
            success: false,
            stdout: stdout || '',
            stderr: 'git 命令执行超时（' + GIT_TIMEOUT_MS / 1000 + ' 秒），已强制终止。可能是仓库过大或磁盘繁忙。\n若后续操作报 index.lock 错误，请手动删除 .git/index.lock。',
          });
        }
        return resolve({ success: false, stdout: stdout || '', stderr: stderr || err.message });
      }
      resolve({ success: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
  // 用 then(exec, exec)：即使前一条失败也继续执行下一条，避免一次失败把队列卡死
  const next = gitQueue.then(exec, exec);
  gitQueue = next.then(() => {}, () => {});
  return next;
}

/** 还原 git 带引号路径的转义（\\" → "、\\n → 换行、\\ooo → 八进制字节） */
function unquoteGitPath(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { bytes.push(s.charCodeAt(i)); continue; }
    const n = s[i + 1];
    if (n === undefined) { bytes.push(92); break; }
    if (n >= '0' && n <= '7') {
      // 八进制转义（最多 3 位）→ 原始字节
      let oct = '';
      let j = i + 1;
      while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') { oct += s[j]; j++; }
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
      bytes.push(map[n] !== undefined ? map[n] : s.charCodeAt(i + 1));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** 解析 git status --porcelain=v1 输出为条目列表 */
function parseStatus(stdout: string): Array<{ path: string; x: string; y: string; staged: boolean; unstaged: boolean }> {
  const items: Array<{ path: string; x: string; y: string; staged: boolean; unstaged: boolean }> = [];
  for (const line of stdout.split('\n')) {
    if (!line || line.length < 4) continue;
    const x = line[0];       // 暂存区状态
    const y = line[1];       // 工作区状态
    let p = line.slice(3);   // 路径（可能带引号）
    // 重命名：'R  old -> new'，取新路径
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = unquoteGitPath(p.slice(1, -1));
    const staged = x !== ' ' && x !== '?';
    const unstaged = (y !== ' ' && y !== '?') || x === '?';
    items.push({ path: p, x, y, staged, unstaged });
  }
  return items;
}

function registerGitIpc(): void {
  // 列出改动
  ipcMain.handle('git-status', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    // core.quotepath=false：避免中文/非 ASCII 文件名被输出成八进制转义
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']);
    if (!r.success) {
      const msg = (r.stderr || '').toLowerCase().includes('not a git repository')
        ? '当前目录不是 Git 仓库'
        : (r.stderr || 'git status 失败');
      return { success: false, error: msg.trim() };
    }
    return { success: true, items: parseStatus(r.stdout), root };
  });

  // 全部暂存：一条 `git add -A` 取代逐个文件（几百文件时避免几百次 git 进程）
  ipcMain.handle('git-stage-all', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    const r = await runGit(root, ['add', '-A']);
    return r.success ? { success: true } : { success: false, error: r.stderr.trim() };
  });

  // 全部取消暂存：一条 `git reset` 取代逐个文件
  ipcMain.handle('git-unstage-all', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    let r = await runGit(root, ['reset', '-q']);
    // 首次提交前无 HEAD：实测 git reset 可正常 unstage（exit=0），此回退为防御性兜底
    if (!r.success && /could not resolve HEAD|Failed to resolve|bad revision|unknown revision|no such ref|ambiguous argument/i.test(r.stderr)) {
      r = await runGit(root, ['rm', '--cached', '-r', '--force', '-q', '.']);
    }
    return r.success ? { success: true } : { success: false, error: r.stderr.trim() };
  });

  // 暂存单个文件
  ipcMain.handle('git-stage', async (event: any, { relPath }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const abs = resolveProjectPath(store, relPath);
    if (!abs) return { success: false, error: '非法路径或未选目录' };
    const root = getProjectRoot(event)!;
    const r = await runGit(root, ['add', '--', relPath]);
    return r.success ? { success: true } : { success: false, error: r.stderr.trim() };
  });

  // 取消暂存
  ipcMain.handle('git-unstage', async (event: any, { relPath }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const abs = resolveProjectPath(store, relPath);
    if (!abs) return { success: false, error: '非法路径或未选目录' };
    const root = getProjectRoot(event)!;
    let r = await runGit(root, ['restore', '--staged', '--', relPath]);
    // 首次提交前无 HEAD：restore --staged 会失败，回退 git rm --cached
    if (!r.success && /could not resolve HEAD|unknown revision|no such ref/i.test(r.stderr)) {
      r = await runGit(root, ['rm', '--cached', '--force', '--', relPath]);
    }
    return r.success ? { success: true } : { success: false, error: r.stderr.trim() };
  });

  // 撤销工作区改动（危险：丢弃未提交的修改）
  ipcMain.handle('git-restore', async (event: any, { relPath }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const abs = resolveProjectPath(store, relPath);
    if (!abs) return { success: false, error: '非法路径或未选目录' };
    const root = getProjectRoot(event)!;
    const r = await runGit(root, ['restore', '--', relPath]);
    return r.success ? { success: true } : { success: false, error: r.stderr.trim() };
  });

  // 全部撤销「更改区」改动（危险）：清空所有未暂存内容
  //  1. 已跟踪文件：从暂存区恢复到工作区（不动暂存区）
  //  2. 未跟踪文件与目录：删除（不带 -x，故被 .gitignore 忽略的不会删）
  // 已暂存的改动不受影响（它们属于「已暂存」区，用「全部取消」处理）。
  ipcMain.handle('git-discard-all', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    const r1 = await runGit(root, ['restore', '--', '.']);
    if (!r1.success) return { success: false, error: r1.stderr.trim() };
    const r2 = await runGit(root, ['clean', '-fd']);
    if (!r2.success) return { success: false, error: r2.stderr.trim() };
    return { success: true };
  });

  // 删除未跟踪文件（未跟踪文件无法用 git restore 撤销，只能删除）
  ipcMain.handle('git-discard-untracked', async (event: any, { relPath }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const abs = resolveProjectPath(store, relPath);
    if (!abs) return { success: false, error: '非法路径或未选目录' };
    try {
      if (!fs.existsSync(abs)) return { success: true };
      fs.rmSync(abs, { force: true });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 提交（只提交已暂存改动）
  ipcMain.handle('git-commit', async (event: any, { message }: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) return { success: false, error: '提交信息不能为空' };
    const r = await runGit(root, ['commit', '-m', msg]);
    if (!r.success) return { success: false, error: r.stderr.trim() || '提交失败' };
    return { success: true, stdout: r.stdout.trim() };
  });

  // 当前分支名
  ipcMain.handle('git-current-branch', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    const r = await runGit(root, ['branch', '--show-current']);
    if (!r.success) {
      const msg = (r.stderr || '').toLowerCase().includes('not a git repository')
        ? '当前目录不是 Git 仓库' : (r.stderr || 'git branch 失败');
      return { success: false, error: msg.trim() };
    }
    // 空 = detached HEAD；用短 hash 显示
    let branch = r.stdout.trim();
    if (!branch) {
      const h = await runGit(root, ['rev-parse', '--short', 'HEAD']);
      branch = h.success ? '(detached ' + h.stdout.trim() + ')' : '(detached)';
    }
    return { success: true, branch };
  });

  // 本地分支列表
  ipcMain.handle('git-list-branches', async (event: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    const cur = await runGit(root, ['branch', '--show-current']);
    const current = cur.success ? cur.stdout.trim() : '';
    const r = await runGit(root, ['branch', '--format=%(refname:short)']);
    if (!r.success) return { success: false, error: r.stderr.trim() };
    const branches = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return { success: true, branches, current };
  });

  // 开始监听项目目录变化（Git 面板自动刷新用）；recursive 不支持时返回 fallback 提示壳页面轮询
  ipcMain.handle('git-watch-start', async (event: any) => {
    const root = getProjectRoot(event);
    const wcId = event.sender.id;
    clearGitWatcher(wcId);
    if (!root) return { success: false, error: '未选择项目目录' };
    try {
      const watcher = fs.watch(root, { recursive: true, persistent: false }, (_evt: string, changed: any) => {
        if (changed && isNoisePath(changed)) return;
        const w = gitWatchers.get(wcId);
        if (!w) return;
        if (w.timer) clearTimeout(w.timer);
        w.timer = setTimeout(() => {
          try { if (!event.sender.isDestroyed()) event.sender.send('shell-git-changed'); } catch (_) { /* ignore */ }
        }, 400); // 防抖
      });
      gitWatchers.set(wcId, { watcher, root, timer: null });
      if (!gitWatcherBound.has(wcId)) {
        gitWatcherBound.add(wcId);
        try {
          event.sender.once('destroyed', () => { clearGitWatcher(wcId); gitWatcherBound.delete(wcId); });
        } catch (_) { gitWatcherBound.delete(wcId); }
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message, fallback: 'poll' };
    }
  });

  // 停止监听
  ipcMain.handle('git-watch-stop', async (event: any) => {
    clearGitWatcher(event.sender.id);
    return { success: true };
  });

  // 提交历史列表（默认最近 60 条）
  ipcMain.handle('git-log', async (event: any, { limit }: any = {}) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 60;
    // 字段用 \x1f（单元分隔符）拼接，避免提交信息含空格/竖线导致解析歧义
    const fmt = '%H%x1f%h%x1f%s%x1f%an%x1f%ar';
    const r = await runGit(root, ['log', '-n', String(n), '--pretty=format:' + fmt]);
    if (!r.success) {
      // 无提交（空仓库）时 git log 报错 → 返回空列表而非错误
      if (/does not have any commits|unknown revision|bad default revision/i.test(r.stderr)) {
        return { success: true, commits: [] };
      }
      const msg = (r.stderr || '').toLowerCase().includes('not a git repository')
        ? '当前目录不是 Git 仓库' : (r.stderr || 'git log 失败');
      return { success: false, error: msg.trim() };
    }
    const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
      const parts = line.split('\x1f');
      return { hash: parts[0] || '', short: parts[1] || '', subject: parts[2] || '', author: parts[3] || '', date: parts[4] || '' };
    });
    return { success: true, commits };
  });

  // 某次提交的改动摘要（文件列表 + 增删行数）
  ipcMain.handle('git-show-commit', async (event: any, { hash }: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    if (!hash || typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(hash)) {
      return { success: false, error: '非法提交 hash' };
    }
    // 用 git log -1 --stat：log 默认不输出 patch（--stat 只给文件与增删统计），
    // 而 git show --stat 会附带完整 diff（大提交易超 maxBuffer）。
    // format 用 %n 换行（不要用 %x1f——控制字符会显示成 □）。
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'log', '-1', '--stat', '--format=%H%n%s%n%an · %ar%n', hash]);
    if (!r.success) return { success: false, error: r.stderr.trim() || '读取提交失败' };
    return { success: true, text: r.stdout };
  });

  // 某次提交的完整 diff（diffstat + patch 文本），供详情弹框着色展示。
  // 大提交可能很大：超过 DIFF_MAX_BYTES 截断并附提示，避免 IPC/渲染压力。
  const DIFF_MAX_BYTES = 512 * 1024;
  ipcMain.handle('git-show-commit-diff', async (event: any, { hash }: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    if (!hash || typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(hash)) {
      return { success: false, error: '非法提交 hash' };
    }
    // --no-color：避免 ANSI 控制码；--patch 输出完整改动。
    // -m --first-parent：merge commit 默认不输出 patch（只给 stat），加 -m 才对每个父输出；
    //   --first-parent 限定只对比第一父，避免 merge 显示重复的多份 diff。
    //   对普通 commit 无副作用（实测与不加等价）。
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'show', '--no-color', '--patch', '--stat', '-m', '--first-parent', hash]);
    if (!r.success) return { success: false, error: r.stderr.trim() || '读取提交失败' };
    let text = r.stdout;
    let truncated = false;
    if (text.length > DIFF_MAX_BYTES) {
      text = text.slice(0, DIFF_MAX_BYTES);
      truncated = true;
    }
    return { success: true, text, truncated };
  });

  // 切换分支（先检测脏工作区）
  ipcMain.handle('git-checkout', async (event: any, { branch, force }: any) => {
    const root = getProjectRoot(event);
    if (!root) return { success: false, error: '未选择项目目录' };
    if (!branch || typeof branch !== 'string') return { success: false, error: '缺少分支名' };
    // 脏工作区检测（未暂存/未跟踪改动会导致切换冲突或丢失）
    if (!force) {
      const st = await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (st.success && st.stdout.trim()) {
        return { success: false, dirty: true, error: '有未提交的改动' };
      }
    }
    const r = await runGit(root, ['checkout', branch]);
    if (!r.success) return { success: false, error: r.stderr.trim() || '切换失败' };
    return { success: true };
  });
}

export { registerGitIpc };
