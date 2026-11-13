/**
 * 构建代码语法着色产物（highlight.js）。
 *
 * 只打包 highlight.js 的 core + 常用语言（而非全量 190+ 语言），
 * 用 esbuild 打成自包含 IIFE，输出到 src/ui/vendor/hljs/hljs.min.js，
 * 挂到 window.hljs，供静态页面（src/ui/harness.html）以
 * <script src="vendor/hljs/hljs.min.js"> 加载。
 *
 * 为什么不直接用 highlight.js 的 CDN / 自带主题 CSS：
 *  - 应用离线运行（Electron），不能依赖 CDN；
 *  - 自带主题写死颜色，与本项目 --ck-* 明暗主题体系冲突，配色改由 harness.css 的 --hl-* 变量提供。
 *
 * 用法：node scripts/build-hljs.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src', 'ui', 'vendor', 'hljs', 'hljs.min.js');

/** 注册语言：模块名 = hljs 语言 id；别名（js/ts/html/yml/cs…）由 hljs 语言定义自带 */
const LANGS = [
  'javascript', 'typescript', 'python', 'json', 'bash', 'xml', 'css', 'scss',
  'markdown', 'yaml', 'sql', 'java', 'c', 'cpp', 'csharp', 'go', 'rust',
  'php', 'ruby', 'kotlin', 'swift', 'dockerfile', 'ini', 'plaintext',
];

const imports = LANGS.map((l, i) => "import l" + i + " from 'highlight.js/lib/languages/" + l + "';").join('\n');
const regs = LANGS.map((l, i) => "hljs.registerLanguage('" + l + "', l" + i + ");").join('\n');

const result = await build({
  stdin: {
    contents:
      "import hljs from 'highlight.js/lib/core';\n" + imports + '\n' + regs +
      "\nglobalThis.hljs = hljs;\nexport default hljs;\n",
    resolveDir: ROOT,
    loader: 'js',
    sourcefile: 'hljs-entry.js',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'CuckooHljs',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, result.outputFiles[0].text, 'utf8');
const kb = (Buffer.byteLength(result.outputFiles[0].text) / 1024).toFixed(0);
console.log('[build-hljs] 生成 ' + path.relative(ROOT, OUT) + '（' + LANGS.length + ' 种语言，' + kb + 'KB，window.hljs）');
