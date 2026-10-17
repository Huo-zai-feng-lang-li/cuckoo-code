'use strict';
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-atomic-'));
process.env.CUCKOO_HOME = TMP;

const { writeJsonAtomicSync, writeJsonAtomic, readJsonRobustSync } = await import('../../src/infra/atomic-json.js');

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('写后读回 roundtrip', () => {
  const file = path.join(TMP, 'roundtrip.json');
  expect(writeJsonAtomicSync(file, { a: 1, b: 'x' })).toBe(true);
  expect(readJsonRobustSync(file, null)).toEqual({ a: 1, b: 'x' });
});

test('keepBackup：主文件损坏时回退 .bak', () => {
  const file = path.join(TMP, 'backup.json');
  writeJsonAtomicSync(file, { version: 1, data: 'old-good' });
  // 第二次写带 keepBackup：rename 前旧文件被存为 .bak
  writeJsonAtomicSync(file, { version: 2, data: 'new-broken' }, { keepBackup: true });
  // 模拟崩溃截断：主文件写成半截 JSON
  fs.writeFileSync(file, '{"version": 2, "data": "bro', 'utf-8');
  const got = readJsonRobustSync(file, { fallback: true });
  expect(got).toEqual({ version: 1, data: 'old-good' });
});

test('主文件损坏且无 .bak → 退回 fallback', () => {
  const file = path.join(TMP, 'corrupt-no-bak.json');
  fs.writeFileSync(file, '{broken json', 'utf-8');
  const got = readJsonRobustSync(file, { fallback: true });
  expect(got).toEqual({ fallback: true });
});

test('文件不存在 → 静默用 fallback', () => {
  const got = readJsonRobustSync(path.join(TMP, 'no-such-file.json'), { d: 1 });
  expect(got).toEqual({ d: 1 });
});

test('写入后不留临时文件', () => {
  const file = path.join(TMP, 'notmp.json');
  writeJsonAtomicSync(file, { x: 1 });
  const leftovers = fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp'));
  expect(leftovers).toEqual([]);
});

test('异步写同样可用', async () => {
  const file = path.join(TMP, 'async.json');
  expect(await writeJsonAtomic(file, { n: 42 })).toBe(true);
  expect(readJsonRobustSync(file, null)).toEqual({ n: 42 });
});
