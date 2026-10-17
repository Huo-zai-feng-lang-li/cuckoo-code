'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { isBlockedIp, assertUrlAllowed, isBlockedIpv4, isBlockedIpv6 } from '../../src/infra/ssrf-guard.js';

test('isBlockedIpv4 拦截私网/回环/链路本地/保留', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
  ];
  for (const ip of blocked) {
    assert.strictEqual(isBlockedIpv4(ip), true, ip);
  }
});

test('isBlockedIpv4 放行公网地址', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
    assert.strictEqual(isBlockedIpv4(ip), false, ip);
  }
});

test('isBlockedIpv6 拦截回环/ULA/链路本地/组播', () => {
  const blocked = ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1'];
  for (const ip of blocked) {
    assert.strictEqual(isBlockedIpv6(ip), true, ip);
  }
});

test('isBlockedIpv6 放行公网地址', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.strictEqual(isBlockedIpv6(ip), false, ip);
  }
});

test('isBlockedIp 未知输入返回 false', () => {
  assert.strictEqual(isBlockedIp('not-an-ip'), false);
  assert.strictEqual(isBlockedIp(''), false);
});

// ===== assertUrlAllowed =====
test('assertUrlAllowed 拒绝 http 协议外的 scheme', async () => {
  await assert.rejects(assertUrlAllowed('file:///etc/passwd'), /仅支持 http\/https 协议/);
  await assert.rejects(assertUrlAllowed('ftp://example.com'), /仅支持 http\/https 协议/);
});

test('assertUrlAllowed 拒绝回环地址', async () => {
  await assert.rejects(assertUrlAllowed('http://127.0.0.1/'), /拒绝访问内网\/保留地址/);
  await assert.rejects(assertUrlAllowed('http://127.0.0.1:8080/'), /拒绝访问内网\/保留地址/);
  await assert.rejects(assertUrlAllowed('http://localhost/'), /拒绝访问内网\/保留地址/);
});

test('assertUrlAllowed 拒绝云元数据地址', async () => {
  await assert.rejects(assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), /拒绝访问内网\/保留地址/);
});

test('assertUrlAllowed 拒绝私网地址', async () => {
  await assert.rejects(assertUrlAllowed('http://10.0.0.1/'), /拒绝访问内网\/保留地址/);
  await assert.rejects(assertUrlAllowed('http://192.168.1.1/'), /拒绝访问内网\/保留地址/);
  await assert.rejects(assertUrlAllowed('http://172.16.0.1/'), /拒绝访问内网\/保留地址/);
});

test('assertUrlAllowed 拒绝 IPv6 回环', async () => {
  await assert.rejects(assertUrlAllowed('http://[::1]/'), /拒绝访问内网\/保留地址/);
});

test('assertUrlAllowed 拒绝十进制/十六进制编码的回环地址', async () => {
  // WHATWG URL 会把 0x7f.0.0.1 / 2130706433 归一回 127.0.0.1
  await assert.rejects(assertUrlAllowed('http://0x7f.0.0.1/'), /拒绝访问内网\/保留地址/);
  await assert.rejects(assertUrlAllowed('http://2130706433/'), /拒绝访问内网\/保留地址/);
});

// ===== A-002：IPv4-mapped IPv6 十六进制写法归一 =====
test('isBlockedIpv6 拦截十六进制 IPv4-mapped 回环/元数据地址', () => {
  // ::ffff:7f00:1 == ::ffff:127.0.0.1；::ffff:a9fe:a9fe == ::ffff:169.254.169.254
  assert.strictEqual(isBlockedIpv6('::ffff:7f00:1'), true);
  assert.strictEqual(isBlockedIpv6('::ffff:a9fe:a9fe'), true);
  assert.strictEqual(isBlockedIpv6('::ffff:0a00:0001'), true); // 10.0.0.1
  assert.strictEqual(isBlockedIpv6('::ffff:c0a8:0101'), true); // 192.168.1.1
});

test('isBlockedIpv6 点分 mapped 保持拦截（回归）', () => {
  assert.strictEqual(isBlockedIpv6('::ffff:127.0.0.1'), true);
  assert.strictEqual(isBlockedIpv6('::ffff:169.254.169.254'), true);
  assert.strictEqual(isBlockedIpv6('::ffff:10.0.0.1'), true);
});

test('isBlockedIpv6 公网 mapped 放行', () => {
  assert.strictEqual(isBlockedIpv6('::ffff:8.8.8.8'), false);
  assert.strictEqual(isBlockedIpv6('::ffff:0808:0808'), false); // 8.8.8.8 十六进制写法
});

test('assertUrlAllowed 拦截 [::ffff:7f00:1] 与 [::ffff:a9fe:a9fe]', async () => {
  await assert.rejects(assertUrlAllowed('http://[::ffff:7f00:1]/'), /拒绝访问内网\/保留地址/);
  await assert.rejects(assertUrlAllowed('http://[::ffff:a9fe:a9fe]/'), /拒绝访问内网\/保留地址/);
});

test('assertUrlAllowed 放行公网 mapped [::ffff:8.8.8.8]', async () => {
  await assert.doesNotReject(assertUrlAllowed('http://[::ffff:8.8.8.8]/'));
});
