'use strict';
/**
 * cuckoo-js 协议的纯函数测试：只认 ```cuckoo 代码块，不能把普通代码块
 * 或未闭合代码块误当成工具调用。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import {
  extractCuckooBlocks,
  stripCuckooBlocks,
  formatCuckooResult,
  codePreview,
} from '../../src/api-transport/cuckoo-js.js';

test('提取 cuckoo 代码块，忽略普通代码块', () => {
  const text = [
    '先说明一句。',
    '```cuckoo',
    'const out = await bash("dir");',
    'log(out);',
    '```',
    '普通示例：',
    '```js',
    'console.log("not a tool");',
    '```',
    '结束。',
  ].join('\n');
  assert.deepEqual(extractCuckooBlocks(text), [
    'const out = await bash("dir");\nlog(out);',
  ]);
});

test('提取多个 cuckoo 代码块并支持大小写语言名', () => {
  const text = '```Cuckoo\nawait read("a")\n```\n中间\n```cuckoo-js\nawait glob("*.js")\n```';
  assert.deepEqual(extractCuckooBlocks(text), ['await read("a")', 'await glob("*.js")']);
});

test('未闭合的 cuckoo 代码块不执行（避免半截脚本）', () => {
  const text = '```cuckoo\nawait bash("dir")\n';
  assert.deepEqual(extractCuckooBlocks(text), []);
});

test('strip 只移除 cuckoo 块，保留普通代码块和正文', () => {
  const text = 'A\n```cuckoo\nawait bash("dir")\n```\nB\n```js\nconsole.log(1)\n```\nC';
  assert.equal(stripCuckooBlocks(text), 'A\n\nB\n```js\nconsole.log(1)\n```\nC');
});

test('格式化工具结果：成功带输出，失败带 ERROR', () => {
  const ok = formatCuckooResult({ success: true, output: 'files' }, '结果：');
  assert.match(ok, /^结果：/);
  assert.match(ok, /files/);
  const bad = formatCuckooResult({ success: false, error: 'boom' }, '结果：');
  assert.match(bad, /ERROR: boom/);
});

test('格式化超长工具结果时限制在 12000 字符内，避免网关中段裁剪吃掉开头', () => {
  const out = 'HEAD\n' + 'x'.repeat(30000) + '\nTAIL';
  const msg = formatCuckooResult({ success: true, output: out }, '结果：');
  assert.ok(msg.length <= 12100, '实际 ' + msg.length);
  assert.match(msg, /HEAD/);
  assert.match(msg, /TAIL/);
  assert.match(msg, /结果过长，已截断/);
});

test('codePreview 压成单行并限长', () => {
  assert.equal(codePreview('const x = 1;\nlog(x);'), 'const x = 1; log(x);');
  assert.ok(codePreview('x'.repeat(500)).length <= 200);
});
