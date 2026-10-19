'use strict';
import { describe, test, afterEach } from 'vitest';
import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startServer, stopServer, broadcast, isRunning, getClientCount } from '../../src/remote/server.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

let portCounter = 17800;
const TEST_TOKEN = 'testtoken1234567890abcdef123456';

function httpGet(port, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathStr,
      method: 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('remote server', () => {
  afterEach(async () => {
    await stopServer();
  });

  test('startServer 正常启动，托管 PWA 静态资源', async () => {
    const port = ++portCounter;
    const r = await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(isRunning(), true);

    const res = await httpGet(port, '/');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('<!DOCTYPE html>') || res.body.includes('<html'));
  });

  test('静态资源带 ETag，If-None-Match 命中返回 304', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    const first = await httpGet(port, '/app.js');
    assert.strictEqual(first.statusCode, 200);
    assert.ok(first.headers.etag, '应返回 ETag');
    assert.ok(first.body.length > 0);

    const second = await httpGet(port, '/app.js', { 'if-none-match': first.headers.etag });
    assert.strictEqual(second.statusCode, 304, '命中 ETag 应返回 304');
    assert.strictEqual(second.body, '', '304 不应带 body');

    // 多值 If-None-Match（含前导错误值 + 空白）也要能命中
    const multi = await httpGet(port, '/app.js', { 'if-none-match': '"wrong", ' + first.headers.etag });
    assert.strictEqual(multi.statusCode, 304, '多值 If-None-Match 应能命中');

    // 不匹配的 ETag 应回 200 全量
    const miss = await httpGet(port, '/app.js', { 'if-none-match': '"definitely-wrong"' });
    assert.strictEqual(miss.statusCode, 200, 'ETag 不匹配应回 200');
    assert.ok(miss.body.length > 0);
  });

  test('缓存策略：index.html 为 no-cache，其它资源为强缓存', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    const index = await httpGet(port, '/');
    assert.strictEqual(index.headers['cache-control'], 'no-cache');

    const js = await httpGet(port, '/app.js');
    assert.ok(js.headers['cache-control'].includes('immutable'), '静态资源应为 immutable 强缓存');
    assert.ok(js.headers['cache-control'].includes('max-age='));
  });

  test('index.html 的静态资源引用带 ?v= 版本号（绕开 CDN 边缘缓存）', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    const res = await httpGet(port, '/');
    assert.strictEqual(res.statusCode, 200);
    // 背景：CF 边缘会长期缓存 immutable 资源，源站改 Cache-Control 也不管用；
    // 只有 URL 本身变化才能让 CDN 认作新资源。
    for (const name of ['app.js', 'style.css', 'marked.umd.js']) {
      const escaped = name.replace('.', '\\.');
      const re = new RegExp('(src|href)="/' + escaped + '\\?v=\\d+"');
      const hit = res.body.match(new RegExp('(src|href)="/' + escaped + '[^"]*"'));
      assert.ok(re.test(res.body), name + ' 应带 ?v=<数字>（实际：' + (hit ? hit[0] : '未找到') + '）');
    }
  });

  test('带 ?v= 的资源走 immutable 强缓存（URL 已版本化，可放心长缓存）', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    const res = await httpGet(port, '/app.js?v=123456');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['cache-control'].includes('immutable'), '带 ?v= 应为 immutable');
    assert.ok(res.headers['cache-control'].includes('max-age=31536000'));
    assert.ok(res.body.length > 0);

    // 不带 ?v= 时仍走原策略（app.js → immutable），行为不变
    const plain = await httpGet(port, '/app.js');
    assert.ok(plain.headers['cache-control'].includes('immutable'));
  });

  test('未知消息类型（如已移除的 attach）不影响连接，后续 send 仍正常', async () => {
    const port = ++portCounter;
    let receivedMsg = '';
    await startServer({ onUserMessage: (t) => { receivedMsg = t; } }, port, TEST_TOKEN);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TEST_TOKEN}`);
    const messages = [];
    client.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 60));

    // 已移除的 attach 消息：不得产生任何 outbound 消息、不得被当成用户文本、
    // 不得新增客户端（若 attach 分支被加回且调 onAttach，旧逻辑会回 attach-result → 此断言红）
    const beforeCount = messages.length;
    const clientsBefore = getClientCount();
    client.send(JSON.stringify({ type: 'attach', name: 'a.png', mime: 'image/png', data: 'AAAA' }));
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(messages.length, beforeCount, 'attach 不应产生任何 outbound 消息');
    assert.strictEqual(messages.some((m) => m.type === 'attach-result'), false, '不应再有 attach-result');
    assert.strictEqual(receivedMsg, '', 'attach 不应被当成用户消息转发');
    assert.strictEqual(getClientCount(), clientsBefore, 'attach 不应影响连接数');

    // 连接仍可用：后续 send 正常到达
    client.send(JSON.stringify({ type: 'send', text: 'after-attach' }));
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(receivedMsg, 'after-attach', '未知消息不应破坏连接');

    await new Promise((resolve) => { client.on('close', resolve); client.close(); });
  });

  test('HTTP 拦截跨目录路径穿越攻击 (403)', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    const res = await httpGet(port, '/..%2f..%2fpackage.json');
    assert.strictEqual(res.statusCode, 403);
  });

  test('HTTP API 鉴权：未带 token 或 token 错误返回 401', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    const resNoAuth = await httpGet(port, '/api/ping');
    assert.strictEqual(resNoAuth.statusCode, 401);

    const resBadAuth = await httpGet(port, '/api/ping', {
      authorization: 'Bearer wrongtoken',
    });
    assert.strictEqual(resBadAuth.statusCode, 401);

    const resGoodAuth = await httpGet(port, '/api/ping', {
      authorization: 'Bearer ' + TEST_TOKEN,
    });
    assert.strictEqual(resGoodAuth.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(resGoodAuth.body), { ok: true });
  });

  test('WebSocket 连接与鉴权：token 错误拒绝，正确则连通并收发', async () => {
    const port = ++portCounter;
    let receivedMsg = '';
    await startServer({
      onUserMessage: (t) => { receivedMsg = t; },
      onListProfiles: () => [{ id: 'p1', name: 'Profile 1' }],
      onGetCurrentProfile: () => 'p1',
    }, port, TEST_TOKEN);

    // 1. 错误 token 建立 ws 应当被断开
    await new Promise((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=badtoken`);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      badWs.on('error', () => { finish(); });
      badWs.on('close', () => { finish(); });
    });

    // 2. 正确 token 建立 ws 连接
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TEST_TOKEN}`);
    client.on('error', () => {});
    const messages = [];
    client.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch (_) {}
    });

    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    // 握手后应接收到 ready 消息
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(messages.some((m) => m.type === 'ready' && m.currentProfileId === 'p1'), '应收到 ready 握手消息');

    // 3. 手机端发送 send 消息
    client.send(JSON.stringify({ type: 'send', text: 'phone test msg' }));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(receivedMsg, 'phone test msg');

    // 4. 服务端调用 broadcast，客户端能收到
    broadcast({ type: 'ai-stream', text: 'stream chunk' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(messages.some((m) => m.type === 'ai-stream' && m.text === 'stream chunk'));

    await new Promise((resolve) => {
      client.on('close', resolve);
      client.close();
    });
  });

  test('index.html 的 ETag 纳入内嵌资源版本（只改 app.js 时也应变化）', async () => {
    const port = ++portCounter;
    await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);

    // 第一次请求：拿 index.html 的 ETag
    const first = await httpGet(port, '/');
    assert.strictEqual(first.statusCode, 200);
    const etag1 = first.headers.etag;
    assert.ok(etag1, 'index.html 应有 ETag');

    // 模拟"只更新 app.js，index.html 文件本身不变"：
    // 触碰 app.js 的 mtime（内容不变，但 mtime 变 → 版本号变）
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const pwaDir = pathMod.resolve(import.meta.dirname, '..', '..', 'src', 'remote', 'pwa');
    const appJs = pathMod.join(pwaDir, 'app.js');
    const st = fs.statSync(appJs);
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(appJs, st.atime, future);

    try {
      // 第二次请求：ETag 必须变（因为内嵌的 app.js 版本变了）
      const second = await httpGet(port, '/');
      assert.strictEqual(second.statusCode, 200, 'ETag 变化后应返回 200 而不是 304');
      assert.notStrictEqual(second.headers.etag, etag1, 'index.html 的 ETag 应随 app.js 版本变化');

      // 带旧 ETag 请求应返回 200（不是 304）
      const third = await httpGet(port, '/', { 'if-none-match': etag1 });
      assert.strictEqual(third.statusCode, 200, '旧 ETag 不应命中 304');

      // 带新 ETag 请求应返回 304
      const fourth = await httpGet(port, '/', { 'if-none-match': second.headers.etag });
      assert.strictEqual(fourth.statusCode, 304, '新 ETag 应命中 304');
    } finally {
      fs.utimesSync(appJs, st.atime, st.mtime);
    }
  });

  test('stopServer 能够完整关闭并释放端口，避免重启 EADDRINUSE', async () => {
    const port = ++portCounter;
    const r1 = await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    assert.strictEqual(r1.ok, true);

    await stopServer();
    assert.strictEqual(isRunning(), false);
    assert.strictEqual(getClientCount(), 0);

    // 立即再次启动同端口，必须能正常启动，证明端口已彻底释放
    const r2 = await startServer({ onUserMessage: () => {} }, port, TEST_TOKEN);
    assert.strictEqual(r2.ok, true);
    await stopServer();
  });
});
