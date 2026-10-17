'use strict';
/**
 * D-005/D-006 回归：
 *  - WS token 走 Sec-WebSocket-Protocol（cuckoo.<token>），不进 URL query。
 *  - token 比较用常量时间（正确通过、错误拒绝，与旧行为一致）。
 *  - 过渡兼容：旧 query token 仍可连；Authorization 头对 /api/ping 可用。
 */
import { describe, test, afterEach } from 'vitest';
import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startServer, stopServer } from '../../src/remote/server.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

let portCounter = 18100;
const TEST_TOKEN = 'testtoken1234567890abcdef123456';

function httpGet(port, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathStr, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 连 WS，返回 Promise<open> 或 reject；protocolOrProtocols 传入 ws 子协议 */
function openWs(port, pathStr, protocols) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}${pathStr}`;
    const sock = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    const done = (fn, arg) => { try { fn(arg); } catch {} };
    sock.on('open', () => done(resolve, sock));
    sock.on('error', (e) => done(reject, e));
    sock.on('close', () => done(reject, new Error('ws closed before open')));
  });
}

describe('remote WS auth (D-005/D-006)', () => {
  afterEach(async () => { await stopServer(); });

  test('Sec-WebSocket-Protocol 携带正确 token → 握手成功', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {}, onListProfiles: () => [], onGetCurrentProfile: () => 'p1' }, port, TEST_TOKEN);
    const sock = await openWs(port, '/ws', ['cuckoo.' + TEST_TOKEN]);
    sock.close();
  });

  test('Sec-WebSocket-Protocol 携带错误 token → 被拒（不 open）', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    await assert.rejects(() => openWs(port, '/ws', ['cuckoo.wrongtoken']));
  });

  test('无 token（既无 subprotocol 也无 query）→ 被拒', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    await assert.rejects(() => openWs(port, '/ws'));
  });

  test('过渡兼容：旧 query token 仍可连接', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    const sock = await openWs(port, '/ws?token=' + TEST_TOKEN);
    sock.close();
  });

  test('Authorization 头对 /api/ping 可用（D-005 客户端预检改用头）', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    const res = await httpGet(port, '/api/ping', { Authorization: 'Bearer ' + TEST_TOKEN });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
  });

  test('错误 token（Authorization）→ 401（常量时间比较不影响正确性）', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    const res = await httpGet(port, '/api/ping', { Authorization: 'Bearer wrongtoken' });
    assert.strictEqual(res.statusCode, 401);
  });
});
