'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { clipMiddleText, fitExtraPrompt, OUTPUT_TRUNC_MARKER } from '../../src/infra/text-clip.js';

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

test('fitExtraPrompt: 短附加内容原样拼接', () => {
  const out = fitExtraPrompt('BASE', 'EXTRA', 100);
  assert.strictEqual(out, 'BASE\n\n---\n\nEXTRA');
});

test('fitExtraPrompt: 超长只裁附加段，基础提示词与头尾保留', () => {
  const base = 'B'.repeat(36000);
  const extra = 'HEAD' + 'x'.repeat(5000) + 'TAIL';
  const out = fitExtraPrompt(base, extra, 39000);
  assert.ok(out.length <= 39000);
  assert.ok(out.startsWith(base));
  assert.ok(out.includes('HEAD'));
  assert.ok(out.endsWith('TAIL'));
});
