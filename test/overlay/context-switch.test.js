import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createContextSwitchGate } from '../../src/overlay/context-switch.js';

test('阈值达到才触发，重复idle和同会话同token不重复，换会话允许触发', async () => {
  const attempts = [];
  const gate = createContextSwitchGate(async () => { attempts.push('switch'); return { success: true, switched: true }; });
  const config = { enabled: true, threshold: 10 };
  assert.equal(gate.check(config, 99999, 'A'), false);
  assert.equal(gate.check(config, NaN, 'A'), false);
  assert.equal(gate.check(config, Infinity, 'A'), false);
  assert.equal(gate.check(config, 100000, 'A'), true);
  assert.equal(gate.check(config, 100000, 'A'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(attempts.length, 1);
  assert.equal(gate.check(config, 100000, 'A'), false);
  assert.equal(gate.check(config, 100000, 'B'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(attempts.length, 2);
});

test('关闭或非法阈值不触发，失败后相同会话与阈值可重试', async () => {
  let count = 0;
  const gate = createContextSwitchGate(async () => { count++; return { success: false }; });
  assert.equal(gate.check({ enabled: false, threshold: 10 }, 200000, 'A'), false);
  assert.equal(gate.check({ enabled: true, threshold: 0 }, 200000, 'A'), false);
  const config = { enabled: true, threshold: 10 };
  assert.equal(gate.check(config, 100000, 'A'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(gate.check(config, 100000, 'A'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(gate.check(config, 110000, 'A'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(count, 3);
});

test('请求异常后只清除对应会话的尝试锁，同会话可重新触发', async () => {
  let count = 0;
  const gate = createContextSwitchGate(async () => {
    count++;
    if (count === 1) throw new Error('bridge rejected');
    return { success: true, switched: true };
  });
  const config = { enabled: true, threshold: 10 };
  assert.equal(gate.check(config, 100000, 'A'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(gate.check(config, 100000, 'A'), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(count, 2);
  assert.equal(gate.check(config, 100000, 'A'), false);
  assert.equal(gate.check(config, 100000, 'B'), true);
});
