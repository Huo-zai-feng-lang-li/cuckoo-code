'use strict';
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CUCKOO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-trust-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-proj-'));
process.env.CUCKOO_HOME = CUCKOO_HOME;

const wt = await import('../../src/infra/workspace-trust.js');

beforeAll(() => {
  wt.clearSessionTrustForTests();
  // 构造 .agents 工件
  fs.mkdirSync(path.join(PROJECT, '.agents', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT, '.agents', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.agents', 'mcp.json'), JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      'remote-db': { url: 'https://mcp.example.com/db' },
    },
  }), 'utf-8');
  fs.writeFileSync(path.join(PROJECT, '.agents', 'rules', 'backend.md'), '# backend rule', 'utf-8');
  fs.writeFileSync(path.join(PROJECT, '.agents', 'skills', 'my-skill', 'SKILL.md'), '# skill', 'utf-8');
});

afterAll(() => {
  wt.clearSessionTrustForTests();
  fs.rmSync(CUCKOO_HOME, { recursive: true, force: true });
  fs.rmSync(PROJECT, { recursive: true, force: true });
});

test('初始：未信任', () => {
  expect(wt.isWorkspaceTrusted(PROJECT)).toBe(false);
});

test('setWorkspaceTrust(session)：会话级信任，不持久化', () => {
  wt.clearSessionTrustForTests();
  wt.setWorkspaceTrust(PROJECT, 'session');
  expect(wt.isWorkspaceTrusted(PROJECT)).toBe(true);
  expect(wt.isWorkspaceTrustedPersistently(PROJECT)).toBe(false);
});

test('setWorkspaceTrust(trusted)：持久化，list 可见', () => {
  wt.clearSessionTrustForTests();
  wt.setWorkspaceTrust(PROJECT, 'trusted');
  expect(wt.isWorkspaceTrusted(PROJECT)).toBe(true);
  expect(wt.isWorkspaceTrustedPersistently(PROJECT)).toBe(true);
  const list = wt.listTrustedWorkspaces();
  expect(list.length).toBe(1);
  expect(list[0].path).toBe(path.resolve(PROJECT));
});

test('revokeWorkspaceTrust：撤销后不再信任', () => {
  wt.revokeWorkspaceTrust(PROJECT);
  expect(wt.isWorkspaceTrusted(PROJECT)).toBe(false);
  expect(wt.listTrustedWorkspaces().length).toBe(0);
});

test('untrusted scope 等价于撤销', () => {
  wt.setWorkspaceTrust(PROJECT, 'trusted');
  expect(wt.isWorkspaceTrusted(PROJECT)).toBe(true);
  wt.setWorkspaceTrust(PROJECT, 'untrusted');
  expect(wt.isWorkspaceTrusted(PROJECT)).toBe(false);
});

test('win32：路径大小写不敏感归一（其他平台跳过该断言）', () => {
  wt.clearSessionTrustForTests();
  wt.setWorkspaceTrust(PROJECT, 'trusted');
  if (process.platform === 'win32') {
    // Windows 上 normalizeProjectPath 会小写化，等价路径视为同一工作区
    expect(wt.isWorkspaceTrusted(PROJECT.toUpperCase())).toBe(true);
  }
  wt.revokeWorkspaceTrust(PROJECT);
});

test('scanWorkspaceArtifacts：识别 mcp/rules/skills', () => {
  const art = wt.scanWorkspaceArtifacts(PROJECT);
  expect(art.dir).toBe(PROJECT);
  expect(art.mcp).toHaveLength(2);
  expect(art.mcp[0].name).toBe('filesystem');
  expect(art.mcp[0].command).toBe('npx');
  expect(art.mcp[1].url).toBe('https://mcp.example.com/db');
  expect(art.rules).toContain('backend');
  expect(art.skills).toContain('my-skill');
});

test('scanWorkspaceArtifacts：无 .agents 的目录返回空工件', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-empty-'));
  const art = wt.scanWorkspaceArtifacts(emptyDir);
  expect(art.mcp).toEqual([]);
  expect(art.rules).toEqual([]);
  expect(art.skills).toEqual([]);
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test('null/undefined dir 不崩', () => {
  expect(wt.isWorkspaceTrusted(null)).toBe(false);
  expect(wt.isWorkspaceTrustedPersistently(undefined)).toBe(false);
  expect(wt.scanWorkspaceArtifacts(null).mcp).toEqual([]);
});
