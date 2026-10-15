'use strict';
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { readConfig, writeConfig, resetToken, genToken, getConfigFile } from '../../src/remote/config.js';

const TMP = path.join(os.tmpdir(), 'cuckoo-remote-config-test');
let oldHome;

beforeEach(() => {
  oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = TMP;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = oldHome;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('genToken 生成 32 位 hex 字符串', () => {
  const t = genToken();
  assert.strictEqual(typeof t, 'string');
  assert.strictEqual(t.length, 32);
  assert.match(t, /^[0-9a-f]{32}$/);
});

test('readConfig 首次调用自动生成配置并落盘，保证多次调用幂等', () => {
  const cfg1 = readConfig();
  assert.strictEqual(cfg1.enabled, false);
  assert.strictEqual(cfg1.port, 7799);
  assert.strictEqual(cfg1.publicUrl, '');
  assert.strictEqual(typeof cfg1.token, 'string');
  assert.strictEqual(cfg1.token.length, 32);

  // 必须已落盘
  const file = getConfigFile();
  assert.ok(fs.existsSync(file), '首次调用 readConfig 应已落盘');

  // 二次调用 readConfig 读取的是相同配置与相同 Token（幂等性）
  const cfg2 = readConfig();
  assert.strictEqual(cfg2.token, cfg1.token);
  assert.strictEqual(cfg2.port, cfg1.port);
  assert.strictEqual(cfg2.publicUrl, '');
});

test('writeConfig 部分更新，不传 token 时不改变原有 token', () => {
  const init = readConfig();
  const originalToken = init.token;

  const ok = writeConfig({ enabled: true, port: 8899 });
  assert.strictEqual(ok, true);

  const updated = readConfig();
  assert.strictEqual(updated.enabled, true);
  assert.strictEqual(updated.port, 8899);
  assert.strictEqual(updated.token, originalToken, '未传 token 时必须保留原 token');
});

test('writeConfig 校验非法端口并回退', () => {
  writeConfig({ port: 99999 }); // 超出 65535
  assert.strictEqual(readConfig().port, 7799);

  writeConfig({ port: -1 }); // 负数
  assert.strictEqual(readConfig().port, 7799);

  writeConfig({ port: 'invalid' }); // 非法类型
  assert.strictEqual(readConfig().port, 7799);
});

test('resetToken 重新生成 32 位 hex 令牌并持久化', () => {
  const init = readConfig();
  const token1 = init.token;

  const token2 = resetToken();
  assert.notStrictEqual(token2, token1);
  assert.strictEqual(token2.length, 32);

  const reRead = readConfig();
  assert.strictEqual(reRead.token, token2);
});

test('writeConfig 支持 publicUrl、tunnelEnabled 与 tunnelToken 且规范化处理', () => {
  const ok = writeConfig({
    publicUrl: 'remote.example.com/',
    tunnelEnabled: true,
    tunnelToken: 'mock_tunnel_token_secret',
  });
  assert.strictEqual(ok, true);

  const cfg = readConfig();
  // 必须自动补全 https:// 并去掉末尾斜杠
  assert.strictEqual(cfg.publicUrl, 'https://remote.example.com');
  assert.strictEqual(cfg.tunnelEnabled, true);
  assert.strictEqual(cfg.tunnelToken, 'mock_tunnel_token_secret');
});
