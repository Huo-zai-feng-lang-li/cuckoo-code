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
  injectSemaphoreConfig,
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
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot();
  assert.strictEqual(tryAcquireAgentSlot(), false, '网关不应有独立名额');

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

// ===== 按账号分池（profileId 隔离）=====

test('不同 profileId 独立计数：A 满额不影响 B', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot({ profileId: 'A' });
  assert.strictEqual(getActiveCount('A'), MAX_CONCURRENT_AGENTS);
  assert.strictEqual(getActiveCount('B'), 0, 'B 不该被 A 占的名额影响');

  // B 的第 1 个应立刻拿到
  assert.strictEqual(tryAcquireAgentSlot('B'), true);
  assert.strictEqual(getActiveCount('B'), 1);
  // A 的第 4 个仍排队/失败
  assert.strictEqual(tryAcquireAgentSlot('A'), false);
  assert.strictEqual(getActiveCount('A'), MAX_CONCURRENT_AGENTS);
});

test('profileId 分池：A 排队不阻塞 B 立即进入', async () => {
  for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) await acquireAgentSlot({ profileId: 'A' });
  let aEntered = false;
  const aQueued = acquireAgentSlot({ profileId: 'A', timeoutMs: 2000 }).then(() => { aEntered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(aEntered, false, 'A 满额应排队');
  assert.strictEqual(getQueueLength('A'), 1);

  // B 不受影响，立即进入
  await acquireAgentSlot({ profileId: 'B' });
  assert.strictEqual(getActiveCount('B'), 1);
  assert.strictEqual(getQueueLength('B'), 0);

  releaseAgentSlot('A');
  await aQueued;
  assert.strictEqual(aEntered, true);
  releaseAgentSlot('B');
  releaseAgentSlot('A'); releaseAgentSlot('A');
});

test('releaseAgentSlot 只影响指定账号', async () => {
  await acquireAgentSlot({ profileId: 'A' });
  await acquireAgentSlot({ profileId: 'B' });
  assert.strictEqual(getActiveCount('A'), 1);
  assert.strictEqual(getActiveCount('B'), 1);

  releaseAgentSlot('A');
  assert.strictEqual(getActiveCount('A'), 0);
  assert.strictEqual(getActiveCount('B'), 1, 'B 的计数不受影响');
});

test('不传 profileId 走默认池；无参统计=所有池总和（契约）', async () => {
  await acquireAgentSlot();
  await acquireAgentSlot({ profileId: 'X' });
  // 契约：getActiveCount() 无参 = 所有池总和（兼容旧测试的"全局视角"）
  assert.strictEqual(getActiveCount(), 2, '无参返回所有池总和');
  assert.strictEqual(getQueueLength(), 0);
  // 传 profileId 时只看该池
  assert.strictEqual(getActiveCount('X'), 1);
  // 默认池被释放后总和降为 1
  releaseAgentSlot();
  assert.strictEqual(getActiveCount(), 1);
  assert.strictEqual(getActiveCount('X'), 1, 'X 不受默认池释放影响');
});

// ===== 可配并发上限 =====

test('配置注入后上限生效（改为 1，第二个立刻排队）', async () => {
  injectSemaphoreConfig(() => ({ maxConcurrent: 1, startIntervalMinMs: 0, startIntervalMaxMs: 0 }));
  await acquireAgentSlot({ profileId: 'A' });
  assert.strictEqual(tryAcquireAgentSlot('A'), false, '上限 1 时第二个应立即失败');

  let entered = false;
  const q = acquireAgentSlot({ profileId: 'A', timeoutMs: 2000 }).then(() => { entered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(entered, false);

  releaseAgentSlot('A');
  await q;
  assert.strictEqual(entered, true);
});

test('并发上限越界被压到合法范围（0/99 → 1/10）', async () => {
  injectSemaphoreConfig(() => ({ maxConcurrent: 0, startIntervalMinMs: 0, startIntervalMaxMs: 0 }));
  await acquireAgentSlot({ profileId: 'Z' });
  // 0 被压到 1：第 2 个失败
  assert.strictEqual(tryAcquireAgentSlot('Z'), false);

  injectSemaphoreConfig(() => ({ maxConcurrent: 99, startIntervalMinMs: 0, startIntervalMaxMs: 0 }));
  for (let i = 1; i <= 10; i++) assert.strictEqual(tryAcquireAgentSlot('Y'), true, '最多 10 个');
  assert.strictEqual(tryAcquireAgentSlot('Y'), false, '第 11 个失败');
});

// ===== 启动间隔 =====

test('间隔为 0 时零等待（默认行为，不回归）', async () => {
  const t0 = Date.now();
  await acquireAgentSlot({ profileId: 'I0' });
  const dt = Date.now() - t0;
  assert.ok(dt < 100, '间隔 0 应立即返回，实测 ' + dt + 'ms');
});

test('间隔 > 0 时第二次 acquire 会被延迟', async () => {
  injectSemaphoreConfig(() => ({ maxConcurrent: 3, startIntervalMinMs: 200, startIntervalMaxMs: 200 }));
  await acquireAgentSlot({ profileId: 'I1' });
  const t0 = Date.now();
  await acquireAgentSlot({ profileId: 'I1' });
  const dt = Date.now() - t0;
  assert.ok(dt >= 150, '第二次应至少等待约 200ms，实测 ' + dt + 'ms');
});

test('间隔只作用于子代理（acquireAgentSlot），网关 tryAcquire 不等待', async () => {
  injectSemaphoreConfig(() => ({ maxConcurrent: 3, startIntervalMinMs: 500, startIntervalMaxMs: 500 }));
  await acquireAgentSlot({ profileId: 'I2' });
  const t0 = Date.now();
  const ok = tryAcquireAgentSlot('I2');
  const dt = Date.now() - t0;
  assert.strictEqual(ok, true);
  assert.ok(dt < 100, '网关 tryAcquire 应立即返回，实测 ' + dt + 'ms');
});
