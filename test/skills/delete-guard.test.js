'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDeletableSkillDir } from '../../src/skills/delete-guard.js';

/** 造一个临时技能根，返回 { root, skill(name) } */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-skill-root-'));
  return {
    root,
    /** 在根下造一个技能目录，可指定是否写 SKILL.md */
    skill(name, withSkillFile = true) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      if (withSkillFile) fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\n---\nbody');
      return path.join(dir, 'SKILL.md');
    },
  };
}

test('checkDeletableSkillDir: 扫描根的直接子目录 + 含 SKILL.md → 通过', () => {
  const r = makeRoot();
  const skillPath = r.skill('demo');
  const res = checkDeletableSkillDir(skillPath, [r.root]);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.dir, path.dirname(skillPath));
});

test('checkDeletableSkillDir: 技能根目录本身不能删', () => {
  const r = makeRoot();
  const fake = path.join(r.root, 'SKILL.md');
  fs.writeFileSync(fake, '---\nname: root-level\n---\n');
  const res = checkDeletableSkillDir(fake, [r.root]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /不在允许的扫描根内/);
});

test('checkDeletableSkillDir: 越权路径（不在任何根内）拒绝', () => {
  const r = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-outside-'));
  const skillPath = path.join(outside, 'evil', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '---\nname: evil\n---\n');
  const res = checkDeletableSkillDir(skillPath, [r.root]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /不在允许的扫描根内/);
});

test('checkDeletableSkillDir: 深一层（根/a/b）拒绝', () => {
  const r = makeRoot();
  const nested = path.join(r.root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const skillPath = path.join(nested, 'SKILL.md');
  fs.writeFileSync(skillPath, '---\nname: b\n---\n');
  const res = checkDeletableSkillDir(skillPath, [r.root]);
  assert.strictEqual(res.ok, false);
});

test('checkDeletableSkillDir: 目录里没有 SKILL.md 拒绝', () => {
  const r = makeRoot();
  const emptyDir = path.join(r.root, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const res = checkDeletableSkillDir(path.join(emptyDir, 'SKILL.md'), [r.root]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /SKILL.md 不存在/);
});

test('checkDeletableSkillDir: 只接受 SKILL.md 作为入口', () => {
  const r = makeRoot();
  const p = path.join(r.root, 'demo', 'other.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  const res = checkDeletableSkillDir(p, [r.root]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /只接受 SKILL.md/);
});

test('checkDeletableSkillDir: 相对路径拒绝', () => {
  const res = checkDeletableSkillDir('skills/demo/SKILL.md', [process.cwd()]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /绝对路径/);
});

test('checkDeletableSkillDir: 空路径/缺参拒绝', () => {
  assert.strictEqual(checkDeletableSkillDir('', ['/x']).ok, false);
  assert.strictEqual(checkDeletableSkillDir(null, ['/x']).ok, false);
});

test('checkDeletableSkillDir: 根为空时不放行', () => {
  const r = makeRoot();
  const skillPath = r.skill('demo');
  const res = checkDeletableSkillDir(skillPath, []);
  assert.strictEqual(res.ok, false);
});
