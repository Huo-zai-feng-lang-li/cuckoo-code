'use strict';
/**
 * API 上下文预算：不按固定条数裁剪，按 token 预算裁剪，且不能把
 * assistant(tool_calls) 与 tool 结果切成孤儿。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { estimateTokens, estimateMessageTokens, trimMessagesToBudget, resolveContextBudget } from '../../src/api-transport/context.js';

test('中英文混合 token 估算：中文明显比英文更贵', () => {
  const en = estimateTokens('hello world this is a test');
  const zh = estimateTokens('这是一段中文测试内容');
  assert.ok(zh > en, '同样长度中文 token 应更多');
  assert.ok(estimateTokens('') === 0);
});

test('预算不足时保留系统消息和最近一轮，且从 user 边界开始', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'old question ' + 'x'.repeat(800) },
    { role: 'assistant', content: 'old answer ' + 'y'.repeat(800) },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'tool result' },
    { role: 'assistant', content: 'done' },
  ];
  const out = trimMessagesToBudget(messages, 300);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user');
  assert.equal(out[out.length - 1].content, 'done');
  assert.ok(out.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
  assert.ok(!out.some((m) => m.role === 'tool' && !out.some((a) => a.tool_calls && a.tool_calls.some((c) => c.id === m.tool_call_id))));
});

test('预算充足时不裁剪', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const out = trimMessagesToBudget(messages, 10000);
  assert.deepEqual(out, messages);
});

test('最新一轮放不下时只保留截断后的 user，不留下孤儿 tool 消息', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'x'.repeat(2000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'z'.repeat(3000) },
    { role: 'assistant', content: 'done' },
  ];
  const out = trimMessagesToBudget(messages, 100);
  assert.equal(out[0].role, 'system');
  assert.equal(out.length, 2, '只应保留 system + 截断后的 user');
  assert.equal(out[1].role, 'user');
  assert.ok(!out.some((m) => m.role === 'tool'), '不能保留孤儿 tool');
  assert.ok(String(out[1].content).includes('…'), '应带截断标记');
});

test('文本附件大小计入 token 估算，避免 materialize 后超预算', () => {
  const m = {
    role: 'user',
    content: '看附件',
    attachments: [{ name: 'big.txt', mime: 'text/plain', path: '/tmp/big.txt', size: 40000, kind: 'text' }],
  };
  const base = estimateMessageTokens({ role: 'user', content: '看附件' });
  const withAttachment = estimateMessageTokens(m);
  assert.ok(withAttachment > base, '文本附件必须被计入预算');
});

test('internal user 是同一轮的续传，不新开上下文轮次', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'old ' + 'x'.repeat(2000) },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: '```cuckoo\nawait bash("dir")\n```', internal: true },
    { role: 'user', content: 'tool result ' + 'r'.repeat(80), internal: true },
    { role: 'assistant', content: 'done' },
  ];
  const out = trimMessagesToBudget(messages, 300);
  assert.ok(out.some((m) => m.content === 'new question'), '不能把 internal 工具结果当成新轮次而裁掉真实问题');
  assert.ok(out.some((m) => m.content === 'done'));
});

test('上下文预算扣除输出、工具定义和安全余量', () => {
  const b = resolveContextBudget({ contextWindow: 131072, maxOutputTokens: 8192, toolsTokens: 2000 });
  assert.ok(b.inputBudget < 131072 - 8192);
  assert.ok(b.inputBudget > 100000);
  assert.equal(b.safetyTokens, 1024);
});

test('极小上下文窗口不会算出负预算', () => {
  const b = resolveContextBudget({ contextWindow: 4096, maxOutputTokens: 8192, toolsTokens: 2000 });
  assert.ok(b.inputBudget >= 512);
});
