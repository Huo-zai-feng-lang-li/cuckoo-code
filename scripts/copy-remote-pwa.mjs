/**
 * 把 src/remote/pwa 复制到 out/src/remote/pwa
 * （PWA 静态文件不是 TS，tsc 不会输出；运行时 server.ts 从编译产物同目录读）
 *
 * 幂等：目标已存在则覆盖更新。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd();
const src = path.join(root, 'src', 'remote', 'pwa');
const dest = path.join(root, 'out', 'src', 'remote', 'pwa');

if (!fs.existsSync(src)) {
  console.warn('[copy-remote-pwa] 未找到 src/remote/pwa，跳过');
  process.exit(0);
}

try {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  // 顺带把 marked（Markdown 渲染器，第三方库）从 node_modules 拷进 PWA 产物。
  // 注意：只进 out/，不进 src/（第三方库不放源码树，避免 lint）。
  const markedSrc = path.join(root, 'node_modules', 'marked', 'lib', 'marked.umd.js');
  if (fs.existsSync(markedSrc)) {
    fs.copyFileSync(markedSrc, path.join(dest, 'marked.umd.js'));
  } else {
    console.warn('[copy-remote-pwa] 未找到 marked.umd.js（Markdown 将降级为纯文本）');
  }
  console.log('[copy-remote-pwa] 已复制 PWA（含 marked）→ out/src/remote/pwa');
} catch (err) {
  console.warn('[copy-remote-pwa] 复制失败:', err.message);
}
