'use strict';
/**
 * E-001 回归：MCP 面板 server 名（项目 .agents/mcp.json 可写）进 innerHTML 必须转义，
 * 不得出现原始 <img onerror>。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

let toasts = [];
vi.mock('../../../src/overlay/panel.js', () => ({
  showToast: (m) => { toasts.push(m); },
  showConfirmDialog: async () => false,
}));

let listEl;

beforeEach(async () => {
  vi.resetModules();
  toasts = [];
  listEl = { innerHTML: '', querySelectorAll: () => [] };
  globalThis.window = {
    electronAPI: {
      listMcpServers: async () => ({ success: true, servers: [] }),
    },
  };
  globalThis.document = {
    getElementById: (id) => (id === 'cuckoo-mcp-list' ? listEl : null),
  };
});

test('项目级 server 名注入被转义，不出现原始 onerror 载荷', async () => {
  const evil = 'x"><img src=x onerror="alert(1)"><span data="';
  globalThis.window.electronAPI.listMcpServers = async () => ({
    success: true,
    servers: [{ name: evil, source: 'project', connected: false, enabled: true }],
  });
  const mgr = await import('../../../src/overlay/panels/mcp-manager.js');
  await mgr.renderMcpList();

  assert.ok(!listEl.innerHTML.includes('<img src=x onerror'), 'innerHTML 不得含原始注入载荷');
  assert.ok(listEl.innerHTML.includes('&lt;img'), '应含转义后的标签文本');
  // 属性位 data-mcp-name 也不得裸露未转义引号载荷
  assert.ok(!/onerror\s*=\s*"alert/.test(listEl.innerHTML), '属性位不得裸露 onerror 赋值');
});

test('普通 server 名正常渲染', async () => {
  globalThis.window.electronAPI.listMcpServers = async () => ({
    success: true,
    servers: [{ name: 'fs-server', source: 'user', connected: true }],
  });
  const mgr = await import('../../../src/overlay/panels/mcp-manager.js');
  await mgr.renderMcpList();
  assert.ok(listEl.innerHTML.includes('fs-server'), '普通名应原样显示');
});
