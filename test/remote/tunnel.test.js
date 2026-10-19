'use strict';
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { getTunnelStatus, stopTunnel } from '../../src/remote/tunnel.js';

beforeEach(async () => {
  await stopTunnel();
});

afterEach(async () => {
  await stopTunnel();
});

test('getTunnelStatus 初始状态为未运行', () => {
  const status = getTunnelStatus();
  assert.strictEqual(status.running, false);
  assert.strictEqual(status.mode, 'none');
  assert.strictEqual(status.url, '');
  assert.strictEqual(status.error, '');
});

test('stopTunnel 在未运行时调用保持幂等安全', async () => {
  await stopTunnel();
  const status = getTunnelStatus();
  assert.strictEqual(status.running, false);
});
