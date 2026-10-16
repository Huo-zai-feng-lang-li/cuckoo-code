'use strict';
/**
 * 底部「最近使用」全局存储测试（真实文件读写，不深 mock）。
 * 隔离：CUCKOO_HOME 指向临时目录。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'cuckoo-recent-test');
const FAKE_HOME = path.join(TMP, 'home');

let rt;
let oldHome;

beforeEach(async () => {
  vi.resetModules();
  oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = FAKE_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  rt = await import('../../src/app/recent-tools.ts');
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = oldHome;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('空文件 → 空列表', () => {
  assert.deepStrictEqual(rt.loadRecent(), []);
});

test('addRecent 置顶 + 同类型同名去重', () => {
  rt.addRecent('skill', 'A');
  rt.addRecent('skill', 'B');
  let list = rt.addRecent('skill', 'A'); // A 应置顶
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'A');
  assert.strictEqual(list[1].name, 'B');
});

test('最多保留 5 条', () => {
  for (let i = 0; i < 8; i++) rt.addRecent('skill', 'S' + i);
  const list = rt.loadRecent();
  assert.strictEqual(list.length, 5);
  assert.strictEqual(list[0].name, 'S7');
});

test('snippet 带 payload/autoSend 存取正确', () => {
  rt.addRecent('snippet', '生成文档', { payload: '生成项目文档', autoSend: true });
  const list = rt.loadRecent();
  assert.strictEqual(list[0].type, 'snippet');
  assert.strictEqual(list[0].payload, '生成项目文档');
  assert.strictEqual(list[0].autoSend, true);
});

test('removeRecent 删除指定项', () => {
  rt.addRecent('mcp', 'X');
  rt.addRecent('mcp', 'Y');
  const list = rt.removeRecent('mcp', 'X');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Y');
});

test('非法 type 的记录被过滤（读取容错）', () => {
  fs.writeFileSync(path.join(FAKE_HOME, 'recent-tools.json'), JSON.stringify([
    { type: 'bogus', name: 'bad', ts: 1 },
    { type: 'skill', name: 'good', ts: 2 },
  ]));
  const list = rt.loadRecent();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'good');
});

test('损坏 JSON → 空列表（不抛异常）', () => {
  fs.writeFileSync(path.join(FAKE_HOME, 'recent-tools.json'), '{ not json');
  assert.deepStrictEqual(rt.loadRecent(), []);
});

test('空 name 不记录', () => {
  const list = rt.addRecent('skill', '');
  assert.strictEqual(list.length, 0);
});
