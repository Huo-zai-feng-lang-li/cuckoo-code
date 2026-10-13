'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { decodeOutput, normalizeCommand, stripAnsi } from '../../src/infra/decode-output.js';

test('decodeOutput 空/无输入返回空串', () => {
  assert.strictEqual(decodeOutput(null), '');
  assert.strictEqual(decodeOutput(undefined), '');
  assert.strictEqual(decodeOutput(Buffer.alloc(0)), '');
});

test('decodeOutput UTF-8 正常解码', () => {
  const buf = Buffer.from('hello 中文', 'utf8');
  assert.strictEqual(decodeOutput(buf), 'hello 中文');
});

test('decodeOutput GBK 回退', () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  const out = decodeOutput(gbk);
  assert.ok(out.length > 0);
  assert.ok(!out.includes('\uFFFD') || out === '你好');
});

test('decodeOutput 非法 UTF-8 无法 GBK 时返回字符串', () => {
  const bad = Buffer.from([0xff, 0xfe, 0xfd]);
  const out = decodeOutput(bad);
  assert.strictEqual(typeof out, 'string');
});

test('normalizeCommand 非字符串原样返回', () => {
  assert.strictEqual(normalizeCommand(null), null);
  assert.strictEqual(normalizeCommand(undefined), undefined);
  assert.strictEqual(normalizeCommand(123), 123);
  assert.strictEqual(normalizeCommand(''), '');
});

test('normalizeCommand 非 powershell 不处理', () => {
  const cmd = 'Get-Content file.txt';
  assert.strictEqual(normalizeCommand(cmd), cmd);
  const bash = 'bash -c "Get-Content x"';
  assert.strictEqual(normalizeCommand(bash), bash);
});

test('normalizeCommand powershell 含 Get-Content 注入 UTF8', () => {
  const cmd = 'powershell -NoProfile -Command Get-Content file.txt';
  assert.strictEqual(normalizeCommand(cmd), 'powershell -NoProfile -Command Get-Content -Encoding UTF8 file.txt');
});

test('normalizeCommand pwsh 含 Get-Content 注入 UTF8', () => {
  const cmd = 'pwsh Get-Content file.txt';
  assert.strictEqual(normalizeCommand(cmd), 'pwsh Get-Content -Encoding UTF8 file.txt');
});

test('normalizeCommand 已有 -Encoding 不动', () => {
  const cmd = 'powershell Get-Content -Encoding UTF8 file.txt';
  assert.strictEqual(normalizeCommand(cmd), cmd);
});

test('normalizeCommand 无 Get-Content 不动', () => {
  const cmd = 'powershell Get-ChildItem';
  assert.strictEqual(normalizeCommand(cmd), cmd);
});

test('stripAnsi 剥离 CSI 颜色码', () => {
  const input = '\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m';
  assert.strictEqual(stripAnsi(input), ' RUN ');
});

test('stripAnsi 剥离 OSC（设置窗口标题）', () => {
  const input = 'before\x1b]0;title\x07after';
  assert.strictEqual(stripAnsi(input), 'beforeafter');
});

test('stripAnsi 剥离单字符转义', () => {
  assert.strictEqual(stripAnsi('a\x1bMb'), 'ab');
});

test('stripAnsi 无 ANSI 原样返回', () => {
  assert.strictEqual(stripAnsi('hello 中文'), 'hello 中文');
  assert.strictEqual(stripAnsi(''), '');
});

test('decodeOutput 剥离 ANSI 控制码（含真实 vitest 片段）', () => {
  const buf = Buffer.from('\x1b[90mstdout\x1b[39m | 中文', 'utf8');
  const out = decodeOutput(buf);
  assert.strictEqual(out, 'stdout | 中文');
  assert.ok(!out.includes('\x1b'), '不应残留 ESC');
  assert.ok(!out.includes('[90m'), '不应残留 CSI 明文');
});

test('decodeOutput GBK 分支也剥离 ANSI', () => {
  // GBK 的"你好" + ANSI 包装，触发 GBK 回退后仍应剥离
  const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  const withAnsi = Buffer.concat([Buffer.from('\x1b[31m', 'utf8'), gbkHello, Buffer.from('\x1b[0m', 'utf8')]);
  const out = decodeOutput(withAnsi);
  assert.ok(!out.includes('\x1b'), 'GBK 分支不应残留 ESC');
});

