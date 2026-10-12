'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('文件冲突：三选一弹框（采用外部版/查看差异/保留我的）+ 决策条', () => {
  const prev = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell', 'scripts', 'preview.ts'), 'utf8');
  assert.ok(prev.includes('ckDialog3'), '冲突应用三选一弹框');
  assert.ok(prev.includes("primary: '采用外部版'"), '应有"采用外部版"');
  assert.ok(prev.includes("alt: '查看差异'"), '应有"查看差异"');
  assert.ok(prev.includes("cancel: '保留我的'"), '应有"保留我的"');
  assert.ok(prev.includes('showConflictDiff'), '应能查看冲突差异');
  assert.ok(prev.includes('ck-conflict-bar'), 'diff 视图应显示决策条');
  const shared = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell', 'scripts', 'shared.ts'), 'utf8');
  assert.ok(shared.includes('export function ckDialog3'), 'shared 应导出三选一弹框');
});
