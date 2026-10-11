/**
 * Cuckoo 插件安装器：下载 npm 包到 ~/.cuckoo/cuckoo-plugins/<id>/。
 * 纯 node + 子进程。
 *
 * npm 定位（三级回退，2026-10 修复）：
 *   1) 自带运行时 resources/runtime/<platform>/bin/npm（打包版才有）
 *   2) 系统 npm（PATH / 常见安装位置）—— 开发版绝大多数走这条
 *   3) 都找不到 → 抛错并给出安装引导
 *
 * 安装后四态验证（对齐 dsh-market 的 live/restart/inert/broken）：
 *   - live：装完能立即加载（有入口 + dsh.bundle 声明）
 *   - restart：需要重启才生效
 *   - inert：装了但不生效（无 dsh 声明，或找不到入口）
 *   - broken：装失败或目录不完整
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getCuckooPluginDir, isValidPluginId } from './paths.js';

/** 平台目录名（与 mcp/client.ts 的运行时定位一致） */
function platformDir(): string | null {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return null;
}

/** 应用根（out/src/plugins/cuckoo-plugins → ../../../..） */
function appRoot(): string {
  return path.join(import.meta.dirname, '..', '..', '..', '..');
}

/** 找自带的 npm（resources/runtime/<platform>/bin/） */
function bundledNpm(): { cmd: string; binDir: string } | null {
  const platform = platformDir();
  if (!platform) return null;
  const binDir = path.join(appRoot(), 'resources', 'runtime', platform, 'bin');
  const cmd = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(cmd)) return { cmd, binDir };
  return null;
}

/**
 * 在 PATH 里找可执行文件（Windows 还会试 .cmd/.exe 后缀）。
 * 不依赖 `which`/`where`，自己遍历 PATH —— 子进程环境可能被裁剪。
 */
function findInPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
    }
  }
  return null;
}

/** 找系统 npm（常见安装位置兜底，PATH 里没有时） */
function systemNpm(): { cmd: string; binDir: string } | null {
  // 1) PATH
  const fromPath = findInPath(process.platform === 'win32' ? 'npm' : 'npm');
  if (fromPath) return { cmd: fromPath, binDir: path.dirname(fromPath) };
  // 2) Windows 常见位置
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npm.cmd'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'npm.cmd'),
      path.join(process.env.APPDATA || '', 'npm', 'npm.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'npm.cmd'),
    ];
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return { cmd: c, binDir: path.dirname(c) }; } catch { /* ignore */ }
    }
  }
  // 3) macOS / Linux 常见位置
  const unixCandidates = ['/usr/local/bin/npm', '/usr/bin/npm', '/opt/homebrew/bin/npm'];
  for (const c of unixCandidates) {
    try { if (fs.existsSync(c)) return { cmd: c, binDir: path.dirname(c) }; } catch { /* ignore */ }
  }
  return null;
}

/** 解析 npm：自带优先，其次系统 */
function resolveNpm(): { cmd: string; binDir: string; source: 'bundled' | 'system' } {
  const b = bundledNpm();
  if (b) return { ...b, source: 'bundled' };
  const s = systemNpm();
  if (s) return { ...s, source: 'system' };
  throw new Error(
    '找不到 npm。请安装 Node.js（含 npm）后重试，' +
    '或把便携运行时放到 resources/runtime/' + (platformDir() || '<platform>') + '/bin/'
  );
}

/** 从包名提取"插件 id"（@scope/name → scope-name） */
function packageNameToId(pkgName: string): string {
  return pkgName.replace(/^@/, '').replace(/\//g, '-').toLowerCase();
}

/** 安装结果（含四态） */
export interface CuckooInstallResult {
  id: string;
  dir: string;
  /** 装完的实际状态 */
  state: 'live' | 'restart' | 'inert' | 'broken';
  /** 人话说明（给 UI 显示） */
  note: string;
  /** 命中的包名（npm 可能装到子目录） */
  installedPkg?: string;
  npmSource: 'bundled' | 'system';
}

/** 读 package.json（容错） */
function readPkgJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * 在安装目录里找"真正的插件包"：
 *  1) 目录自身就是包（直接 install 了包，或有 index.js）
 *  2) 目录是壳（只有 dependencies）→ 去 node_modules/<dep> 找
 */
function findRealPlugin(dir: string, pkgName: string): { dir: string; pkg: any } | null {
  const selfPkg = readPkgJson(path.join(dir, 'package.json'));
  // 目录自身有入口 → 就是它
  const hasOwnEntry = !!(
    (selfPkg && (selfPkg.main || selfPkg.module)) ||
    fs.existsSync(path.join(dir, 'index.js')) ||
    fs.existsSync(path.join(dir, 'lib', 'index.js')) ||
    fs.existsSync(path.join(dir, 'dist', 'index.js'))
  );
  if (hasOwnEntry && selfPkg && selfPkg.name === pkgName) return { dir, pkg: selfPkg };

  // 壳目录：找 node_modules 里的实际包
  const nm = path.join(dir, 'node_modules');
  const candidates: string[] = [];
  if (pkgName) candidates.push(path.join(nm, pkgName));
  // 兼容 scope 包：node_modules/@scope/name
  const deps = (selfPkg && selfPkg.dependencies) || {};
  for (const d of Object.keys(deps)) candidates.push(path.join(nm, d));
  for (const c of candidates) {
    const p = readPkgJson(path.join(c, 'package.json'));
    if (!p) continue;
    const hasEntry = !!(p.main || p.module) ||
      fs.existsSync(path.join(c, 'index.js')) ||
      fs.existsSync(path.join(c, 'lib', 'index.js')) ||
      fs.existsSync(path.join(c, 'dist', 'index.js'));
    if (hasEntry) return { dir: c, pkg: p };
  }
  // 最后兜底：目录自身
  if (selfPkg) return { dir, pkg: selfPkg };
  return null;
}

/** 判定装完的状态 */
function judgeState(real: { dir: string; pkg: any } | null): { state: CuckooInstallResult['state']; note: string } {
  if (!real) return { state: 'broken', note: '安装目录里找不到可加载的插件入口' };
  const pkg = real.pkg || {};
  const dsh = pkg.dsh || {};
  const hasBundle = !!(dsh.bundle && dsh.bundle.patch);
  const hasClient = !!dsh.client;
  if (hasBundle || hasClient) {
    return { state: 'restart', note: '已安装，重启后生效' + (hasClient ? '（含界面扩展）' : '') };
  }
  // 有入口但没 dsh 声明：Cuckoo 仍能按 main/index.js 尝试加载，但不像标准 DSH 插件
  return { state: 'inert', note: '已安装，但该包未声明 dsh 字段（可能不是标准插件，或需重启后手动启用）' };
}

/**
 * 安装 npm 包到插件目录。
 * @param pkgName npm 包名（如 dsh-greet-tool 或 @scope/name）
 */
async function installCuckooPlugin(pkgName: string): Promise<CuckooInstallResult> {
  if (!pkgName || typeof pkgName !== 'string') throw new Error('包名不能为空');
  const id = packageNameToId(pkgName);
  if (!isValidPluginId(id)) throw new Error('包名转 id 非法: ' + id);
  const dir = getCuckooPluginDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const npm = resolveNpm();
  // 写一个最小 package.json（npm install 需要）
  const pkgJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: id, version: '1.0.0', private: true }, null, 2), 'utf-8');
  }

  try {
    await runNpm(npm, ['install', pkgName, '--no-audit', '--no-fund', '--loglevel=error', '--legacy-peer-deps'], dir);
  } catch (err: any) {
    // 构建脚本被 pnpm 拦的提示（npm 也可能因 scripts 失败）
    const msg = (err && err.message) ? err.message : String(err);
    throw new Error(msg);
  }

  const real = findRealPlugin(dir, pkgName);
  const judged = judgeState(real);
  return {
    id,
    dir,
    state: judged.state,
    note: judged.note,
    installedPkg: real && real.pkg ? real.pkg.name : undefined,
    npmSource: npm.source,
  };
}

/**
 * 定位 npm-cli.js —— 绕过 .cmd 的最稳路径。
 *
 * 为什么不用 npm.cmd（Windows 实测）：
 *  - spawn('D:\\Program Files\\nodejs\\npm.cmd', ...) 会被 cmd 拆成
 *    命令 'D:\\Program' + 参数 'Files\\...'，报"不是内部或外部命令"；
 *  - 手工加引号又撞 cmd 的引号剥离规则，同样不可靠；
 *  - 直接用 node.exe 跑 npm-cli.js，**完全不需要 shell**，跨平台一致。
 *
 * 布局（标准 Node 安装 / 便携运行时都一致）：
 *   <nodeDir>/node(.exe)                       运行时
 *   <nodeDir>/npm(.cmd)                        我们拿它定位 nodeDir
 *   <nodeDir>/node_modules/npm/bin/npm-cli.js  真正的 npm 入口
 */
function resolveNpmCliJs(npmCmd: string): { node: string; cli: string } | null {
  const dir = path.dirname(npmCmd);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  let cli = '';
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { cli = c; break; } } catch { /* ignore */ }
  }
  if (!cli) return null;
  const nodeExe = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  try { if (!fs.existsSync(nodeExe)) return null; } catch { return null; }
  return { node: nodeExe, cli };
}

function runNpm(npm: { cmd: string; binDir: string }, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    env.PATH = npm.binDir + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '');
    if (process.platform === 'win32') env.Path = env.PATH;

    let cmd: string;
    let argv: string[];
    const cli = resolveNpmCliJs(npm.cmd);
    if (cli) {
      // 首选：node npm-cli.js ...（无 shell，路径空格无关紧要）
      cmd = cli.node;
      argv = [cli.cli, ...args];
    } else if (process.platform === 'win32') {
      // 回退：cmd /c 跑 .cmd（整条命令拼一个字符串交给 shell）
      const comspec = process.env.ComSpec || 'cmd.exe';
      const q = (s: string) => /[\s"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      cmd = comspec;
      argv = ['/d', '/s', '/c', q(npm.cmd) + ' ' + args.map(q).join(' ')];
    } else {
      cmd = npm.cmd;
      argv = args;
    }

    let child: any;
    try {
      child = spawn(cmd, argv, { cwd, env });
    } catch (e: any) {
      return reject(new Error('启动 npm 失败: ' + (e && e.message)));
    }

    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d: any) => { stderr += d.toString(); });
    child.stdout.on('data', (d: any) => { stdout += d.toString(); });
    child.on('error', (e: any) => reject(new Error('启动 npm 失败: ' + e.message)));
    child.on('close', (code: number) => {
      if (code === 0) return resolve();
      const tail = (stderr || stdout).slice(-800);
      reject(new Error('npm install 失败（exit ' + code + '）: ' + tail));
    });
  });
}

export { installCuckooPlugin, bundledNpm, systemNpm, resolveNpm, packageNameToId };
