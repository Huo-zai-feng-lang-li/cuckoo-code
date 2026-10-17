'use strict';
/**
 * S-003 回归：cloudflared 候选路径按"可写者权限"排序。
 * Program Files / 用户目录优先，任意用户可写的 C:\cloudflared 根目录最后兜底。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { buildCloudflaredCandidates } from '../../src/remote/tunnel.js';

test('Windows：Program Files 排在 C:\\cloudflared 之前', () => {
  const list = buildCloudflaredCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
  const pf = list.indexOf('C:\\Program Files\\cloudflared\\cloudflared.exe');
  const root = list.indexOf('C:\\cloudflared\\cloudflared.exe');
  assert.ok(pf !== -1 && root !== -1);
  assert.ok(pf < root, '受保护的 Program Files 应优先于任意可写的根目录');
});

test('Windows：含用户 LocalAppData 目录', () => {
  const list = buildCloudflaredCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
  assert.ok(list.includes('C:\\Users\\u\\AppData\\Local\\cloudflared\\cloudflared.exe'));
});

test('Windows：无 LOCALAPPDATA 时不报错', () => {
  const list = buildCloudflaredCandidates('win32', {});
  assert.ok(list.length >= 4);
});

test('非 Windows：仅返回裸命令名', () => {
  assert.deepStrictEqual(buildCloudflaredCandidates('linux', {}), ['cloudflared']);
});
