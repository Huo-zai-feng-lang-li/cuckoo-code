'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { buildOpenAiTools, formatToolCall } from '../../src/api-transport/tool-loop.js';

test('Cuckoo 工具注册表转成 OpenAI tools schema', () => {
  const tools = buildOpenAiTools();
  assert.ok(tools.length >= 10);
  const read = tools.find((t) => t.function.name === 'read');
  assert.ok(read, '应包含 read 工具');
  assert.equal(read.type, 'function');
  assert.equal(read.function.parameters.type, 'object');
  assert.ok(Array.isArray(read.function.parameters.required));
  assert.ok(!tools.some((t) => t.function.name === 'attachFile'), 'API 模式不应暴露网页附件工具');
  assert.ok(!tools.some((t) => t.function.name === 'runAgent'), 'API 模式不应暴露网页子代理工具');
  assert.ok(!tools.some((t) => t.function.name === 'runAgents'), 'API 模式不应暴露网页子代理工具');
  for (const t of tools) {
    assert.match(t.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
  }
});

test('工具卡片摘要只截断参数，不改变工具名', () => {
  const call = {
    id: 'call_1',
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ filePath: 'README.md', limit: 5 }) },
  };
  const text = formatToolCall(call);
  assert.ok(text.startsWith('read('));
  assert.ok(text.includes('README.md'));
  const huge = { ...call, function: { name: 'write', arguments: 'x'.repeat(5000) } };
  assert.ok(formatToolCall(huge).length < 1300);
});
