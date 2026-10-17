'use strict';
/**
 * D-003 回归：MCP http server 建连前走 SSRF 守卫。
 *
 * mock 外部边界（electron、MCP SDK、config），驱动真实 client 的 doConnectServer 路径。
 * 内网/回环/云元数据用 IP 字面量（无需 DNS，离线可测）；公网放行用公网 IP 字面量。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') {
        return { app: { isPackaged: false, getPath: () => 'C:/ud', getAppPath: () => 'C:/app' } };
      }
      throw new Error('unexpected require: ' + id);
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class { async connect() {} async listTools() { return { tools: [] }; } async close() {} },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class { constructor() {} },
}));

const mockState = { server: null, calls: [] };
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url, opts) { mockState.calls.push({ url, opts }); }
  },
}));
vi.mock('../../src/mcp/config.js', () => ({
  getServers: () => (mockState.server ? [mockState.server] : []),
  getEnabledServers: () => (mockState.server ? [mockState.server] : []),
}));

let client;

beforeEach(async () => {
  vi.resetModules();
  mockState.server = null;
  mockState.calls = [];
  client = await import('../../src/mcp/client.js');
});

function httpServer(url) {
  return {
    name: 'h', source: 'user', type: 'http', url, headers: {}, enabled: true, projectDir: null,
  };
}

test('回环地址被拒绝，且不构造 transport', async () => {
  mockState.server = httpServer('http://127.0.0.1:3000/mcp');
  await assert.rejects(
    () => client.connectServerByName('h', null, null),
    /SSRF|内网|127\.0\.0\.1/
  );
  assert.strictEqual(mockState.calls.length, 0, '内网地址不应构造 StreamableHTTP transport');
});

test('云元数据地址被拒绝', async () => {
  mockState.server = httpServer('http://169.254.169.254/latest/meta-data/');
  await assert.rejects(
    () => client.connectServerByName('h', null, null),
    /SSRF|169\.254/
  );
  assert.strictEqual(mockState.calls.length, 0);
});

test('私网地址被拒绝', async () => {
  mockState.server = httpServer('http://192.168.1.10/admin');
  await assert.rejects(
    () => client.connectServerByName('h', null, null),
    /SSRF|192\.168/
  );
  assert.strictEqual(mockState.calls.length, 0);
});

test('公网 IP 字面量放行（正常构造 transport 并连接）', async () => {
  mockState.server = httpServer('http://8.8.8.8/mcp');
  const entry = await client.connectServerByName('h', null, null);
  assert.ok(entry, '公网地址应连接成功');
  assert.strictEqual(mockState.calls.length, 1);
  assert.strictEqual(mockState.calls[0].url, 'http://8.8.8.8/mcp');
  await client.disconnectAll();
});
