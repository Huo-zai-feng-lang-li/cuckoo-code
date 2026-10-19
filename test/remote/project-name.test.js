'use strict';
/**
 * projectNameOf 是零依赖纯函数（src/remote/path-util.ts），直接 import 测。
 *
 * 它原先埋在 manager.ts 里（依赖 electron，测试环境 import 不了），
 * 只能靠"源码正则 + new Function"这种脆弱方式测——函数体内一旦出现多行块
 * 就会提前截断。现已抽到独立模块。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { projectNameOf } from '../../src/remote/path-util.js';

test('projectNameOf 取路径末段', () => {
  assert.strictEqual(projectNameOf('D:\\work\\cuckoo-code'), 'cuckoo-code');
  assert.strictEqual(projectNameOf('/home/user/proj'), 'proj');
});

test('projectNameOf 忽略尾斜杠', () => {
  assert.strictEqual(projectNameOf('D:\\work\\cuckoo-code\\'), 'cuckoo-code');
  assert.strictEqual(projectNameOf('/home/user/proj/'), 'proj');
  assert.strictEqual(projectNameOf('D:\\work\\cuckoo-code///'), 'cuckoo-code');
});

test('projectNameOf 无目录 / 空串 → 空串', () => {
  assert.strictEqual(projectNameOf(''), '');
  assert.strictEqual(projectNameOf(undefined), '');
  assert.strictEqual(projectNameOf('///'), '');
});

test('projectNameOf 盘符根返回空串（对用户无意义）', () => {
  assert.strictEqual(projectNameOf('D:\\'), '', 'Windows 盘符根不应显示为 D:');
  assert.strictEqual(projectNameOf('C:'), '');
});

test('projectNameOf 普通单段名保持原样', () => {
  assert.strictEqual(projectNameOf('cuckoo-code'), 'cuckoo-code');
});

test('projectNameOf 混合分隔符', () => {
  assert.strictEqual(projectNameOf('D:\\work/proj/sub'), 'sub');
});
