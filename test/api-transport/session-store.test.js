'use strict';
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadApiSession,
  loadApiSessionSnapshot,
  saveApiSession,
  clearApiSession,
  createApiSession,
  setActiveApiSession,
  deleteApiSession,
  listApiSessions,
  getActiveApiSessionId,
  getApiSessionProjectDir,
  setApiSessionProjectDir,
  deriveSessionTitle,
} from '../../src/api-transport/session-store.js';

let home = '';

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-api-session-'));
  process.env.CUCKOO_HOME = home;
});

afterAll(() => {
  delete process.env.CUCKOO_HOME;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

function profileDir(id) {
  return path.join(home, 'api-sessions', id);
}

test('保存后能恢复；system 消息始终保留', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ];
  saveApiSession('p1', messages);
  assert.deepEqual(loadApiSession('p1'), messages);
  assert.equal(loadApiSession('other').length, 0);
});

test('只保留最近 300 条，system 不丢', () => {
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 320; i++) messages.push({ role: 'user', content: 'm' + i });
  saveApiSession('p2', messages);
  const loaded = loadApiSession('p2');
  assert.equal(loaded[0].role, 'system');
  assert.equal(loaded.length, 300);
  assert.equal(loaded.at(-1).content, 'm319');
});

test('坏 JSON 回退空历史，不抛出', () => {
  const dir = path.join(home, 'api-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
  assert.deepEqual(loadApiSession('bad'), []);
});

test('读取时修复半截工具轮：缺 tool 结果补 interrupted，孤儿 tool 丢弃', () => {
  const dir = path.join(home, 'api-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'tool', tool_call_id: 'orphan', content: 'orphan' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'assistant', content: 'final' },
    ],
  }));
  const loaded = loadApiSession('broken');
  assert.equal(loaded.some((m) => m.role === 'tool' && m.tool_call_id === 'orphan'), false);
  const tool = loaded.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(tool, '缺失的 tool 结果应补齐');
  assert.equal(tool.content, 'ERROR: interrupted');
  assert.equal(loaded.at(-1).content, 'final');
});

test('clear 删除当前 profile 的整个会话目录', () => {
  saveApiSession('p3', [{ role: 'user', content: 'x' }]);
  clearApiSession('p3');
  assert.equal(fs.existsSync(profileDir('p3')), false);
  assert.deepEqual(loadApiSession('p3'), []);
});

test('危险 profileId 会被规整到安全目录，不逃出 api-sessions', () => {
  saveApiSession('../evil', [{ role: 'user', content: 'x' }]);
  const files = fs.readdirSync(path.join(home, 'api-sessions'));
  const safe = files.find((f) => f.includes('evil'));
  assert.ok(safe, '应落到规整后的安全目录');
  assert.equal(safe.includes('/'), false, '规整后不能含路径分隔符');
  assert.equal(safe.includes('\\'), false, '规整后不能含路径分隔符');
  assert.equal(fs.existsSync(path.join(home, 'evil')), false, '不能逃出 api-sessions');
  assert.equal(fs.existsSync(path.join(home, 'api-sessions', 'evil.json')), false, '不应再产生旧式扁平文件');
  assert.equal(fs.existsSync(path.join(home, 'api-sessions', safe, 'index.json')), true);
});

test('多会话：新建/切换/删除，各自快照互不覆盖', () => {
  const sidA = saveApiSession('multi', [{ role: 'user', content: 'A-A' }]);
  const sidB = createApiSession('multi');
  saveApiSession('multi', [{ role: 'user', content: 'B-B' }], { sessionId: sidB });
  assert.equal(getActiveApiSessionId('multi'), sidB);
  const list = listApiSessions('multi');
  assert.equal(list.activeSessionId, sidB);
  assert.equal(list.sessions.length, 2);
  assert.deepEqual(loadApiSession('multi', sidA), [{ role: 'user', content: 'A-A' }]);
  assert.deepEqual(loadApiSession('multi', sidB), [{ role: 'user', content: 'B-B' }]);

  assert.equal(setActiveApiSession('multi', sidA), true);
  assert.equal(getActiveApiSessionId('multi'), sidA);
  // 切回 A 再存，不应改到 B
  saveApiSession('multi', [{ role: 'user', content: 'A-2' }], { sessionId: sidA });
  assert.deepEqual(loadApiSession('multi', sidB), [{ role: 'user', content: 'B-B' }]);

  // 删除 active → 自动切到剩余最近一份
  const active = deleteApiSession('multi', sidA);
  assert.equal(active, sidB);
  assert.equal(getActiveApiSessionId('multi'), sidB);
  assert.deepEqual(loadApiSession('multi', sidA), []);
  assert.equal(listApiSessions('multi').sessions.length, 1);
});

test('工具模式随会话快照保存，新建时可指定 cuckoo-js', () => {
  const sid = createApiSession('mode', { toolMode: 'cuckoo-js' });
  saveApiSession('mode', [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ], { sessionId: sid, toolMode: 'cuckoo-js' });
  const snap = loadApiSessionSnapshot('mode', sid);
  assert.equal(snap.toolMode, 'cuckoo-js');
  assert.equal(listApiSessions('mode').sessions.find((s) => s.id === sid).toolMode, 'cuckoo-js');
});

test('持久化裁剪不把 internal user 当成可见轮次边界', () => {
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 300; i++) {
    if (i === 0) messages.push({ role: 'assistant', content: 'a0' });
    else if (i === 1) messages.push({ role: 'user', content: 'tool-result', internal: true });
    else if (i === 2) messages.push({ role: 'user', content: 'visible-2' });
    else messages.push(i % 2 ? { role: 'assistant', content: 'a' + i } : { role: 'user', content: 'u' + i });
  }
  const sid = saveApiSession('trim-internal', messages, { toolMode: 'cuckoo-js' });
  const loaded = loadApiSession('trim-internal', sid);
  assert.equal(loaded[0].role, 'system');
  assert.equal(loaded[1].role, 'user');
  assert.equal(loaded[1].internal, undefined);
  assert.equal(loaded[1].content, 'visible-2');
});

test('旧快照没有 toolMode 时按 native 处理，不能把旧历史误当 cuckoo-js', () => {
  const dir = path.join(home, 'api-sessions', 'legacy-mode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    version: 2,
    activeSessionId: 'old',
    sessions: [{ id: 'old', title: '旧会话', createdAt: 1, updatedAt: 1, messageCount: 2 }],
  }));
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
    id: 'old', title: '旧会话', createdAt: 1, updatedAt: 1,
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }],
  }));
  const snap = loadApiSessionSnapshot('legacy-mode', 'old');
  assert.equal(snap.toolMode, 'native');
});

test('旧版单文件自动迁移为 legacy 会话，旧文件保留不丢历史', () => {
  const dir = path.join(home, 'api-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'migrate.json'), JSON.stringify({
    title: '',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '迁移这句话' },
      { role: 'assistant', content: '迁移回答' },
    ],
  }));
  const list = listApiSessions('migrate');
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].id, 'legacy');
  assert.equal(list.sessions[0].title, '迁移这句话');
  assert.equal(fs.existsSync(path.join(dir, 'migrate.json')), true, '旧文件保留作为迁移来源');
  assert.deepEqual(loadApiSession('migrate').map((m) => m.content), ['sys', '迁移这句话', '迁移回答']);
});

test('标题优先取界面展示文本（displayText），且快照保留 displayText', () => {
  const messages = [{
    role: 'user',
    content: '<skill>hidden instructions</skill>\n真正的用户问题',
    displayText: '真正的用户问题',
  }];
  assert.equal(deriveSessionTitle(messages), '真正的用户问题');
  saveApiSession('title', messages);
  const snap = loadApiSession('title');
  assert.equal(snap[0].displayText, '真正的用户问题');
  const list = listApiSessions('title');
  assert.equal(list.sessions[0].title, '真正的用户问题');
});

test('删除最后一个会话后仍保留一个空会话，activeSessionId 永远有效', () => {
  const sid = createApiSession('last');
  const active = deleteApiSession('last', sid);
  assert.ok(active, '不能返回空 active');
  const list = listApiSessions('last');
  assert.equal(list.sessions.length, 1);
  assert.equal(list.activeSessionId, active);
  assert.deepEqual(loadApiSession('last'), []);
});

test('新 profile 只生成一个空会话，不会多造默认会话', () => {
  const list = listApiSessions('fresh-profile');
  assert.equal(list.sessions.length, 1);
  assert.ok(list.activeSessionId);
});

test('索引丢失但快照还在时，按目录文件重建会话列表', () => {
  const dir = profileDir('recover');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, title, mtime] of [['a', '会话 A', 1000], ['b', '会话 B', 2000]]) {
    const full = path.join(dir, id + '.json');
    fs.writeFileSync(full, JSON.stringify({
      version: 2,
      id,
      title,
      createdAt: 1,
      updatedAt: mtime,
      messages: [{ role: 'user', content: title }],
      usageTotal: {},
    }));
    fs.utimesSync(full, new Date(mtime), new Date(mtime));
  }
  const list = listApiSessions('recover');
  assert.equal(list.sessions.length, 2);
  assert.equal(list.activeSessionId, 'b', 'active 应取最近更新的一份');
  assert.equal(list.sessions[0].title, '会话 B');
  assert.equal(fs.existsSync(path.join(dir, 'index.json')), true, '重建后应写回索引');
  assert.deepEqual(loadApiSession('recover', 'a'), [{ role: 'user', content: '会话 A' }]);
});

test('createApiSession 在索引丢失时也不会丢掉目录里的旧快照', () => {
  const dir = profileDir('recover-new');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
    version: 2, id: 'old', title: '旧会话', createdAt: 1, updatedAt: 1,
    messages: [{ role: 'user', content: '旧' }], usageTotal: {},
  }));
  const id = createApiSession('recover-new');
  const list = listApiSessions('recover-new');
  assert.equal(list.sessions.length, 2);
  assert.ok(list.sessions.some((s) => s.id === 'old'));
  assert.equal(list.activeSessionId, id);
});

test('API 会话记住项目目录：新建、读取、列表、更新都保留', () => {
  const profile = 'project-dir-profile';
  const sid = createApiSession(profile, { projectDir: 'D:\\work-a' });
  assert.equal(getApiSessionProjectDir(profile, sid), 'D:\\work-a');
  assert.equal(loadApiSessionSnapshot(profile, sid).projectDir, 'D:\\work-a');
  assert.equal(
    listApiSessions(profile).sessions.find((s) => s.id === sid).projectDir,
    'D:\\work-a',
  );

  assert.equal(setApiSessionProjectDir(profile, sid, 'D:\\work-b'), true);
  assert.equal(getApiSessionProjectDir(profile, sid), 'D:\\work-b');
  assert.equal(loadApiSessionSnapshot(profile, sid).projectDir, 'D:\\work-b');
});

test('保存消息未显式传 projectDir 时保留已有项目目录', () => {
  const profile = 'project-dir-preserve';
  const sid = createApiSession(profile, { projectDir: '/work/a' });
  saveApiSession(profile, [{ role: 'user', content: 'hello' }], { sessionId: sid });
  assert.equal(getApiSessionProjectDir(profile, sid), '/work/a');
  assert.deepEqual(loadApiSession(profile, sid), [{ role: 'user', content: 'hello' }]);
});

test('旧索引没有 projectDir 时按 null 处理，不抛错', () => {
  const profile = 'project-dir-legacy';
  const dir = profileDir(profile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    version: 2,
    activeSessionId: 'old',
    sessions: [{ id: 'old', title: '旧', createdAt: 1, updatedAt: 1, messageCount: 0 }],
  }));
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
    version: 2, id: 'old', title: '旧', createdAt: 1, updatedAt: 1,
    messages: [], usageTotal: {},
  }));
  assert.equal(getApiSessionProjectDir(profile), null);
  assert.equal(listApiSessions(profile).sessions[0].projectDir, null);
});
