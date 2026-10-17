'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { decideClaudeStreamExit } from '../../../../src/providers/hooks/shared/claude-status.js';

test('B-002: 收到 message_stop → finished', () => {
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: true, text: 'hello', httpStatus: 200 }),
    'finished'
  );
});

test('B-002: fetch 网络断流（networkError、非 abort、有截断正文）→ error（不再当 finished）', () => {
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: false, text: 'half text', networkError: true, aborted: false, httpStatus: null }),
    'error'
  );
});

test('B-002: fetch 断流但用户主动中止（AbortError）→ finished（不触发重试）', () => {
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: false, text: 'partial', networkError: true, aborted: true, httpStatus: null }),
    'finished'
  );
});

test('B-002: XHR 非 2xx → error', () => {
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: false, text: 'err body', httpStatus: 500 }),
    'error'
  );
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: false, text: '', httpStatus: 429 }),
    'error'
  );
});

test('B-002: 2xx 自然结束无 message_stop 但有正文 → finished（宽容，对齐 DeepSeek/ChatGPT）', () => {
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: false, text: '完整回复', httpStatus: 200 }),
    'finished'
  );
});

test('B-002: 2xx 但无正文无 message_stop → error', () => {
  assert.strictEqual(
    decideClaudeStreamExit({ sawMessageStop: false, text: '   ', httpStatus: 200 }),
    'error'
  );
});
