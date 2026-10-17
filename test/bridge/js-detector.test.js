'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import {
  BT,
  FENCE,
  looksLikeIncompleteCodeError,
  looksLikeToolScript,
  hasOnlyFences,
  extractJsToolBlocks,
} from '../../src/bridge/parser/js-detector.js';

test('BT 和 FENCE 定义', () => {
  assert.strictEqual(BT, '`');
  assert.strictEqual(FENCE, '```');
});

test('looksLikeToolScript 识别 await 工具调用', () => {
  assert.strictEqual(looksLikeToolScript('await bash("echo hi")'), true);
  assert.strictEqual(looksLikeToolScript('const x = await read("a.txt")'), true);
  assert.strictEqual(looksLikeToolScript('await write("a", "b")'), true);
});

test('looksLikeToolScript 拒绝普通代码', () => {
  assert.strictEqual(looksLikeToolScript('fs.readFile("a.txt")'), false);
  assert.strictEqual(looksLikeToolScript('console.log(1)'), false);
  assert.strictEqual(looksLikeToolScript(''), false);
  assert.strictEqual(looksLikeToolScript(null), false);
});

test('looksLikeIncompleteCodeError 匹配语法错误', () => {
  assert.strictEqual(looksLikeIncompleteCodeError('SyntaxError: Unexpected end'), true);
  assert.strictEqual(looksLikeIncompleteCodeError('Unexpected token'), true);
  assert.strictEqual(looksLikeIncompleteCodeError('normal error'), false);
  assert.strictEqual(looksLikeIncompleteCodeError(null), false);
});

test('hasOnlyFences 仅代码块', () => {
  assert.strictEqual(hasOnlyFences('```js\ncode\n```'), true);
  assert.strictEqual(hasOnlyFences('```js\ncode\n```\n\n```js\nmore\n```'), true);
  assert.strictEqual(hasOnlyFences('text ```js\ncode\n```'), false);
  assert.strictEqual(hasOnlyFences('no fence'), false);
  assert.strictEqual(hasOnlyFences(null), false);
});

test('extractJsToolBlocks 提取 cuckoo 块', () => {
  const text = '```cuckoo\nawait read("a.txt")\n```';
  const blocks = extractJsToolBlocks(text);
  assert.deepStrictEqual(blocks, ['await read("a.txt")']);
});

test('extractJsToolBlocks js 块仅当只有代码块', () => {
  const js = '```js\nawait bash("echo")\n```';
  assert.deepStrictEqual(extractJsToolBlocks(js), ['await bash("echo")']);
  const mixed = '说明\n```js\nawait bash("echo")\n```';
  assert.deepStrictEqual(extractJsToolBlocks(mixed), []);
});

test('extractJsToolBlocks 忽略普通 js', () => {
  const js = '```js\nconsole.log(1)\n```';
  assert.deepStrictEqual(extractJsToolBlocks(js), []);
});

test('extractJsToolBlocks 空输入', () => {
  assert.deepStrictEqual(extractJsToolBlocks(''), []);
  assert.deepStrictEqual(extractJsToolBlocks(null), []);
});

// ===== B-004：流截断的未闭合围栏不得提取执行 =====

test('B-004: EOF 仍未闭合的 cuckoo 块（流式截断）被丢弃', () => {
  const F = '```';
  const text = F + 'cuckoo\nawait write({ filePath: "x.txt", content: "incomplete';
  assert.deepStrictEqual(extractJsToolBlocks(text), []);
});

test('B-004: 未闭合块后的已闭合块仍正常提取（未闭合的只是尾部）', () => {
  const F = '```';
  const text = F + 'cuckoo\nawait read({ filePath: "a" });\n' + F + '\n' +
    F + 'cuckoo\nawait write({ filePath: "b", content: "half';
  assert.deepStrictEqual(extractJsToolBlocks(text), ['await read({ filePath: "a" });']);
});

// ===== B-008：4+ 反引号围栏识别 =====

test('B-008: 4 反引号围栏正确识别为 cuckoo 块', () => {
  const F4 = '````';
  const text = F4 + 'cuckoo\nawait read({ filePath: "a.txt" });\n' + F4;
  assert.deepStrictEqual(extractJsToolBlocks(text), ['await read({ filePath: "a.txt" });']);
});

test('B-008: 4 反引号块内含三反引号示例不提前闭合', () => {
  const F4 = '````';
  const inner = 'const s = ' + '```' + ';'; // 块内一行三反引号，不应闭合外层
  const text = F4 + 'cuckoo\nawait read({ filePath: "a" });\n' + inner + '\n' + F4;
  const blocks = extractJsToolBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].includes(inner));
});

test('B-008: 3 反引号闭合块行为不变', () => {
  const F = '```';
  const text = F + 'cuckoo\nawait bash({ command: "echo ok" });\n' + F;
  assert.deepStrictEqual(extractJsToolBlocks(text), ['await bash({ command: "echo ok" });']);
});

