'use strict';
/**
 * P0 接线守卫：登录页判定本身有单测，但“hook 在 init 之外”“init 先判 auth
 * 再置幂等”“不 patch history”是三个最容易在重构中回退的接线点。
 * 这里直接读源码锁住位置与顺序，不做行为模拟（entry.ts 依赖 electron preload）。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/bridge/entry.ts'),
  'utf8',
);

test('平台 hook 在模块顶层注入，且注入前判 auth 页', () => {
  const fnIdx = SRC.indexOf('function injectProviderHook');
  const callIdx = SRC.indexOf('injectProviderHook();', fnIdx);
  assert.ok(fnIdx >= 0, '必须存在 injectProviderHook');
  assert.ok(callIdx > fnIdx, '必须在模块顶层调用 injectProviderHook');
  const body = SRC.slice(fnIdx, callIdx);
  assert.match(body, /isAuthPage\(window\.location\.href\)/, 'hook 注入前必须判 auth 页');
});

test('init 先判 auth 再置 overlayInitialized，并带幂等守卫', () => {
  const fnIdx = SRC.indexOf('function init(): void');
  assert.ok(fnIdx >= 0, '必须存在 init');
  const body = SRC.slice(fnIdx, fnIdx + 900);
  assert.match(body, /if \(overlayInitialized\) return;/);
  const authIdx = body.indexOf('isAuthPage(window.location.href)');
  const flagIdx = body.indexOf('overlayInitialized = true');
  assert.ok(authIdx >= 0, 'init 必须判 auth 页');
  assert.ok(flagIdx > authIdx, 'auth 页不能置 overlayInitialized，否则登录后 init 被挡');
});

test('登录退出监听使用 Navigation API / 轮询，不改写 history', () => {
  const fnIdx = SRC.indexOf('function watchAuthExit');
  const endIdx = SRC.indexOf('let overlayInitialized', fnIdx);
  assert.ok(fnIdx >= 0 && endIdx > fnIdx, '必须存在 watchAuthExit');
  const body = SRC.slice(fnIdx, endIdx);
  assert.match(body, /navigatesuccess/);
  assert.match(body, /setInterval\(check, 1500\)/);
  assert.doesNotMatch(body, /history\s*\.\s*(?:pushState|replaceState)\s*(?:=|\()/, 'login 页不能 patch history（会新增指纹）');
});
