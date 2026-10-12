/**
 * IPC：源代码管理（Git 暂存 / 提交 / 撤销）
 * 壳页面通过 window.shellAPI 调用：
 *  - git-status  ：列出改动（git status --porcelain）
 *  - git-stage   ：暂存单个文件（git add）
 *  - git-unstage ：取消暂存（git restore --staged）
 *  - git-restore ：撤销工作区改动（git restore，危险）
 *  - git-commit  ：提交已暂存改动（git commit）
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

/** 执行 git 命令（参数数组，cwd=项目根），返回 { success, stdout, stderr } */
function runGit(root: string, args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err: any, stdout: string, stderr: string) => {
      if (err) return resolve({ success: false, stdout: stdout || '', stderr: stderr || err.message });
      resolve({ success: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
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
}

export { registerGitIpc };
