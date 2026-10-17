'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { buildNotificationSummary } from '../../../src/bridge/intercept/notification-summary.js';

test('B-007: 折叠连续空白（含换行/tab）为单空格', () => {
  assert.strictEqual(buildNotificationSummary('a\n\n\tb   c'), 'a b c');
});

test('B-007: 不再吞掉字面字母 s', () => {
  const raw = 'Successfully saved the project settings now';
  // 历史 buggy 正则 /s+/g 会得到 "Succe fully aved the project etting now"
  assert.strictEqual(buildNotificationSummary(raw), raw);
});

test('B-007: 截断到 maxLen', () => {
  const long = 'x'.repeat(300);
  assert.strictEqual(buildNotificationSummary(long).length, 120);
  assert.strictEqual(buildNotificationSummary(long, 50).length, 50);
});

test('B-007: 空/空值安全', () => {
  assert.strictEqual(buildNotificationSummary(''), '');
  assert.strictEqual(buildNotificationSummary(null), '');
  assert.strictEqual(buildNotificationSummary(undefined), '');
});
