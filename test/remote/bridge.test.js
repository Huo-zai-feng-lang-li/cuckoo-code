'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { stripBlocks } from '../../src/bridge/remote-bridge.js';

test('stripBlocks 纯文本保持原样', () => {
  const text = '你好，我是 Cuckoo Code 助手。';
  assert.strictEqual(stripBlocks(text), text);
});

test('stripBlocks 剔除完整 cuckoo 工具代码块', () => {
  const input = '正在为您读取文件：\n```cuckoo\nawait read({ path: "a.txt" });\n```\n读取完成。';
  const out = stripBlocks(input);
  assert.strictEqual(out, '正在为您读取文件：\n\n读取完成。');
});

test('stripBlocks 剔除流式未闭合 cuckoo 工具代码块', () => {
  const input = '正在思考...\n```cuckoo\nawait edit(';
  const out = stripBlocks(input);
  assert.strictEqual(out, '正在思考...');
});

test('stripBlocks 剔除末尾刚输出的 cuckoo 围栏标记', () => {
  const input = '开始执行任务：\n```cuckoo';
  const out = stripBlocks(input);
  assert.strictEqual(out, '开始执行任务：');
});

test('stripBlocks 剔除包含工具特征的 js/javascript 代码块', () => {
  const input = '执行工具：\n```javascript\nawait write({ path: "test.js", content: "ok" });\n```\n写入完毕。';
  const out = stripBlocks(input);
  assert.strictEqual(out, '执行工具：\n\n写入完毕。');
});

test('stripBlocks 保留普通的 JavaScript 教学或展示代码块', () => {
  const input = '这是实现防抖函数的代码：\n```javascript\nfunction debounce(fn, ms) {\n  let timer = null;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n请参考使用。';
  const out = stripBlocks(input);
  assert.strictEqual(out, input.trim(), '普通 JavaScript 示例代码必须完整保留');
});

test('stripBlocks 保留 Python / HTML / Rust 等其他语言代码块', () => {
  const input = '这是 Python 代码：\n```python\nprint("hello world")\n```\n请运行。';
  const out = stripBlocks(input);
  assert.strictEqual(out, input.trim());
});
