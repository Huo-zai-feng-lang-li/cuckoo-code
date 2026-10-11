/**
 * 给开发用的 electron.exe 打上 Cuckoo 图标（未打包时任务栏会显示 exe 内嵌图标）。
 *
 * 背景：源码运行用的是 node_modules/electron/dist/electron.exe，其内嵌图标是
 * Electron 官方原子图标 → 未打包时任务栏显示原子而非 Cuckoo。窗口标题栏虽由
 * setIcon 设为 Cuckoo，但任务栏优先用 exe 内嵌图标，故需直接改 exe。
 *
 * 幂等：用 stamp 文件记录 exe + ico 的状态，未变化时秒过。
 * 容错：exe 被运行中的 app 锁住时（无法写入）只警告、不阻断启动。
 * 注意：改的是 node_modules，npm install 重装 Electron 后会自动重新打（stamp 失效）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd();
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const ico = path.join(root, 'assets', 'icon.ico');
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const stampFile = path.join(root, 'node_modules', 'electron', 'dist', '.cuckoo-icon-stamp');

if (!fs.existsSync(exe)) { console.log('[patch-icon] 未找到 electron.exe，跳过'); process.exit(0); }
if (!fs.existsSync(ico)) { console.log('[patch-icon] 未找到 assets/icon.ico，跳过'); process.exit(0); }
if (!fs.existsSync(rcedit)) { console.log('[patch-icon] 未找到 rcedit.exe，跳过'); process.exit(0); }

/** 状态指纹：exe 与 ico 的 size+mtime，任一变化即需重打 */
function fingerprint() {
  const e = fs.statSync(exe);
  const i = fs.statSync(ico);
  return [e.size, Math.round(e.mtimeMs), i.size, Math.round(i.mtimeMs)].join(':');
}

const fp = fingerprint();
try {
  if (fs.readFileSync(stampFile, 'utf8').trim() === fp) {
    console.log('[patch-icon] electron.exe 图标已是最新，跳过');
    process.exit(0);
  }
} catch { /* 无 stamp 则继续 */ }

// 用系统 temp 中转（rcedit 0.2.0 在项目路径下偶发 "Unable to commit changes"）
const tmp = path.join(os.tmpdir(), 'cuckoo-electron-' + Date.now() + '.exe');
try {
  fs.copyFileSync(exe, tmp);
  const r = spawnSync(rcedit, [tmp, '--set-icon', ico], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('rcedit 退出码 ' + r.status);
  fs.copyFileSync(tmp, exe);
  // 打图标会改变 exe 的 mtime → 必须重算指纹再写入，否则下次 fingerprint()
  // 与 stamp 对不上，导致每次启动都重复打图标（app 开着则 EBUSY）。
  try { fs.writeFileSync(stampFile, fingerprint(), 'utf8'); } catch { /* ignore */ }
  console.log('[patch-icon] 已给 electron.exe 打上 Cuckoo 图标');
} catch (err) {
  console.warn('[patch-icon] 打图标失败（可能 app 正在运行占用 exe，不影响启动）: ' + err.message);
} finally {
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}
