#!/usr/bin/env node
/**
 * 一次性迁移脚本：把单文件 CHANGELOG.md 按版本日期拆分到 changelogs/YYYY-MM.md
 * 用法：node scripts/migrate-changelog.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'CHANGELOG.md');
const OUT_DIR = path.join(ROOT, 'changelogs');
const KEEP_RECENT = 5;
const DRY = process.argv.includes('--dry-run');

function splitBlocks(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## \[(.+?)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) starts.push({ ver: m[1], date: m[2], line: i });
  }
  const head = lines.slice(0, starts.length ? starts[0].line : lines.length).join('\n').trimEnd();
  const blocks = starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
    const text = lines.slice(s.line, end).join('\n').replace(/\s+$/, '');
    return { ver: s.ver, date: s.date, text };
  });
  return { head, blocks };
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error('找不到 CHANGELOG.md');
  const original = fs.readFileSync(SRC, 'utf8');
  const { blocks } = splitBlocks(original);
  if (!blocks.length) throw new Error('未解析到任何版本块');

  const byMonth = new Map();
  for (const b of blocks) {
    const key = b.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(b);
  }

  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });

  const months = [...byMonth.keys()].sort().reverse();
  for (const month of months) {
    const list = byMonth.get(month);
    const oldest = list[list.length - 1].ver;
    const newest = list[0].ver;
    const lines = [
      '# Changelog — ' + month,
      '',
      '> 本文件归档 ' + oldest + ' ~ ' + newest + ' 的全部版本记录。',
      '> 发版时新条目追加到当月文件顶部，格式见 .agents/rules/project.md「发版纪律」。',
      '',
      list.map((b) => b.text).join('\n\n'),
      '',
    ];
    const body = lines.join('\n');
    const file = path.join(OUT_DIR, month + '.md');
    if (!DRY) fs.writeFileSync(file, body, 'utf8');
    console.log('[migrate] ' + path.relative(ROOT, file) + ': ' + list.length + ' 个版本');
  }

  const recent = blocks.slice(0, KEEP_RECENT);
  const rows = months.map((m) => {
    const list = byMonth.get(m);
    const newest = list[0].ver;
    const oldest = list[list.length - 1].ver;
    return '| ' + m + ' | ' + oldest + ' ~ ' + newest + ' | ' + list.length + ' | [changelogs/' + m + '.md](changelogs/' + m + '.md) |';
  });
  const rootLines = [
    '# Changelog',
    '',
    '> 完整历史按**发布月份**归档在 `changelogs/`，本文件只保留索引与最近 ' + KEEP_RECENT + ' 个版本。',
    '> **唯一真相源是 `changelogs/YYYY-MM.md`**；发版时把新条目追加到当月文件顶部。',
    '> 查找任意版本：`node scripts/changelog-locate.mjs <版本号>`。',
    '',
    '## 版本索引',
    '',
    '| 月份 | 版本区间 | 版本数 | 文件 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## 最近 ' + KEEP_RECENT + ' 个版本',
    '',
    recent.map((b) => b.text).join('\n\n'),
    '',
  ];
  const root = rootLines.join('\n');

  if (!DRY) fs.writeFileSync(SRC, root, 'utf8');
  console.log('[migrate] CHANGELOG.md 重建：索引 ' + months.length + ' 个月份，保留最近 ' + recent.length + ' 版');
  console.log('[migrate] 版本总数：' + blocks.length + '（原文件）');
  if (DRY) console.log('[migrate] --dry-run，未写入任何文件');
}

main();
