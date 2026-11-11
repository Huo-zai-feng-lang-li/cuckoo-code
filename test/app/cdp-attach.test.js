import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import { cdpAttach } from '../../src/app/ipc/cdp-attach.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function browserBoundary({ readyAfter = 0, hasEntry = true, preAttached = false } = {}) {
  const debuggerApi = new EventEmitter();
  const start = Date.now();
  const result = { clicks: 0, paths: [], contents: [], attached: preAttached };
  const rect = { top: 700, left: 50, width: 30, height: 30 };
  const button = { tagName: 'BUTTON', className: 'upload', getBoundingClientRect: () => rect };
  const chip = { getBoundingClientRect: () => rect };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.startsWith('button,')) return hasEntry ? [button] : [];
      if (selector.includes('file-item') && Date.now() - start >= readyAfter) return [chip];
      return [];
    },
  };
  debuggerApi.isAttached = () => result.attached;
  debuggerApi.attach = () => { result.attached = true; };
  debuggerApi.detach = () => { result.attached = false; };
  debuggerApi.sendCommand = async (method, args) => {
    if (method === 'DOM.setFileInputFiles') {
      result.paths.push(args.files[0]);
      result.contents.push(fs.readFileSync(args.files[0], 'utf8'));
    }
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
      result.clicks++;
      debuggerApi.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 1 });
    }
    return {};
  };
  const wc = {
    debugger: debuggerApi,
    executeJavaScript: async (code) => vm.runInNewContext(code, {
      document, window: { innerHeight: 800, innerWidth: 1200 }, console: { log() {} },
    }),
  };
  return { ctx: { view: { webContents: wc } }, debuggerApi, result };
}

const file = { name: 'tool-output.txt', mime: 'text/plain', data: Buffer.from('完整工具结果').toString('base64') };

test('已打开选择器后等待完整上传，不能重复点击或提前删除文件', async () => {
  const { ctx, result, debuggerApi } = browserBoundary({ readyAfter: 9000 });
  let completed = false;
  const pending = cdpAttach(ctx, file).then((r) => { completed = true; return r; });
  await vi.advanceTimersByTimeAsync(8000);
  expect(completed).toBe(false);
  expect(result.clicks).toBe(1);
  expect(result.attached).toBe(true);
  expect(fs.existsSync(result.paths[0])).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ success: true, mode: 'cdp' });
  expect(result.contents).toEqual(['完整工具结果']);
  expect(result.attached).toBe(false);
  expect(fs.existsSync(result.paths[0])).toBe(false);
  expect(debuggerApi.listenerCount('message')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('入口缺失时移除本次选择器监听，不影响已有监听', async () => {
  const { ctx, debuggerApi } = browserBoundary({ hasEntry: false });
  const existing = () => {};
  debuggerApi.on('message', existing);
  expect(await cdpAttach(ctx, file)).toMatchObject({ success: false, error: 'upload-entry-not-found' });
  expect(debuggerApi.listeners('message')).toEqual([existing]);
});

test('debugger 被外部常驻占用（如 net-identity）时复用连接，且不擅自 detach', async () => {
  // 旧逻辑"已 attach 就返回 debugger-busy"会让附件通道在启用代理/指纹的
  // 真实会话中 100% 失效，长文本被迫 insertText 全文注入。
  const { ctx, result, debuggerApi } = browserBoundary({ preAttached: true });
  const r = await cdpAttach(ctx, file);
  expect(r).toMatchObject({ success: true, mode: 'cdp' });
  expect(result.contents).toEqual(['完整工具结果']);
  // 外部占用者的连接必须保持附着，不能被本次调用抢走
  expect(result.attached).toBe(true);
  expect(debuggerApi.listenerCount('message')).toBe(0);
});

test('拒绝带目录的文件名，不能写出临时目录', async () => {
  const { ctx, result } = browserBoundary();
  expect(await cdpAttach(ctx, { ...file, name: 'nested/output.txt' })).toMatchObject({
    success: false, error: 'invalid-file-name',
  });
  expect(result.attached).toBe(false);
  expect(result.paths).toEqual([]);
});
