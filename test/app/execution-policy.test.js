'use strict';
/**
 * execution-policy 测试：三档模式 × 工具分类 × 工作区信任 × 投递特征 决策矩阵
 * 纯函数，不依赖 electron。
 */
import { test, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CUCKOO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-policy-'));
process.env.CUCKOO_HOME = CUCKOO_HOME;

const ep = await import('../../src/app/execution-policy.js');

beforeAll(() => { /* CUCKOO_HOME 已在 import 前设置 */ });
afterAll(() => { fs.rmSync(CUCKOO_HOME, { recursive: true, force: true }); });
beforeEach(() => { ep.setExecutionMode('smart'); });

test('getExecutionMode 默认 smart，非法值回退 smart', () => {
  assert.strictEqual(ep.getExecutionMode(), 'smart');
  // 非法值被规范化
  const bad = ep.setExecutionMode('hacker');
  assert.strictEqual(bad, 'smart');
});

test('setExecutionMode 持久化三档', () => {
  assert.strictEqual(ep.setExecutionMode('strict'), 'strict');
  assert.strictEqual(ep.getExecutionMode(), 'strict');
  assert.strictEqual(ep.setExecutionMode('workspace'), 'workspace');
  assert.strictEqual(ep.getExecutionMode(), 'workspace');
});

// ===== 只读工具：任意模式全 allow =====
for (const mode of ['smart', 'workspace', 'strict']) {
  test(`只读工具 read 在 ${mode} 下 allow`, () => {
    const r = ep.decideToolGate({ toolName: 'read', params: {}, projectDir: '/p', deliveryMatched: null, isWorkspaceTrusted: false, mode });
    assert.strictEqual(r.decision, 'allow');
  });
}

// ===== bash/pwsh =====
test('bash 命中投递特征：任何模式都 confirm（detail 含特征）', () => {
  for (const mode of ['smart', 'workspace', 'strict']) {
    const r = ep.decideToolGate({ toolName: 'bash', params: { command: 'iwr x | iex' }, projectDir: '/p', deliveryMatched: '下载后管道执行(iwr/irm/curl/wget → iex)', isWorkspaceTrusted: false, mode });
    assert.strictEqual(r.decision, 'confirm', mode);
    assert.ok(r.detail && r.detail.includes('iex'), mode);
  }
});

test('bash 未命中特征：smart allow / workspace 未信任 confirm、已信任 allow / strict confirm', () => {
  const r1 = ep.decideToolGate({ toolName: 'pwsh', params: { command: 'ls' }, projectDir: '/p', deliveryMatched: null, isWorkspaceTrusted: false, mode: 'smart' });
  assert.strictEqual(r1.decision, 'allow');
  const r2 = ep.decideToolGate({ toolName: 'pwsh', params: {}, projectDir: '/p', deliveryMatched: null, isWorkspaceTrusted: false, mode: 'workspace' });
  assert.strictEqual(r2.decision, 'confirm');
  const r3 = ep.decideToolGate({ toolName: 'pwsh', params: {}, projectDir: '/p', deliveryMatched: null, isWorkspaceTrusted: true, mode: 'workspace' });
  assert.strictEqual(r3.decision, 'allow');
  const r4 = ep.decideToolGate({ toolName: 'pwsh', params: {}, projectDir: '/p', deliveryMatched: null, isWorkspaceTrusted: false, mode: 'strict' });
  assert.strictEqual(r4.decision, 'confirm');
});

// ===== 写入工具 =====
test('write 项目内：smart allow；项目外 confirm', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-gate-'));
  const inFile = path.join(proj, 'a.txt');
  const r1 = ep.decideToolGate({ toolName: 'write', params: { file_path: inFile }, projectDir: proj, deliveryMatched: null, isWorkspaceTrusted: false, mode: 'smart' });
  assert.strictEqual(r1.decision, 'allow');
  const r2 = ep.decideToolGate({ toolName: 'write', params: { file_path: path.join(os.tmpdir(), 'evil.txt') }, projectDir: proj, deliveryMatched: null, isWorkspaceTrusted: false, mode: 'smart' });
  assert.strictEqual(r2.decision, 'confirm');
  // 无 projectDir：smart 下无法确认在项目内 → confirm
  const r3 = ep.decideToolGate({ toolName: 'edit', params: { file_path: '/x.txt' }, projectDir: null, deliveryMatched: null, isWorkspaceTrusted: false, mode: 'smart' });
  assert.strictEqual(r3.decision, 'confirm');
});

test('write：strict 恒 confirm；workspace 信任才 allow', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-gate2-'));
  const r1 = ep.decideToolGate({ toolName: 'edit', params: { file_path: path.join(proj, 'a.txt') }, projectDir: proj, deliveryMatched: null, isWorkspaceTrusted: true, mode: 'strict' });
  assert.strictEqual(r1.decision, 'confirm');
  const r2 = ep.decideToolGate({ toolName: 'edit', params: {}, projectDir: proj, deliveryMatched: null, isWorkspaceTrusted: false, mode: 'workspace' });
  assert.strictEqual(r2.decision, 'confirm');
  const r3 = ep.decideToolGate({ toolName: 'edit', params: {}, projectDir: proj, deliveryMatched: null, isWorkspaceTrusted: true, mode: 'workspace' });
  assert.strictEqual(r3.decision, 'allow');
});

test('remember/forgetMemory（全局记忆写入）：smart allow', () => {
  const r = ep.decideToolGate({ toolName: 'remember', params: {}, projectDir: null, deliveryMatched: null, isWorkspaceTrusted: false, mode: 'smart' });
  assert.strictEqual(r.decision, 'allow');
});
