'use strict';
// Shard B 审计 PoC：解析器边界实证（只读，不改源码）
import { test } from 'vitest';
import assert from 'node:assert';
import { extractJsToolBlocks, hasOnlyFences, looksLikeToolScript } from '../../src/bridge/parser/js-detector.js';
import { looksLikeJsonToolCall } from '../../src/bridge/parser/json-detector.js';
import { createFrameDecoder } from '../../src/providers/hooks/shared/sse.js';

const F = '```';

test('PoC-1: 未闭合 cuckoo 块（流式截断）被 flush 提取 → 会被当完整代码执行', () => {
  const text = F + 'cuckoo\nawait write({ filePath: "x.txt", content: "incomplete';
  const blocks = extractJsToolBlocks(text);
  console.log('PoC-1 未闭合块提取结果:', JSON.stringify(blocks));
  assert.ok(blocks.length === 1, '未闭合块被 flush 返回（即截断代码会被执行）');
});

test('PoC-2: js 块含工具调用但正文有散文 → 不应执行（onlyFences=false）', () => {
  const text = '下面是示例：\n' + F + 'js\nawait read({filePath:"a"});\n' + F + '\n结束。';
  const blocks = extractJsToolBlocks(text);
  console.log('PoC-2 带散文的 js 块提取结果:', JSON.stringify(blocks));
  assert.ok(blocks.length === 0, '有散文的 js 块不误执行');
});

test('PoC-3: 整条回复只有 js 块且调用工具 → 执行', () => {
  const text = F + 'js\nawait read({filePath:"a"});\n' + F;
  const blocks = extractJsToolBlocks(text);
  console.log('PoC-3 纯 js 工具块提取结果:', JSON.stringify(blocks));
  assert.ok(blocks.length === 1);
});

test('PoC-4: 嵌套围栏——cuckoo 块内含 ``` 行 → 提前闭合，内容泄漏到下一块', () => {
  const text = F + 'cuckoo\nawait write({filePath:"a"});\n' + F + '\n' + F + 'cuckoo\nawait bash({command:"echo bad"});\n' + F;
  const blocks = extractJsToolBlocks(text);
  console.log('PoC-4 双 cuckoo 块提取结果数:', blocks.length, JSON.stringify(blocks));
  // 预期 2 块；验证围栏 toggle 行为
});

test('PoC-5: 4 反引号围栏 ``` 内部含三反引号示例', () => {
  const text = F + F + F + F + 'cuckoo\nawait read({filePath:"a"});\n' + F + F + F + F;
  const blocks = extractJsToolBlocks(text);
  console.log('PoC-5 四反引号围栏提取结果:', JSON.stringify(blocks));
  // slice(3) 会把第一个 ` 吃进 lang → lang='`cuckoo' → 不识别为 cuckoo
});

test('PoC-6: looksLikeJsonToolCall 对裸 {tool: 无引号也命中', () => {
  console.log('PoC-6 {tool: 命中=', looksLikeJsonToolCall('{tool: "bash"}'));
  console.log('PoC-6 {toolName: 命中=', looksLikeJsonToolCall('{toolName: "bash"}'));
  console.log('PoC-6 { "tool": 命中=', looksLikeJsonToolCall('{ "tool": "x" }'));
});

test('PoC-7: SSE 帧边界跨分片 \r\n\r + \n', () => {
  const d = createFrameDecoder();
  assert.deepStrictEqual(d.push('data: a\r\n\r'), []);
  const f = d.push('\ndata: b\n\n');
  console.log('PoC-7 跨 CRLF 边界帧:', JSON.stringify(f));
  assert.deepStrictEqual(f, ['data: a', 'data: b']);
});

test('PoC-8: SSE 帧边界跨分片 \n\n 拆为 \n + \n', () => {
  const d = createFrameDecoder();
  assert.deepStrictEqual(d.push('data: x\n'), []);
  const f = d.push('\ndata: y\n\n');
  console.log('PoC-8 跨 LF 边界帧:', JSON.stringify(f));
  assert.deepStrictEqual(f, ['data: x', 'data: y']);
});

test('PoC-9: 通知摘要正则 /s+/g 会吞掉字母 s', () => {
  const raw = 'Successfully saved the project settings now';
  const summary = String(raw || '').replace(/s+/g, ' ').trim();
  console.log('PoC-9 摘要原文=', raw);
  console.log('PoC-9 摘要结果=', summary);
  assert.notStrictEqual(summary, raw.replace(/\s+/g, ' ').trim());
});
