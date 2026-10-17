'use strict';
import { test, expect } from 'vitest';
import { isOwnWindowUrl, isProviderHost, checkSenderUrl } from '../../src/infra/host-allowlist.js';

const providerMatchers = [
  (u) => /(?:^|\.)example\.com$/.test(new URL(u).hostname),
  (u) => /(?:^|\.)openai\.com$/.test(new URL(u).hostname),
];

test('isOwnWindowUrl：file/data/about:blank 放行', () => {
  expect(isOwnWindowUrl('file:///C:/app/harness.html')).toBe(true);
  expect(isOwnWindowUrl('data:text/html,<h1>x</h1>')).toBe(true);
  expect(isOwnWindowUrl('about:blank')).toBe(true);
  expect(isOwnWindowUrl('https://evil.example.com/')).toBe(false);
  expect(isOwnWindowUrl('')).toBe(false);
  expect(isOwnWindowUrl(123)).toBe(false);
});

test('isProviderHost：任一 matcher 命中即 true', () => {
  expect(isProviderHost('https://chat.example.com/', providerMatchers)).toBe(true);
  expect(isProviderHost('https://api.openai.com/v1', providerMatchers)).toBe(true);
  expect(isProviderHost('https://evil.attacker.com/', providerMatchers)).toBe(false);
  expect(isProviderHost('not-a-url', providerMatchers)).toBe(false);
});

test('checkSenderUrl：provider 域放行', () => {
  const r = checkSenderUrl('https://chat.example.com/session', providerMatchers);
  expect(r.ok).toBe(true);
  expect(r.kind).toBe('provider');
  expect(r.host).toBe('chat.example.com');
});

test('checkSenderUrl：第三方 http 域拒绝（unknown）', () => {
  const r = checkSenderUrl('https://evil.attacker.com/', providerMatchers);
  expect(r.ok).toBe(false);
  expect(r.kind).toBe('unknown');
});

test('checkSenderUrl：自有窗口放行', () => {
  const r = checkSenderUrl('file:///C:/app/shell.html', providerMatchers);
  expect(r.ok).toBe(true);
  expect(r.kind).toBe('own-window');
});

test('checkSenderUrl：解析失败/空 URL → unknown', () => {
  expect(checkSenderUrl('', providerMatchers).ok).toBe(false);
  expect(checkSenderUrl('::bad url::', providerMatchers).ok).toBe(false);
});

test('checkSenderUrl：javascript: 等非自有协议 → unknown', () => {
  const r = checkSenderUrl('javascript:alert(1)', providerMatchers);
  expect(r.ok).toBe(false);
  expect(r.kind).toBe('unknown');
});
