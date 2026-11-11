import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import * as windowState from '../../src/app/window.js';
import { onHarnessExportResult, onSwitchShareResult, requestHarnessExport, requestShareFromWindow } from '../../src/app/ipc/window-groups.js';

afterEach(() => { windowState.removeWindow(97231); vi.useRealTimers(); });

function installWindow() {
  const win = new EventEmitter();
  win.id = 97231;
  const sent = [];
  const ai = { isDestroyed: () => false, send: (...args) => sent.push(args) };
  const harness = { isDestroyed: () => false, send: (...args) => sent.push(args) };
  windowState.addWindow(win, 'profile-test', 'deepseek', { state: {} }, { webContents: ai });
  windowState.getWindowContext(win.id).harnessView = { webContents: harness };
  return { win, sent, ai, harness };
}

test('分享回执只接受原 AI 页，不接受同 reqId 的其他页面', async () => {
  vi.useFakeTimers();
  const { win, sent, ai, harness } = installWindow();
  let settled = false;
  const result = requestShareFromWindow(win.id, 1000).then((value) => { settled = true; return value; });
  const reqId = sent[0][1].reqId;
  onSwitchShareResult({ sender: harness }, { reqId, ok: true, shareId: 'wrong' });
  expect(settled).toBe(false);
  onSwitchShareResult({ sender: ai }, { reqId, ok: true, shareId: 'correct' });
  expect(await result).toMatchObject({ shareId: 'correct' });
  expect(vi.getTimerCount()).toBe(0);
});

test('纯净状态导出回执只接受原 harness 页', async () => {
  vi.useFakeTimers();
  const { win, sent, ai, harness } = installWindow();
  let settled = false;
  const result = requestHarnessExport(win.id, 1000).then((value) => { settled = true; return value; });
  const reqId = sent[0][1].reqId;
  onHarnessExportResult({ sender: ai }, { reqId, state: { messages: ['wrong'] } });
  expect(settled).toBe(false);
  onHarnessExportResult({ sender: harness }, { reqId, state: { messages: ['correct'] } });
  expect(await result).toEqual({ messages: ['correct'] });
  expect(vi.getTimerCount()).toBe(0);
});
