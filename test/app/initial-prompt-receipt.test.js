import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { waitForInitialPromptReceipt } from '../../src/app/ipc/initial-prompt-receipt.js';

afterEach(() => vi.useRealTimers());

test('仅目标 AI 页面和匹配 requestId 能确认初始提示', async () => {
  vi.useFakeTimers();
  const ipc = new EventEmitter();
  const target = {};
  const receipt = waitForInitialPromptReceipt(ipc, target, 60000);
  ipc.emit('initial-prompt-result', { sender: {} }, { requestId: receipt.requestId, success: true });
  ipc.emit('initial-prompt-result', { sender: target }, { requestId: 'old', success: true });
  expect(ipc.listenerCount('initial-prompt-result')).toBe(1);
  ipc.emit('initial-prompt-result', { sender: target }, { requestId: receipt.requestId, success: true });
  expect(await receipt.result).toBe(true);
  expect(ipc.listenerCount('initial-prompt-result')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('发送失败与超时均为 false 并清理监听', async () => {
  vi.useFakeTimers();
  const ipc = new EventEmitter();
  const target = {};
  const failed = waitForInitialPromptReceipt(ipc, target, 60000);
  ipc.emit('initial-prompt-result', { sender: target }, { requestId: failed.requestId, success: false });
  expect(await failed.result).toBe(false);
  const timedOut = waitForInitialPromptReceipt(ipc, target, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await timedOut.result).toBe(false);
  expect(ipc.listenerCount('initial-prompt-result')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('初始化失败时取消等待，不留下回执监听', async () => {
  const ipc = new EventEmitter();
  const receipt = waitForInitialPromptReceipt(ipc, {}, 60000);
  receipt.cancel();
  expect(await receipt.result).toBe(false);
  expect(ipc.listenerCount('initial-prompt-result')).toBe(0);
});
