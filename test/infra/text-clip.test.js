'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { clipMiddleText, OUTPUT_TRUNC_MARKER } from '../../src/infra/text-clip.js';

test('clipMiddleText: 未超限原样返回', () => {
  assert.strictEqual(clipMiddleText('hello', 100), 'hello');
  assert.strictEqual(clipMiddleText('', 100), '');
});

test('clipMiddleText: 超限保留头尾与标记', () => {
  const text = 'HEAD' + 'x'.repeat(30000) + 'TAIL';
  const out = clipMiddleText(text, 20000);
  assert.ok(out.length <= 20000);
  assert.ok(out.startsWith('HEAD'));
  assert.ok(out.endsWith('TAIL'));
  assert.ok(out.includes(OUTPUT_TRUNC_MARKER));
});

test('clipMiddleText: 上限小于标记长度时退化为纯头部截断', () => {
  const out = clipMiddleText('abcdef', 3);
  assert.strictEqual(out, 'abc');
});
