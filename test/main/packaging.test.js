'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('发布包把 sharp 作为生产依赖并解包原生模块', () => {
  assert.ok(pkg.dependencies && pkg.dependencies.sharp, 'sharp 必须在 dependencies，electron-builder 才会带进安装包');
  assert.ok(!pkg.devDependencies || !pkg.devDependencies.sharp, 'sharp 不能只放在 devDependencies');

  const unpack = (pkg.build && pkg.build.asarUnpack) || [];
  assert.ok(
    unpack.some((p) => p.includes('node_modules/sharp')),
    'sharp 的 js/native 文件需要从 app.asar 解包',
  );
  assert.ok(
    unpack.some((p) => p.includes('node_modules/@img')),
    'sharp 的平台原生包 @img/* 需要从 app.asar 解包',
  );
});
