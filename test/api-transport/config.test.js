'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { resolveApiConfig, resolveModelsEndpoint } from '../../src/api-transport/config.js';

test('规整显式配置：去空白、去尾部斜杠、允许空 Key', () => {
  const r = resolveApiConfig(
    { baseUrl: '  http://192.168.110.49:8080/v1/  ', apiKey: '   ', model: ' agnes-3.0-flash ' },
    {},
  );
  assert.equal(r.success, true);
  assert.equal(r.config.baseUrl, 'http://192.168.110.49:8080/v1');
  assert.equal(r.config.apiKey, '');
  assert.equal(r.config.model, 'agnes-3.0-flash');
  assert.equal(r.config.endpoint, 'http://192.168.110.49:8080/v1/chat/completions');
});

test('环境变量覆盖显式配置', () => {
  const r = resolveApiConfig(
    { baseUrl: 'http://old/v1', apiKey: 'old', model: 'old' },
    {
      CUCKOO_API_BASE: 'http://127.0.0.1:3000/openai/v1',
      CUCKOO_API_KEY: 'local',
      CUCKOO_API_MODEL: 'aws',
    },
  );
  assert.equal(r.success, true);
  assert.equal(r.config.endpoint, 'http://127.0.0.1:3000/openai/v1/chat/completions');
  assert.equal(r.config.apiKey, 'local');
  assert.equal(r.config.model, 'aws');
});

test('已经带 /chat/completions 的地址不重复拼接', () => {
  const r = resolveApiConfig(
    { baseUrl: 'http://127.0.0.1:3000/openai/v1/chat/completions', apiKey: '', model: 'aws' },
    {},
  );
  assert.equal(r.success, true);
  assert.equal(r.config.endpoint, 'http://127.0.0.1:3000/openai/v1/chat/completions');
});

test('模型列表地址兼容根地址、/v1、已带 /chat/completions 或 /models', () => {
  assert.equal(resolveModelsEndpoint('http://h'), 'http://h/models');
  assert.equal(resolveModelsEndpoint('http://h/v1/'), 'http://h/v1/models');
  assert.equal(resolveModelsEndpoint('http://h/v1/chat/completions'), 'http://h/v1/models');
  assert.equal(resolveModelsEndpoint('http://h/v1/models'), 'http://h/v1/models');
});

test('缺少 Base URL 或模型时给出明确错误', () => {
  const noBase = resolveApiConfig({ baseUrl: '', model: 'aws' }, {});
  assert.equal(noBase.success, false);
  assert.match(noBase.error, /Base URL/);

  const noModel = resolveApiConfig({ baseUrl: 'http://127.0.0.1:3000/openai/v1', model: '' }, {});
  assert.equal(noModel.success, false);
  assert.match(noModel.error, /模型/);
});

test('拒绝非 http/https 地址，防止把密钥发到错误协议', () => {
  const r = resolveApiConfig({ baseUrl: 'ftp://example.com/v1', model: 'aws' }, {});
  assert.equal(r.success, false);
  assert.match(r.error, /http/);
});

test('API 配置不再借用提示词增强的 URL/Key/Model（两套配置彻底分开）', () => {
  const r = resolveApiConfig({ baseUrl: '', apiKey: '', model: '' }, {});
  assert.equal(r.success, false);
  assert.match(r.error, /Base URL/);
});

test('空 Key 明确表示无鉴权网关，不会被其它配置回填', () => {
  const r = resolveApiConfig({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', model: 'm' }, {});
  assert.equal(r.success, true);
  assert.equal(r.config.apiKey, '');
});
