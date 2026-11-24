'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { apiTransportProvider, isApiTransportProvider } from '../../src/api-transport/provider.js';

test('API provider 字段完整，能通过 Provider 校验', () => {
  assert.equal(apiTransportProvider.id, 'api-key');
  assert.equal(apiTransportProvider.name, 'API Key / OpenAI 兼容');
  assert.equal(apiTransportProvider.homeUrl, 'about:blank#cuckoo-api');
  assert.equal(typeof apiTransportProvider.matchesUrl, 'function');
  assert.equal(typeof apiTransportProvider.extractSessionId, 'function');
  assert.equal(apiTransportProvider.extractSessionId('about:blank#cuckoo-api'), 'api');
});

test('API provider 只认专用 about 标记，不抢占普通空白页/网页平台', () => {
  assert.equal(apiTransportProvider.matchesUrl('about:blank#cuckoo-api'), true);
  assert.equal(apiTransportProvider.matchesUrl('about:blank'), false);
  assert.equal(apiTransportProvider.matchesUrl('https://chat.deepseek.com/'), false);
  assert.equal(apiTransportProvider.matchesUrl('https://chatgpt.com/'), false);
});

test('isApiTransportProvider 只认同一个 id', () => {
  assert.equal(isApiTransportProvider('api-key'), true);
  assert.equal(isApiTransportProvider('deepseek'), false);
  assert.equal(isApiTransportProvider(''), false);
});
