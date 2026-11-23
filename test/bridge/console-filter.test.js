'use strict';
/**
 * preload 控制台降噪测试。
 *
 * 生产版只静默 log / info / debug，保留 warn / error；
 * 开发版或 CUCKOO_DEBUG=1 时必须保留全部日志，避免调试失明。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { installConsoleFilter, isDebugConsoleEnabled } from '../../src/bridge/console-filter.js';

function makeFakeConsole() {
  const calls = [];
  const record = (kind) => (...args) => calls.push([kind, ...args]);
  return {
    calls,
    log: record('log'),
    info: record('info'),
    debug: record('debug'),
    warn: record('warn'),
    error: record('error'),
  };
}

test('生产模式静默 log / info / debug，保留 warn / error', () => {
  const fake = makeFakeConsole();
  assert.strictEqual(installConsoleFilter(fake, false), true);
  fake.log('噪声');
  fake.info('噪声');
  fake.debug('噪声');
  fake.warn('警告');
  fake.error('错误');
  assert.deepStrictEqual(fake.calls, [
    ['warn', '警告'],
    ['error', '错误'],
  ]);
});

test('调试模式不安装过滤器', () => {
  const fake = makeFakeConsole();
  assert.strictEqual(installConsoleFilter(fake, true), false);
  fake.log('调试日志');
  assert.deepStrictEqual(fake.calls, [['log', '调试日志']]);
});

test('CUCKOO_DEBUG=1 或开发启动时视为调试模式', () => {
  assert.strictEqual(isDebugConsoleEnabled({ CUCKOO_DEBUG: '1' }, false), true);
  assert.strictEqual(isDebugConsoleEnabled({ CUCKOO_DEBUG: 'true' }, false), true);
  assert.strictEqual(isDebugConsoleEnabled({}, true), true);
  assert.strictEqual(isDebugConsoleEnabled({}, false), false);
});
