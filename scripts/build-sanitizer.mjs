/**
 * 构建 sanitizer 浏览器产物（E-002 共享真源）。
 *
 * 把唯一真源 src/overlay/sanitizer.ts 用 esbuild 打成自包含 IIFE，
 * 输出到 src/ui/vendor/cuckoo-sanitize.js，挂到 window.CuckooSanitize，
 * 供静态 HTML（src/ui/harness.html，以 <script src="vendor/..."> 外部引用）加载。
 *
 * overlay（TS 直接 import）与 shell（build-shell.mjs 打包内联）均引用同一份 .ts 真源，
 * 杜绝手维护两份逻辑。本脚本只生成 harness 需要的浏览器全局产物。
 *
 * 用法：node scripts/build-sanitizer.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'overlay', 'sanitizer.ts');
const OUT = path.join(ROOT, 'src', 'ui', 'vendor', 'cuckoo-sanitize.js');

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'CuckooSanitize',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  // 确保挂到全局 window，供 harness.html 直接用 window.CuckooSanitize
  footer: { js: ';if (typeof globalThis !== "undefined") globalThis.CuckooSanitize = CuckooSanitize;' },
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, result.outputFiles[0].text, 'utf8');
console.log('[build-sanitizer] 生成 ' + path.relative(ROOT, OUT) + '（window.CuckooSanitize）');
