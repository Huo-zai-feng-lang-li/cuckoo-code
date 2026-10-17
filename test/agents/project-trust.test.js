'use strict';
/**
 * D-004 回归：项目级子代理（agents）纳入工作区信任门。
 *
 * 未信任项目：scanAgents 不返回项目级 agent（其 description 不进 prompt、
 * runAgent 不实例化）；用户级/插件级不受影响。信任后项目 agent 出现。
 * 另测 scanWorkspaceArtifacts：只有 .cuckoo/agents（无 .agents）也要能检出，
 * 修复此前"无 .agents 即提前 return"导致恶意仓库绕过信任门的问题。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'cuckoo-agents-trust-test');
const FAKE_HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'proj');

let agents;
let trust;
let artifacts;
let oldHome;

function writeProjAgent(name, body) {
  const dir = path.join(PROJ, '.cuckoo', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name + '.md'),
    '---\nname: ' + name + '\ndescription: proj ' + name + '\ntools: bash\n---\n' + body + '\n'
  );
}

beforeEach(async () => {
  vi.resetModules();
  oldHome = process.env.CUCKOO_HOME;
  process.env.CUCKOO_HOME = FAKE_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  agents = await import('../../src/agents/scanner.js');
  trust = await import('../../src/infra/workspace-trust.js');
  artifacts = await import('../../src/infra/workspace-trust.js');
  trust.clearSessionTrustForTests();
});

afterEach(() => {
  trust.clearSessionTrustForTests();
  if (oldHome === undefined) delete process.env.CUCKOO_HOME;
  else process.env.CUCKOO_HOME = oldHome;
});

test('未信任：scanAgents 不含项目级 agent', () => {
  writeProjAgent('evil-sub', '你是黑客');
  const list = agents.scanAgents(PROJ);
  assert.deepStrictEqual(list.filter((a) => a.source === 'project'), []);
});

test('信任后：项目级 agent 出现', () => {
  writeProjAgent('good-sub', '你是助手');
  trust.setWorkspaceTrust(PROJ, 'trusted');
  const list = agents.scanAgents(PROJ);
  assert.ok(list.some((a) => a.source === 'project' && a.name === 'good-sub'));
});

test('插件级 extraAgentDirs 不受信任门影响', () => {
  const plugDir = path.join(TMP, 'plug-agents');
  fs.mkdirSync(plugDir, { recursive: true });
  fs.writeFileSync(
    path.join(plugDir, 'plug.md'),
    '---\nname: plug-sub\ndescription: plug\n---\nbody\n'
  );
  // 项目未信任，插件根仍应被扫到
  const list = agents.scanAgents(PROJ, [plugDir]);
  assert.ok(list.some((a) => a.source === 'plugin' && a.name === 'plug-sub'));
});

test('scanWorkspaceArtifacts：只有 .cuckoo/agents（无 .agents）也检出 agents', () => {
  writeProjAgent('ghost', 'hidden');
  const art = artifacts.scanWorkspaceArtifacts(PROJ);
  assert.deepStrictEqual(art.agents, ['ghost'], '无 .agents 目录时也应检出 .cuckoo/agents');
});

test('scanWorkspaceArtifacts：.agents/skills 与 .cuckoo/agents 同时存在都检出', () => {
  writeProjAgent('both', 'x');
  fs.mkdirSync(path.join(PROJ, '.agents', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, '.agents', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nbody', 'utf-8');
  const art = artifacts.scanWorkspaceArtifacts(PROJ);
  assert.ok(art.agents.includes('both'));
  assert.ok(art.skills.includes('demo'));
});

test('scanWorkspaceArtifacts：空项目全空', () => {
  const art = artifacts.scanWorkspaceArtifacts(PROJ);
  assert.deepStrictEqual(art.agents, []);
  assert.deepStrictEqual(art.rules, []);
  assert.deepStrictEqual(art.skills, []);
});
