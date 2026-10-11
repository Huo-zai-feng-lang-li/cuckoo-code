'use strict';
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = path.join(os.tmpdir(), 'cuckoo-rules-ipc-test');
let mod;
beforeEach(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  process.env.CUCKOO_HOME = HOME;
  mod = await import('../../src/rules/files.js?test=' + Date.now());
});
afterEach(() => { delete process.env.CUCKOO_HOME; fs.rmSync(HOME, { recursive: true, force: true }); });

test('用户规则文件 CRUD 使用内容哈希并拒绝越界', () => {
  const created = mod.createUserRule('a.md', '# A');
  assert.equal(created.hash.length, 64);
  assert.equal(mod.listUserRules().length, 1);
  assert.throws(() => mod.createUserRule('../escape.md', 'x'), /非法/);
  const saved = mod.saveUserRule('a.md', '# B', created.hash);
  assert.equal(saved.content, '# B');
  assert.throws(() => mod.saveUserRule('a.md', '# C', created.hash), /外部修改/);
  assert.throws(() => mod.deleteUserRule('a.md', created.hash), /外部修改/);
  mod.deleteUserRule('a.md', saved.hash);
  assert.equal(mod.listUserRules().length, 0);
});

test('用户规则拒绝软链接', () => {
  fs.mkdirSync(path.join(HOME, 'rules'), { recursive: true });
  const outside = path.join(HOME, 'outside.md'); fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(HOME, 'rules', 'link.md'));
  assert.equal(mod.listUserRules().length, 0);
});

test('用户规则支持中文文件名并拒绝保留字', () => {
  const created = mod.createUserRule('深度思考规范.md', '# 规范');
  assert.equal(created.name, '深度思考规范');
  assert.equal(mod.listUserRules().length, 1);
  assert.throws(() => mod.createUserRule('con.md', 'x'), /非法/);
  assert.throws(() => mod.createUserRule('aux.md', 'x'), /非法/);
});

