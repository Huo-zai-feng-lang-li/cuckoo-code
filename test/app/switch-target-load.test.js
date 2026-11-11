import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { loadSwitchTarget } from '../../src/app/switch-target-load.js';

afterEach(() => vi.useRealTimers());

test('目标导航收到 did-finish-load 才算就绪', async () => {
  vi.useFakeTimers();
  const wc = new EventEmitter();
  wc.loadURL = async () => {};
  let settled = false;
  const result = loadSwitchTarget(wc, 'https://chat.deepseek.com/share/id', 1000).then((v) => { settled = true; return v; });
  await Promise.resolve();
  expect(settled).toBe(false);
  wc.emit('did-finish-load');
  expect(await result).toBe(true);
  expect(wc.listenerCount('did-finish-load')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('目标导航超时清理监听并返回失败', async () => {
  vi.useFakeTimers();
  const wc = new EventEmitter();
  wc.loadURL = () => new Promise(() => {});
  const result = loadSwitchTarget(wc, 'https://chat.deepseek.com/share/id', 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(false);
  expect(wc.listenerCount('did-finish-load')).toBe(0);
});
