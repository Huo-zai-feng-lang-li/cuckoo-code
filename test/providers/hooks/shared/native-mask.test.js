'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { maskAsNative } from '../../../../src/providers/hooks/shared/native-mask.js';

test('maskAsNative: 包装后的方法伪装成原生 [native code] 且无 prototype', () => {
  const host = {
    fetch(url) {
      return url;
    },
  };
  const masked = maskAsNative(host.fetch, 'fetch', 1);

  // 1. 实例 toString
  assert.strictEqual(masked.toString(), 'function fetch() { [native code] }');

  // 2. Function.prototype.toString.call 原型链调用
  assert.strictEqual(Function.prototype.toString.call(masked), 'function fetch() { [native code] }');

  // 3. 原生方法无自有 prototype
  assert.strictEqual(Object.prototype.hasOwnProperty.call(masked, 'prototype'), false);

  // 4. name 和 length 对齐
  assert.strictEqual(masked.name, 'fetch');
  assert.strictEqual(masked.length, 1);
});

test('maskAsNative: 普通函数包装同样支持原生 toString 与原型伪装', () => {
  function regular(a) {
    return a;
  }
  const masked = maskAsNative(regular, 'regular', 1);
  assert.strictEqual(masked.toString(), 'function regular() { [native code] }');
  assert.strictEqual(Function.prototype.toString.call(masked), 'function regular() { [native code] }');
});

test('maskAsNative: 未包装的常规函数依然正常输出源代码', () => {
  function normalFunc(a, b) {
    return a + b;
  }
  const str = Function.prototype.toString.call(normalFunc);
  assert.ok(str.includes('return a + b'), '未包装函数应保留原始代码实现');
});

test('maskAsNative: Function.prototype.toString 自身的 toString 也伪装成 native', () => {
  const str = Function.prototype.toString.call(Function.prototype.toString);
  assert.strictEqual(str, 'function toString() { [native code] }');
});

test('maskAsNative: 非函数类型安全放行', () => {
  assert.strictEqual(maskAsNative(null), null);
  assert.strictEqual(maskAsNative(undefined), undefined);
  assert.strictEqual(maskAsNative('string'), 'string');
});
