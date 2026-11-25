'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { streamChat, mergeToolCallDelta, retryDelayMs, cancelChatTurn } from '../../src/api-transport/client.js';

function sseResponse(chunks, init) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

const CONFIG = {
  baseUrl: 'http://127.0.0.1:3000/openai/v1',
  endpoint: 'http://127.0.0.1:3000/openai/v1/chat/completions',
  apiKey: '',
  model: 'aws',
};

test('流式读取：拼接 delta 正文并回调累计文本，最终 [DONE] 结束', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const seen = [];
  const r = await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
    onText: (text, think) => seen.push([text, think]),
  });
  assert.equal(r.text, '你好');
  assert.equal(r.finishReason, 'stop');
  assert.equal(seen.at(-1)[0], '你好');
  assert.equal(calls[0].url, CONFIG.endpoint);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'aws');
});

test('conversationId 走 body，让网关复用同一个网页会话', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
  };
  await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    conversationId: 'cuckoo-js:s1',
    fetchImpl,
  });
  assert.equal(captured.conversation_id, 'cuckoo-js:s1');
});

test('displayText 只用于界面，不发给上游', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
  };
  await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: '<skill>hidden</skill>\n真正问题', displayText: '真正问题', attachments: [] }],
    fetchImpl,
  });
  assert.equal(captured.messages.length, 1);
  assert.equal('displayText' in captured.messages[0], false, '本地展示字段不得进请求体');
  assert.ok(captured.messages[0].content.includes('hidden'), '发给模型的 content 仍是完整文本');
});

test('网关只发 finish_reason 不发 [DONE] 且连接不关闭时，仍能收尾', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'));
      // 故意不 close：有的反代/网关会保持 SSE 长连接，只给 finish_reason。
    },
  });
  const fetchImpl = async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const r = await streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(r.text, 'done');
  assert.equal(r.finishReason, 'stop');
});

test('有 Key 时发送 Authorization，不把 Key 写进 body', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = init;
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  await streamChat({
    config: { ...CONFIG, apiKey: 'sk-test' },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(captured.headers.Authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(captured.body).apiKey, undefined);
});

test('HTTP 非 2xx 抛带状态码的错误，不把响应体当成功文本', async () => {
  const fetchImpl = async () => new Response('{"error":"bad key"}', { status: 401 });
  await assert.rejects(
    () => streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }], fetchImpl }),
    (err) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /bad key/);
      return true;
    },
  );
});

test('服务端忽略 stream 直接返回 JSON 时，也能取到 message.content', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: '非流式回复' }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const r = await streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(r.text, '非流式回复');
  assert.equal(r.finishReason, 'stop');
});

test('abort 后抛出 AbortError，不伪装成成功', async () => {
  const controller = new AbortController();
  const fetchImpl = () => new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const p = streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => p, (err) => err.name === 'AbortError');
});

test('mergeToolCallDelta 按 index 拼接 arguments，并保留 id/name', () => {
  let calls = mergeToolCallDelta([], [{
    index: 0,
    id: 'call_a',
    type: 'function',
    function: { name: 'read', arguments: '{"path":"a' },
  }]);
  calls = mergeToolCallDelta(calls, [{
    index: 0,
    function: { arguments: '.txt"}' },
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_a');
  assert.equal(calls[0].function.name, 'read');
  assert.equal(calls[0].function.arguments, '{"path":"a.txt"}');
});

test('SSE 流式返回 tool_calls 时，streamChat 聚合成完整调用', async () => {
  const fetchImpl = async () => sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const r = await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: '读文件' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } }],
    fetchImpl,
  });
  assert.equal(r.text, '');
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].id, 'call_1');
  assert.equal(r.toolCalls[0].function.name, 'read');
  assert.equal(r.toolCalls[0].function.arguments, '{"path":"a.txt"}');
});

test('reasoning_effort / max_tokens 按配置下发，auto 不下发 reasoning_effort', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = init;
    return sseResponse(['data: [DONE]\n\n']);
  };
  await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
    reasoningEffort: 'high',
    maxOutputTokens: 4096,
    usageReporting: 'on',
  });
  const body = JSON.parse(captured.body);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.stream_options, { include_usage: true });

  captured = null;
  await streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }], fetchImpl, reasoningEffort: 'auto' });
  assert.equal(JSON.parse(captured.body).reasoning_effort, undefined);
});

test('SSE 最后一条 usage 被回传，便于 Token 面板显示真实消耗', async () => {
  const fetchImpl = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const r = await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
    usageReporting: 'on',
  });
  assert.equal(r.usage.prompt_tokens, 10);
  assert.equal(r.usage.completion_tokens, 2);
  assert.equal(r.usage.total_tokens, 12);
});

test('工具定义会进入请求体，未传工具时不出现', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = init;
    return sseResponse(['data: [DONE]\n\n']);
  };
  await streamChat({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } }],
    fetchImpl,
  });
  const body = JSON.parse(captured.body);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools.length, 1);

  captured = null;
  await streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(JSON.parse(captured.body).tools, undefined);
});

test('总超时会抛 ApiTimeoutError，不会伪装成用户取消', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted by timeout');
      err.name = 'AbortError';
      reject(err);
    });
  });
  await assert.rejects(
    () => streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }], fetchImpl, timeoutMs: 50 }),
    (err) => {
      assert.equal(err.name, 'ApiTimeoutError');
      assert.match(err.message, /超时/);
      return true;
    },
  );
});

test('停止入口：把 conversation_id 发到 /chat/completions/stop', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, reason: 'stopping' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const r = await cancelChatTurn(
    { ...CONFIG, endpoint: 'http://127.0.0.1:3000/openai/v1/chat/completions?x=1', apiKey: 'k' },
    'cuckoo-js:s1',
    { fetchImpl },
  );
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/openai/v1/chat/completions/stop?x=1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'aws');
  assert.equal(body.conversation_id, 'cuckoo-js:s1');
});

test('停止入口：网关说找不到回合时 ok=false 但不抛错', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, reason: 'no-active-turn' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const r = await cancelChatTurn(CONFIG, 'cuckoo-js:s1', { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-active-turn');
});

test('Retry-After 优先于默认退避，且退避有 2s/5s 基础节奏', () => {
  assert.equal(retryDelayMs(0, 3000), 3000);
  assert.equal(retryDelayMs(0, 60000), 30000);
  const first = retryDelayMs(0);
  const second = retryDelayMs(1);
  assert.ok(first >= 1600 && first <= 2400, '第一次退避 2s ±20%');
  assert.ok(second >= 4000 && second <= 6000, '第二次退避 5s ±20%');
});
