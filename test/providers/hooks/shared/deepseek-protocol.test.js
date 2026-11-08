'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import {
  flattenDelta,
  decideDeepSeekStreamExit
} from '../../../../src/providers/hooks/shared/deepseek-protocol.js';

// ===== flattenDelta =====

test('flattenDelta 解析单个标准 patch', () => {
  const state = { op: 'SET', path: '' };
  const res = flattenDelta({ p: 'response/status', o: 'SET', v: 'FINISHED' }, '', state);
  assert.deepStrictEqual(res, [
    { p: 'response/status', o: 'SET', v: 'FINISHED', raw: { p: 'response/status', o: 'SET', v: 'FINISHED' } }
  ]);
  assert.strictEqual(state.path, 'response/status');
  assert.strictEqual(state.op, 'SET');
});

test('flattenDelta 解析 BATCH 操作并自动级联父级路径', () => {
  const state = { op: 'SET', path: '' };
  const batch = {
    o: 'BATCH',
    p: 'response',
    v: [
      { p: 'fragments/0/content', o: 'SET', v: '你好' },
      { p: 'accumulated_token_usage', o: 'SET', v: 10 }
    ]
  };
  const res = flattenDelta(batch, '', state);
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].p, 'response/fragments/0/content');
  assert.strictEqual(res[0].v, '你好');
  assert.strictEqual(res[1].p, 'response/accumulated_token_usage');
  assert.strictEqual(res[1].v, 10);
});

test('flattenDelta 状态继承：缺省 p 和 o 时延续上一帧路径与操作', () => {
  const state = { op: 'SET', path: 'response/fragments/0/content' };
  // 缺省 p 和 o 的后续数据块
  const res = flattenDelta({ v: '，世界！' }, '', state);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].p, 'response/fragments/0/content');
  assert.strictEqual(res[0].o, 'SET');
  assert.strictEqual(res[0].v, '，世界！');
});

test('flattenDelta 嵌套 BATCH 路径深层级联', () => {
  const state = { op: 'SET', path: '' };
  const nested = {
    o: 'BATCH',
    p: 'response',
    v: [
      {
        o: 'BATCH',
        p: 'fragments/0',
        v: [
          { p: 'content', o: 'SET', v: 'chunk' }
        ]
      }
    ]
  };
  const res = flattenDelta(nested, '', state);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].p, 'response/fragments/0/content');
  assert.strictEqual(res[0].v, 'chunk');
});

// ===== decideDeepSeekStreamExit =====

test('decideDeepSeekStreamExit 用户主动停止返回 stopped', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: true,
    incomplete: false,
    streamRateLimit: false,
    finished: false,
    textLen: 10
  });
  assert.strictEqual(status, 'stopped');
});

test('decideDeepSeekStreamExit 服务端截断返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: true,
    streamRateLimit: false,
    finished: false,
    textLen: 50
  });
  assert.strictEqual(status, 'error');
});

test('decideDeepSeekStreamExit 流内限流返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: true,
    finished: true,
    textLen: 20
  });
  assert.strictEqual(status, 'error');
});

test('decideDeepSeekStreamExit 收到完成事件且正文非空返回 finished', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: true,
    textLen: 100
  });
  assert.strictEqual(status, 'finished');
});

test('decideDeepSeekStreamExit 收到完成事件但正文为空（仅思考截断）返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: true,
    textLen: 0
  });
  assert.strictEqual(status, 'error');
});

test('decideDeepSeekStreamExit 未收到完成事件但流自然结束且有正文返回 finished（宽容策略）', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: false,
    textLen: 80
  });
  assert.strictEqual(status, 'finished');
});

test('decideDeepSeekStreamExit 无正文且无完成事件返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: false,
    textLen: 0
  });
  assert.strictEqual(status, 'error');
});
