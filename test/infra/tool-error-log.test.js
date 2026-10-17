'use strict';
import { test, expect } from 'vitest';
import { redactSecrets } from '../../src/infra/tool-error-log.js';

test('A-012：顶层敏感字段打码', () => {
  const out = redactSecrets({ host: 'db', password: 's3cret', user: 'root' });
  expect(out.password).toBe('***REDACTED***');
  expect(out.host).toBe('db');
  expect(out.user).toBe('root');
});

test('A-012：嵌套对象与数组递归打码', () => {
  const out = redactSecrets({
    conn: { user: 'root', token: 'abc123', nested: { secret: 'x' } },
    rows: [{ name: 'a', apiKey: 'k1' }, { name: 'b' }],
  });
  expect(out.conn.token).toBe('***REDACTED***');
  expect(out.conn.nested.secret).toBe('***REDACTED***');
  expect(out.rows[0].apiKey).toBe('***REDACTED***');
  expect(out.rows[1].name).toBe('b');
});

test('A-012：大小写/下划线变体都命中', () => {
  const out = redactSecrets({ Password: 'a', PASSWD: 'b', api_key: 'c', Authorization: 'd' });
  expect(out.Password).toBe('***REDACTED***');
  expect(out.PASSWD).toBe('***REDACTED***');
  expect(out.api_key).toBe('***REDACTED***');
  expect(out.Authorization).toBe('***REDACTED***');
});

test('A-012：原值不被破坏（返回新对象）', () => {
  const input = { password: 'keep-me', ok: 1 };
  redactSecrets(input);
  expect(input.password).toBe('keep-me');
});

test('A-012：原始值/数组原样返回', () => {
  expect(redactSecrets('hello')).toBe('hello');
  expect(redactSecrets(123)).toBe(123);
  expect(redactSecrets(null)).toBeNull();
});
