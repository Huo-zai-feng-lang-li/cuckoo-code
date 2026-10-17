/**
 * 把 src/tools/runtime/js-sandbox-worker.mjs 拷到 out/src/tools/runtime/
 *（tsc 不拷贝 .mjs；运行时 JsRunner.js 用 import.meta.url 定位同目录的 worker）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd();
const src = path.join(root, 'src', 'tools', 'runtime', 'js-sandbox-worker.mjs');
const destDir = path.join(root, 'out', 'src', 'tools', 'runtime');

if (!fs.existsSync(src)) {
  console.warn('[copy-sandbox-worker] 未找到 ' + src + '，跳过');
  process.exit(0);
}
try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'js-sandbox-worker.mjs'));
  console.log('[copy-sandbox-worker] 已拷贝 worker .mjs 到 out/src/tools/runtime');
} catch (err) {
  console.warn('[copy-sandbox-worker] 拷贝失败:', err.message);
}
