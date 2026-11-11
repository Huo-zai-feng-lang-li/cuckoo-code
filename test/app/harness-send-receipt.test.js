import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { waitForUserMessageReceipt } from '../../src/app/ipc/harness-send-receipt.js';

afterEach(() => vi.useRealTimers());

test('仅目标 AI 页面和匹配 requestId 能确认用户消息投递', async () => {
  vi.useFakeTimers();
  const ipc = new EventEmitter();
  const target = {};
  const receipt = waitForUserMessageReceipt(ipc, target, 150000);
  // 跨 sender 与旧 requestId 都不应 settle
  ipc.emit('harness-user-message-result', { sender: {} }, { requestId: receipt.requestId, success: true });
  ipc.emit('harness-user-message-result', { sender: target }, { requestId: 'old', success: true });
  expect(ipc.listenerCount('harness-user-message-result')).toBe(1);
  ipc.emit('harness-user-message-result', { sender: target }, { requestId: receipt.requestId, success: true });
  const res = await receipt.result;
  expect(res.success).toBe(true);
  expect(ipc.listenerCount('harness-user-message-result')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('投递失败回执携带 error，超时按失败处理并清理监听', async () => {
  vi.useFakeTimers();
  const ipc = new EventEmitter();
  const target = {};
  const failed = waitForUserMessageReceipt(ipc, target, 150000);
  ipc.emit('harness-user-message-result', { sender: target }, {
    requestId: failed.requestId, success: false, error: '未找到输入框',
  });
  const res = await failed.result;
  expect(res.success).toBe(false);
  expect(res.error).toBe('未找到输入框');

  const timedOut = waitForUserMessageReceipt(ipc, target, 100);
  await vi.advanceTimersByTimeAsync(100);
  const res2 = await timedOut.result;
  expect(res2.success).toBe(false);
  expect(ipc.listenerCount('harness-user-message-result')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('取消等待不留下回执监听', async () => {
  const ipc = new EventEmitter();
  const receipt = waitForUserMessageReceipt(ipc, {}, 60000);
  receipt.cancel();
  const res = await receipt.result;
  expect(res.success).toBe(false);
  expect(ipc.listenerCount('harness-user-message-result')).toBe(0);
});
