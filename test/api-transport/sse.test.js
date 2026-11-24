'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { createFrameDecoder, parseSseBlock, extractOpenAiDelta } from '../../src/api-transport/sse.js';

test('SSE 解码器按空行切帧，兼容 CRLF', () => {
  const d = createFrameDecoder();
  const first = d.push('data: {"a":1}\r\n\r\ndata: {"b":2}\n\n');
  assert.equal(first.length, 2);
  assert.equal(first[0], 'data: {"a":1}');
  assert.equal(first[1], 'data: {"b":2}');
  assert.equal(d.push('data: tail').length, 0);
  assert.deepEqual(d.finish(), ['data: tail']);
});

test('parseSseBlock 解析 event 与 JSON，坏 JSON 不抛错', () => {
  const ok = parseSseBlock('event: message\ndata: {"x":1}');
  assert.equal(ok.event, 'message');
  assert.deepEqual(ok.json, { x: 1 });

  const bad = parseSseBlock('data: {oops');
  assert.equal(bad.json, null);
});

test('extractOpenAiDelta 提取正文、思考与 finish_reason', () => {
  const mid = extractOpenAiDelta({
    choices: [{ delta: { content: '你', reasoning_content: '先想' }, finish_reason: null }],
  });
  assert.equal(mid.text, '你');
  assert.equal(mid.think, '先想');
  assert.equal(mid.finishReason, null);

  const end = extractOpenAiDelta({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  assert.equal(end.text, '');
  assert.equal(end.finishReason, 'stop');
});

test('extractOpenAiDelta 兼容非流式 message.content', () => {
  const r = extractOpenAiDelta({ choices: [{ message: { content: '完整回复' }, finish_reason: 'stop' }] });
  assert.equal(r.text, '完整回复');
  assert.equal(r.think, '');
  assert.deepEqual(r.toolCalls, []);
});

test('extractOpenAiDelta 兼容非流式 message.content 数组', () => {
  const r = extractOpenAiDelta({
    choices: [{
      message: { content: [{ type: 'text', text: '数组回复' }, { type: 'text', text: '第二段' }] },
      finish_reason: 'stop',
    }],
  });
  assert.equal(r.text, '数组回复第二段');
  assert.equal(r.finishReason, 'stop');
});

test('extractOpenAiDelta 保留 tool_calls 分片', () => {
  const r = extractOpenAiDelta({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"path":' },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].index, 0);
  assert.equal(r.toolCalls[0].function.name, 'read');
  assert.equal(r.toolCalls[0].function.arguments, '{"path":');
});
