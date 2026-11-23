'use strict';
/**
 * 登录/OAuth 页面判定测试。
 *
 * 这层必须纯函数、可单测：它决定 preload 是否跳过 overlay 与平台 hook，
 * 判错会直接把面板/hook 注入登录页（反检测最敏感的位置）。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { isAuthPage } from '../../src/bridge/auth-page.js';

test('DeepSeek 的 /sign_in 与 /sign-in 都判定为登录页', () => {
  assert.strictEqual(isAuthPage('https://chat.deepseek.com/sign_in'), true);
  assert.strictEqual(isAuthPage('https://chat.deepseek.com/sign-in'), true);
});

test('注册页 /signup、/sign_up 也判定为登录页', () => {
  assert.strictEqual(isAuthPage('https://chat.deepseek.com/signup'), true);
  assert.strictEqual(isAuthPage('https://chat.deepseek.com/sign_up'), true);
});

test('微信扫码登录页按 host 判定，不依赖 redirect_uri 查询参数', () => {
  assert.strictEqual(
    isAuthPage('https://open.weixin.qq.com/connect/qrconnect?appid=x&redirect_uri=https%3A%2F%2Fchat.deepseek.com%2Fcallback'),
    true,
  );
});

test('Google / Microsoft / GitHub 登录页判定', () => {
  assert.strictEqual(isAuthPage('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  assert.strictEqual(isAuthPage('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), true);
  assert.strictEqual(isAuthPage('https://github.com/login'), true);
});

test('正常对话页不能被误判（query 里的 redirect_uri 不算）', () => {
  assert.strictEqual(isAuthPage('https://chat.deepseek.com/a/chat/s/abc'), false);
  assert.strictEqual(isAuthPage('https://chat.deepseek.com/?redirect_uri=https%3A%2F%2Fexample.com'), false);
});

test('非法/非 HTTP URL 安全回退为非登录页', () => {
  assert.strictEqual(isAuthPage(''), false);
  assert.strictEqual(isAuthPage('not a url'), false);
  assert.strictEqual(isAuthPage('file:///C:/tmp/x.html'), false);
});
