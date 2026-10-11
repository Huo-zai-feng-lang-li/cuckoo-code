/**
 * 把 monaco-editor 的 min/vs 复制到 src/ui/vendor/monaco/vs
 * （Monaco 体积大，不进 git；由本脚本在 install / 启动 / 编译时补上）
 *
 * 幂等：目标已存在且版本一致时跳过（避免每次 compile 重删重拷几十 MB，
 * 也避免目录被运行中的 Electron 锁住时删除失败导致编译中断）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd();
const monacoPkg = path.join(root, 'node_modules', 'monaco-editor', 'package.json');
const src = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(root, 'src', 'ui', 'vendor', 'monaco', 'vs');
const stampFile = path.join(dest, '.cuckoo-monaco-version');

if (!fs.existsSync(src)) {
  console.warn('[copy-monaco] 未找到 node_modules/monaco-editor/min/vs，跳过（请先 npm install）');
  process.exit(0);
}

/** 读取已安装的 monaco 版本 */
function readInstalledVersion() {
  try {
    return JSON.parse(fs.readFileSync(monacoPkg, 'utf8')).version || '';
  } catch (_) {
    return '';
  }
}

const version = readInstalledVersion();

// 幂等：目标完整（有 loader.js）+ 版本戳一致 → 跳过
try {
  if (version && fs.existsSync(path.join(dest, 'loader.js')) && fs.existsSync(stampFile)) {
    if (fs.readFileSync(stampFile, 'utf8').trim() === version) {
      console.log('[copy-monaco] 已是 monaco ' + version + '，跳过复制');
      process.exit(0);
    }
  }
} catch (_) { /* 戳损坏则重新复制 */ }

try {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  if (version) {
    try { fs.writeFileSync(stampFile, version, 'utf8'); } catch (_) {}
  }
  console.log('[copy-monaco] 已复制 monaco → src/ui/vendor/monaco/vs');
} catch (err) {
  // 复制失败（常见：目录被运行中的 Electron 锁住）不应中断整个编译——
  // monaco 只用于文件预览，缺失不影响主功能。
  console.warn('[copy-monaco] 复制失败（已跳过，不影响编译）:', err.message);
  process.exit(0);
}
