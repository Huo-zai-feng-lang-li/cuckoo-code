'use strict';
// A-007 回归：read/readLines/edit 在文件超大时拒绝（不全量读入内存）。
// 用 CUCKOO_READ_MAX_BYTES 把阈值压到 1MB，避免真造 200MB 文件。
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CUCKOO_READ_MAX_BYTES = '1048576'; // 1MB

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-readlimit-'));
const BIG = path.join(TMP, 'big.txt');   // 2MB
const SMALL = path.join(TMP, 'small.txt'); // 100B

const { ReadTool } = await import('../../src/tools/impl/read.js');
const { ReadLinesTool } = await import('../../src/tools/impl/read-lines.js');
const { EditTool } = await import('../../src/tools/impl/edit.js');

beforeAll(() => {
  fs.writeFileSync(BIG, 'x'.repeat(2 * 1024 * 1024), 'utf-8');
  fs.writeFileSync(SMALL, 'hello world\n', 'utf-8');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('read：超大文件拒绝', async () => {
  const r = await new ReadTool().execute({ filePath: BIG });
  expect(r.success).toBe(false);
  expect(String(r.error)).toMatch(/文件过大/);
});

test('read：小文件正常', async () => {
  const r = await new ReadTool().execute({ filePath: SMALL });
  expect(r.success).toBe(true);
});

test('readLines：超大文件拒绝', async () => {
  const r = await new ReadLinesTool().execute({ filePath: BIG });
  expect(r.success).toBe(false);
  expect(String(r.error)).toMatch(/文件过大/);
});

test('edit：超大文件拒绝', async () => {
  const r = await new EditTool().execute({ filePath: BIG, oldString: 'x', newString: 'y' });
  expect(r.success).toBe(false);
  expect(String(r.error)).toMatch(/文件过大/);
});
