'use strict';
/**
 * S-002 回归：自动更新不得"降级"。
 *
 * 若攻击者篡改 curated 目录把版本号写小，findOutdated 也不应返回更新项 ——
 * 只有 catalog 版本严格更新于已装版本时才出现在更新列表里。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { findOutdated, isNewer } from '../../src/plugins/auto-update.js';

test('isNewer：只在 a 严格更新于 b 时为真（拒绝降级）', () => {
  assert.strictEqual(isNewer('2.0.0', '1.0.0'), true);
  assert.strictEqual(isNewer('1.0.0', '2.0.0'), false, '降级不被视为可更新');
  assert.strictEqual(isNewer('1.0.0', '1.0.0'), false, '同版本不更新');
});

test('findOutdated：catalog 版本低于已装版本时不返回（防降级攻击）', () => {
  const catalog = [{ id: 'alice/demo', name: 'demo', version: '1.0.0', defaultBranch: 'main' }];
  const installed = { 'alice/demo': { id: 'alice/demo', name: 'demo', version: '2.0.0', installedAt: '' } };
  assert.deepStrictEqual(findOutdated(catalog, installed), [], '已装 2.0.0、目录 1.0.0 → 不更新');
});

test('findOutdated：catalog 版本更高时正常返回更新项', () => {
  const catalog = [{ id: 'alice/demo', name: 'demo', version: '2.0.0', defaultBranch: 'main' }];
  const installed = { 'alice/demo': { id: 'alice/demo', name: 'demo', version: '1.0.0', installedAt: '' } };
  const out = findOutdated(catalog, installed);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].newVersion, '2.0.0');
});
