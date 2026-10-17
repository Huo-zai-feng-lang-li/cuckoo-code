'use strict';
/**
 * D-001 回归：npm 包名白名单。
 *
 * 只允许 registry 包名（name / @scope/name，可带 @version）；
 * 拒绝 URL、git、file:、tarball、命令行参数注入、路径穿越、空白。
 * installCuckooPlugin 必须在触达 npm 之前拒绝非法包名（不产生副作用）。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { isValidNpmPackageSpec, installCuckooPlugin } from '../../src/plugins/cuckoo-plugins/installer.js';

test('合法包名通过', () => {
  for (const ok of [
    'dsh-greet-tool',
    'greettool',
    '@scope/greet-tool',
    '@deepseek-ai/dsh-tools',
    'dsh-greet-tool@1.2.3',
    '@scope/greet-tool@latest',
    'a',
    'x_y.z',
  ]) {
    assert.ok(isValidNpmPackageSpec(ok), '应通过: ' + ok);
  }
});

test('非法包名拒绝（URL/git/file/tarball/参数/路径/空白）', () => {
  for (const bad of [
    '',
    '  ',
    'https://github.com/user/repo.git',
    'git+https://github.com/user/repo.git',
    'ssh://git@github.com/user/repo.git',
    'file:///tmp/malicious',
    '/tmp/malicious',
    '../evil',
    '..\\evil',
    'C:\\evil\\pkg',
    'name.tgz',
    'name.tar.gz',
    '--registry=https://evil.com',
    'name --ignore-scripts=false',
    'name with space',
    '@scope/../../etc/passwd',
    '$npm_config_registry',
  ]) {
    assert.ok(!isValidNpmPackageSpec(bad), '应拒绝: ' + JSON.stringify(bad));
  }
});

test('installCuckooPlugin 在触达 npm 前拒绝非法包名（无副作用）', async () => {
  await assert.rejects(
    () => installCuckooPlugin('https://github.com/user/repo.git'),
    /非法 npm 包名|URL|git/
  );
  await assert.rejects(
    () => installCuckooPlugin('--registry=https://evil.com'),
    /非法 npm 包名/
  );
});
