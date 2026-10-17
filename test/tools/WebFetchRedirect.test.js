'use strict';
// A-001 回归：web-fetch 在 SSRF 守卫开启时，302 重定向的每一跳都必须过 assertUrlAllowed。
// 这里用 vi.mock 把守卫替换为"放行首跳、拦截内网站端口"的桩：
// 真正的 IP/CIDR 判定由 test/infra/ssrf-guard.test.js 覆盖，本文件只验证"逐跳复检"这条链路。
import { test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

let mockInternalPort = 0;
vi.mock('../../src/infra/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertUrlAllowed: async (rawUrl) => {
      const u = new URL(rawUrl);
      // 内网站端口一律拒绝（模拟"重定向目标是内网"）
      if (u.port === String(mockInternalPort)) {
        throw new Error('拒绝访问内网/保留地址: ' + u.hostname);
      }
      // 其余跳（首跳跳板）放行——模拟"首跳是公网域名，守卫通过 DNS 校验"
    },
  };
});

const { WebFetchTool } = await import('../../src/tools/impl/web-fetch.js');

let jumper;    // 首跳：公网跳板，302 到内网
let internal;  // 内网服务，返回 secret
let jumperUrl;

beforeAll(async () => {
  internal = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('INTERNAL-SECRET: metadata-like content');
  });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  mockInternalPort = internal.address().port;
  // jumper 闭包在请求时才读 mockInternalPort，此时端口已确定
  jumper = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:' + mockInternalPort + '/internal' });
    res.end();
  });
  await new Promise((r) => jumper.listen(0, '127.0.0.1', r));
  jumperUrl = 'http://127.0.0.1:' + jumper.address().port + '/';
});

afterAll(async () => {
  await new Promise((r) => internal.close(r));
  await new Promise((r) => jumper.close(r));
});

test('守卫开启：302 跳进内网被逐跳校验拦截，不回传内网内容', async () => {
  const tool = new WebFetchTool();
  const result = await tool.execute({ url: jumperUrl, ssrfGuard: true });
  expect(result.success).toBe(false);
  expect(String(result.error)).toMatch(/拒绝访问内网/);
  expect(String(result.error)).not.toMatch(/INTERNAL-SECRET/);
});

test('守卫关闭：保持原行为（自动跟随重定向，拿到内网内容）', async () => {
  const tool = new WebFetchTool();
  const result = await tool.execute({ url: jumperUrl, ssrfGuard: false });
  expect(result.success).toBe(true);
  expect(String(result.data)).toMatch(/INTERNAL-SECRET/);
});
