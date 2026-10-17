'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { matchProviderEndpoint } from '../../../../src/providers/hooks/shared/url-match.js';

const DS = 'https://chat.deepseek.com/';
const HOST = ['deepseek.com'];

test('B-003: DeepSeek 同域相对 URL + 正确 pathname → 命中', () => {
  assert.strictEqual(
    matchProviderEndpoint('/api/v0/chat/completion', 'POST', DS, '/api/v0/chat/completion', HOST),
    true
  );
});

test('B-003: 第三方域名同 pathname → 拒绝（host 白名单生效）', () => {
  assert.strictEqual(
    matchProviderEndpoint('https://evil.com/api/v0/chat/completion', 'POST', DS, '/api/v0/chat/completion', HOST),
    false
  );
});

test('B-003: 同域但 GET → 不命中', () => {
  assert.strictEqual(
    matchProviderEndpoint('/api/v0/chat/completion', 'GET', DS, '/api/v0/chat/completion', HOST),
    false
  );
});

test('B-003: 同域 POST 但 pathname 不符 → 不命中', () => {
  assert.strictEqual(
    matchProviderEndpoint('/api/v0/chat/other', 'POST', DS, '/api/v0/chat/completion', HOST),
    false
  );
});

test('B-003: stop_stream 同 host 校验', () => {
  assert.strictEqual(
    matchProviderEndpoint('/api/v0/chat/stop_stream', 'POST', DS, '/api/v0/chat/stop_stream', HOST),
    true
  );
  assert.strictEqual(
    matchProviderEndpoint('https://evil.com/api/v0/chat/stop_stream', 'POST', DS, '/api/v0/chat/stop_stream', HOST),
    false
  );
});

test('B-003: 空 url 安全返回 false', () => {
  assert.strictEqual(matchProviderEndpoint('', 'POST', DS, '/x', HOST), false);
  assert.strictEqual(matchProviderEndpoint(null, 'POST', DS, '/x', HOST), false);
});
