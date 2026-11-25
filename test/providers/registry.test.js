'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { providers, getProvider, getAllProviders, getProviderByUrl } from '../../src/providers/registry.js';

test('providers 是非空数组', () => {
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length >= 2);
});

test('getAllProviders 只含 DeepSeek 与 API Key', () => {
  const all = getAllProviders();
  const ids = all.map((p) => p.id);
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('api-key'));
  assert.ok(!ids.includes('claude'));
  assert.ok(!ids.includes('chatgpt'));
});

test('getProvider 返回对应 provider', () => {
  assert.strictEqual(getProvider('deepseek').id, 'deepseek');
  assert.strictEqual(getProvider('api-key').id, 'api-key');
  assert.strictEqual(getProvider('claude'), null);
  assert.strictEqual(getProvider('chatgpt'), null);
});

test('getProvider 未知 id 返回 null（失败路径）', () => {
  assert.strictEqual(getProvider('no-such-provider'), null);
  assert.strictEqual(getProvider(''), null);
});

test('getProviderByUrl 识别 DeepSeek', () => {
  assert.strictEqual(getProviderByUrl('https://chat.deepseek.com/').id, 'deepseek');
  assert.strictEqual(getProviderByUrl('https://chat.deepseek.com/a/chat/s/abc123').id, 'deepseek');
});

test('getProviderByUrl 不再识别 Claude / ChatGPT', () => {
  assert.strictEqual(getProviderByUrl('https://claude.ai/new'), null);
  assert.strictEqual(getProviderByUrl('https://claude.ai/chat/abc123'), null);
  assert.strictEqual(getProviderByUrl('https://chatgpt.com/'), null);
  assert.strictEqual(getProviderByUrl('https://chat.openai.com/c/abc'), null);
});

test('getProviderByUrl 未知 URL 返回 null（失败路径）', () => {
  assert.strictEqual(getProviderByUrl('https://example.com'), null);
  assert.strictEqual(getProviderByUrl('not a url'), null);
});

test('getProviderByUrl 空字符串 / null（失败路径）', () => {
  assert.strictEqual(getProviderByUrl(''), null);
  assert.strictEqual(getProviderByUrl(null), null);
  assert.strictEqual(getProviderByUrl(undefined), null);
});

test('内置 provider 均通过字段校验（有匹配方法）', () => {
  for (const p of getAllProviders()) {
    assert.strictEqual(typeof p.matchesUrl, 'function', p.id + ' 应有 matchesUrl');
    assert.strictEqual(typeof p.extractSessionId, 'function', p.id + ' 应有 extractSessionId');
  }
});
