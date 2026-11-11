import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAutomaticSwitch } from '../../src/app/auto-switch.js';

test('告警取消不切换、锁释放；失败也释放，成功指定关闭源窗口', async () => {
  const locks = new Set();
  let closed = false;
  const deps = {
    locks,
    showAlert: async () => 'cancel',
    switchGroup: async (_group, _profile, closeSource, reason) => { closed = closeSource; assert.equal(reason, input.reason); return { success: true }; },
  };
  const input = { groupId: 'g', profileId: 'p', currentName: 'test', reason: 'context-limit' };
  assert.equal((await runAutomaticSwitch(input, deps)).reason, 'cancelled');
  assert.equal(closed, false);
  assert.equal(locks.size, 0);
  deps.showAlert = async () => { throw new Error('alert failed'); };
  assert.equal((await runAutomaticSwitch(input, deps)).success, false);
  assert.equal(locks.size, 0);
  deps.showAlert = async (data) => { assert.equal(data.reason, 'context-limit'); return 'switch-now'; };
  assert.equal((await runAutomaticSwitch(input, deps)).switched, true);
  assert.equal(closed, true);
  assert.equal(locks.size, 0);
});

test('倒计时期间限流和上下文通知共享同一profile锁，superseded释放', async () => {
  const locks = new Set();
  let release;
  const decision = new Promise(resolve => { release = resolve; });
  let switches = 0;
  const deps = { locks, showAlert: () => decision, switchGroup: async () => { switches++; return { success: true }; } };
  const input = { groupId: 'g', profileId: 'p', currentName: 'test', reason: 'context-limit' };
  const first = runAutomaticSwitch(input, deps);
  assert.equal((await runAutomaticSwitch({ ...input, reason: 'rate-limit' }, deps)).reason, 'in-progress');
  release('superseded');
  assert.equal((await first).reason, 'superseded');
  assert.equal(locks.size, 0);
  assert.equal(switches, 0);
});
