'use strict';
import { test, beforeEach } from 'vitest';
import assert from 'node:assert';
import {
  MAX_CONCURRENT_AGENTS,
  acquireAgentSlot,
  tryAcquireAgentSlot,
  releaseAgentSlot,
  makeAgentReleaser,
  cancelQueuedByParent,
  getActiveCount,
  getQueueLength,
  _resetForTest,
} from '../../src/app/agent-semaphore.js';

beforeEach(() => {
  _resetForTest();
});

test('上限内的并发立即获得槽位', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) {
    await acquireAgentSlot();
  }
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
  assert.strictEqual(getQueueLength(), 0);
});

test('超出上限的请求排队，释放后按先来先得进入', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();

  let entered = false;
  const queued = acquireAgentSlot().then(() => { entered = true; });

  // 给微任务一个机会：此时应仍在排队
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(entered, false, '满额时第 4 个不应立即进入');
  assert.strictEqual(getQueueLength(), 1);
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);

  releaseAgentSlot();
  await queued;
  assert.strictEqual(entered, true, '释放 1 个后排队者应进入');
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS, '名额交接，计数不降');
  assert.strictEqual(getQueueLength(), 0);
});

test('多个排队者严格按先来先得顺序进入', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();

  const order = [];
  const p1 = acquireAgentSlot().then(() => order.push('A'));
  const p2 = acquireAgentSlot().then(() => order.push('B'));

  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(getQueueLength(), 2);

  releaseAgentSlot();
  await p1;
  releaseAgentSlot();
  await p2;

  assert.deepStrictEqual(order, ['A', 'B'], '先排队的应先进入');
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
});

test('排队超时抛错且不泄漏槽位', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();

  await assert.rejects(
    () => acquireAgentSlot({ timeoutMs: 50 }),
    /排队超时/
  );
  assert.strictEqual(getQueueLength(), 0, '超时后必须从队列摘除');
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS, '计数不受超时影响');

  // 释放一个后仍能正常分配（说明内部状态没被超时搞乱）
  releaseAgentSlot();
  await acquireAgentSlot();
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
});

test('空池释放不会把计数减成负数', async () => {
  releaseAgentSlot();
  releaseAgentSlot();
  assert.strictEqual(getActiveCount(), 0);
});

test('makeAgentReleaser 幂等：重复调用只释放一次', async () => {
  await acquireAgentSlot();
  await acquireAgentSlot();
  assert.strictEqual(getActiveCount(), 2);

  const release = makeAgentReleaser();
  release();
  assert.strictEqual(getActiveCount(), 1);
  release();
  release();
  assert.strictEqual(getActiveCount(), 1, '重复释放不应继续减少计数');
});

test('释放时把名额直接交接给队首，active 不变（无插队窗口）', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();

  const waiters = [acquireAgentSlot(), acquireAgentSlot(), acquireAgentSlot()];
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(getQueueLength(), 3);

  // 连续释放 3 次：每次都应交接给队首，active 始终等于上限
  for (let i = 0; i < 3; i++) {
    releaseAgentSlot();
    assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS, '交接期间计数应保持上限');
  }
  await Promise.all(waiters);
  assert.strictEqual(getQueueLength(), 0);
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
});

test('上限常量符合预期（3）', () => {
  assert.strictEqual(MAX_CONCURRENT_AGENTS, 3);
});

// ===== 统一池：网关用 tryAcquire，与子代理共享名额 =====

test('tryAcquireAgentSlot：有空位返回 true，满额立即返回 false 不排队', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) {
    assert.strictEqual(tryAcquireAgentSlot(), true, '第 ' + (i + 1) + ' 个应成功');
  }
  assert.strictEqual(tryAcquireAgentSlot(), false, '满额应立即失败');
  assert.strictEqual(getQueueLength(), 0, 'tryAcquire 不排队');
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
});

test('子代理占满后网关拿不到名额（两条路径共用同一个池）', async () => {
  // 3 个名额全被子代理（排队版）占走
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();
  assert.strictEqual(tryAcquireAgentSlot(), false, '网关不应有独立名额');

  // 释放一个后网关立刻能拿到
  releaseAgentSlot();
  assert.strictEqual(tryAcquireAgentSlot(), true, '释放的名额网关可用');
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
});

test('网关占满后子代理要排队（反向）', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) assert.strictEqual(tryAcquireAgentSlot(), true);

  let entered = false;
  const queued = acquireAgentSlot({ timeoutMs: 2000 }).then(() => { entered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(entered, false, '满额时子代理应排队');
  assert.strictEqual(getQueueLength(), 1);

  releaseAgentSlot();
  await queued;
  assert.strictEqual(entered, true);
});

// ===== 排队取消：用户点停止时，排队中的请求也要被取消 =====

test('cancelQueuedByParent：只取消指定父窗口的排队者，不误伤其他窗口', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();

  const pA = acquireAgentSlot({ parentWindowId: 1 });
  const pB = acquireAgentSlot({ parentWindowId: 2 });
  const pA2 = acquireAgentSlot({ parentWindowId: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(getQueueLength(), 3);

  const cancelled = cancelQueuedByParent(1);
  assert.strictEqual(cancelled, 2, '窗口 1 的两个排队者都应被取消');
  assert.strictEqual(getQueueLength(), 1, '窗口 2 的排队者应保留');

  await assert.rejects(() => pA, /已被用户取消/);
  await assert.rejects(() => pA2, /已被用户取消/);

  // 保留的那个仍能正常进入
  releaseAgentSlot();
  await pB;
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
});

test('cancelQueuedByParent：取消后槽位计数不受影响（没漏没多）', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();
  const p = acquireAgentSlot({ parentWindowId: 7 });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS);
  assert.strictEqual(getQueueLength(), 1);

  cancelQueuedByParent(7);
  await assert.rejects(() => p, /已被用户取消/);
  assert.strictEqual(getActiveCount(), MAX_CONCURRENT_AGENTS, '排队者未占名额，计数不变');
  assert.strictEqual(getQueueLength(), 0);
});

test('cancelQueuedByParent：不存在的父窗口返回 0', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();
  acquireAgentSlot({ parentWindowId: 1 });
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(cancelQueuedByParent(999), 0);
  assert.strictEqual(getQueueLength(), 1, '其他窗口的排队者不受影响');
});
