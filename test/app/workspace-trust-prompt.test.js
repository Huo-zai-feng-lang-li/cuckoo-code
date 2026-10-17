'use strict';
/**
 * workspace-trust-prompt 测试：无制品 / 已信任 / 未信任三态
 * dialog 用注入替身，不弹真窗。
 */
import { test, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CUCKOO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-trust-'));
process.env.CUCKOO_HOME = CUCKOO_HOME;

const prompt = await import('../../src/app/workspace-trust-prompt.js');
const trust = await import('../../src/infra/workspace-trust.js');

let dialogCalls = 0;
function setDialogResponse(idx) {
  prompt.__setTrustPromptDialog({
    showMessageBox: async () => { dialogCalls++; return { response: idx }; },
  });
}
function resetDialog() { dialogCalls = 0; prompt.__setTrustPromptDialog({ showMessageBox: async () => { dialogCalls++; return { response: 2 }; } }); }

beforeEach(() => { resetDialog(); });
afterAll(() => { fs.rmSync(CUCKOO_HOME, { recursive: true, force: true }); });

test('无 .agents 制品目录：不弹 dialog，直接 trusted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-ws-clean-'));
  const r = await prompt.ensureWorkspaceTrust(null, dir);
  assert.strictEqual(r.trusted, true);
  assert.strictEqual(dialogCalls, 0);
});

test('null 目录：直接 trusted（无窗口/无项目）', async () => {
  const r = await prompt.ensureWorkspaceTrust(null, null);
  assert.strictEqual(r.trusted, true);
  assert.strictEqual(dialogCalls, 0);
});

test('含 MCP 制品未信任：弹三按钮；选"不信任" → trusted=false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-ws-mcp-'));
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: { foo: { command: 'node', args: ['a.js'] } } }), 'utf-8');
  setDialogResponse(2); // 默认聚焦不信任
  const r = await prompt.ensureWorkspaceTrust(null, dir);
  assert.strictEqual(dialogCalls, 1);
  assert.strictEqual(r.trusted, false);
  assert.strictEqual(trust.isWorkspaceTrusted(dir), false);
});

test('含制品未信任：选"信任并启用" → trusted=true 且持久化；再次调用不弹', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-ws-trust-'));
  fs.mkdirSync(path.join(dir, '.agents', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'rules', 'commit.md'), '# rules\nx', 'utf-8');
  setDialogResponse(0);
  const r1 = await prompt.ensureWorkspaceTrust(null, dir);
  assert.strictEqual(r1.trusted, true);
  assert.strictEqual(trust.isWorkspaceTrusted(dir), true);
  // 已信任：再次调用不弹窗
  const r2 = await prompt.ensureWorkspaceTrust(null, dir);
  assert.strictEqual(dialogCalls, 1); // 仍是上次那次
  assert.strictEqual(r2.trusted, true);
});

test('buildTrustDetail 列出 MCP server 与规则/技能数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-ws-detail-'));
  fs.mkdirSync(path.join(dir, '.agents', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: { foo: { command: 'node' } } }), 'utf-8');
  fs.writeFileSync(path.join(dir, '.agents', 'rules', 'commit.md'), '# r\nx', 'utf-8');
  const detail = prompt.buildTrustDetail(dir);
  assert.ok(detail.includes('foo'));
  assert.ok(detail.includes('MCP'));
});
