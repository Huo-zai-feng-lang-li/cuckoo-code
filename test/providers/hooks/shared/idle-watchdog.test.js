'use strict';
import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert';
import { createIdleWatchdog } from '../../../../src/providers/hooks/shared/idle-watchdog.js';

afterEach(() => { vi.useRealTimers(); });

test('B-005: 静默超过阈值才触发 onIdle；持续 touch 不触发', () => {
  vi.useFakeTimers();
  let fires = 0;
  const wd = createIdleWatchdog({ timeoutMs: 30000, onIdle: () => fires++ });
  // 每 5s 轮询一次；30s 阈值
  vi.advanceTimersByTime(25000);
  assert.strictEqual(fires, 0, '未超阈值不应触发');
  // 期间持续收到数据（touch）→ 重置计时
  vi.advanceTimersByTime(5000);
  wd.touch();
  vi.advanceTimersByTime(25000);
  assert.strictEqual(fires, 0, 'touch 后应重置计时');
  // 不再 touch，超过阈值 → 触发
  vi.advanceTimersByTime(10000);
  assert.ok(fires >= 1, '静默超阈值应触发 onIdle');
  wd.stop();
});

test('B-005: timeoutMs<=0 不启动轮询', () => {
  vi.useFakeTimers();
  let fires = 0;
  const wd = createIdleWatchdog({ timeoutMs: 0, onIdle: () => fires++ });
  vi.advanceTimersByTime(100000);
  assert.strictEqual(fires, 0);
  wd.stop();
});

test('B-005: stop 后不再触发', () => {
  vi.useFakeTimers();
  let fires = 0;
  const wd = createIdleWatchdog({ timeoutMs: 1000, onIdle: () => fires++ });
  wd.stop();
  vi.advanceTimersByTime(100000);
  assert.strictEqual(fires, 0);
});
