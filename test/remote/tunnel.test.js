'use strict';
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { getTunnelStatus, stopTunnel, buildTunnelArgs } from '../../src/remote/tunnel.js';

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

test('buildTunnelArgs 固定隧道：run --token + http2', () => {
  const args = buildTunnelArgs({ port: 7799, tunnelToken: 'abc123' });
  assert.deepStrictEqual(args, ['tunnel', 'run', '--token', 'abc123', '--protocol', 'http2']);
});

test('buildTunnelArgs 临时隧道：只有 --url，不加 http2（老版本兼容）', () => {
  const args = buildTunnelArgs({ port: 7799 });
  assert.deepStrictEqual(args, ['tunnel', '--url', 'http://127.0.0.1:7799']);
});

test('buildTunnelArgs 空白 token 视为临时隧道且不加 http2', () => {
  const args = buildTunnelArgs({ port: 1, tunnelToken: '   ' });
  assert.strictEqual(args[0], 'tunnel');
  assert.strictEqual(args[1], '--url');
  assert.strictEqual(args.includes('--protocol'), false);
});
