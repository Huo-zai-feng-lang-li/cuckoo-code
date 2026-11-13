#!/usr/bin/env node
/**
 * 按版本号定位 CHANGELOG 条目所在文件。
 * 用法：node scripts/changelog-locate.mjs <version>   例：node scripts/changelog-locate.mjs 0.10.226
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'changelogs');

const ver = (process.argv[2] || "").replace(/^v/, "");
if (!ver) {
  console.error('用法：node scripts/changelog-locate.mjs <version>');
  process.exit(1);
}

if (!fs.existsSync(DIR)) {
  console.error('找不到 changelogs/ 目录');
  process.exit(1);
}

const re = new RegExp('^## \\[' + ver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '\\]', "m");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort().reverse();
const hits = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  if (re.test(text)) {
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l) => re.test(l));
    hits.push({ file: path.join("changelogs", f), line: idx + 1 });
  }
}

if (!hits.length) {
  console.error('未找到版本 ' + ver);
  process.exit(2);
}
for (const h of hits) {
  console.log(h.file + ':' + h.line);
}
