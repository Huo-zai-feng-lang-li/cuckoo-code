'use strict';
/**
 * E-003 回归：窗口管理器 profile 显示名（用户手输 / 网页抓取昵称）进 innerHTML 必须转义。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

let toasts = [];
vi.mock('../../../src/overlay/panel.js', () => ({
  showToast: (m) => { toasts.push(m); },
}));

let listEl;

beforeEach(async () => {
  vi.resetModules();
  toasts = [];
  listEl = { innerHTML: '', querySelectorAll: () => [] };
  globalThis.window = {
    electronAPI: {
      listProfiles: async () => ({ success: true, profiles: [] }),
      listProviders: async () => ({ success: true, providers: [] }),
    },
  };
  globalThis.document = {
    getElementById: (id) => (id === 'cuckoo-window-list' ? listEl : null),
  };
});

test('profile 名注入被转义，不出现原始 onerror 载荷', async () => {
  const evil = '<img src=x onerror="alert(1)">';
  globalThis.window.electronAPI.listProfiles = async () => ({
    success: true,
    profiles: [{ id: 'p1', name: evil, providerId: 'ds', autoOpen: false }],
  });
  globalThis.window.electronAPI.listProviders = async () => ({
    success: true,
    providers: [{ id: 'ds', name: 'DeepSeek' }],
  });
  const wm = await import('../../../src/overlay/panels/window-manager.js');
  await wm.renderWindowList();

  assert.ok(!listEl.innerHTML.includes('<img src=x onerror'), 'innerHTML 不得含原始注入载荷');
  assert.ok(listEl.innerHTML.includes('&lt;img'), '应含转义后的标签文本');
});

test('普通 profile 名正常渲染', async () => {
  globalThis.window.electronAPI.listProfiles = async () => ({
    success: true,
    profiles: [{ id: 'p2', name: '我的窗口', providerId: 'ds', autoOpen: true }],
  });
  globalThis.window.electronAPI.listProviders = async () => ({
    success: true,
    providers: [{ id: 'ds', name: 'DeepSeek' }],
  });
  const wm = await import('../../../src/overlay/panels/window-manager.js');
  await wm.renderWindowList();
  assert.ok(listEl.innerHTML.includes('我的窗口'), '普通名应原样显示');
});
