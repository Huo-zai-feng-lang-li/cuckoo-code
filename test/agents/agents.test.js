'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { mergeAgents, scanAgents } from '../../src/agents/scanner.js';
import { buildAgentsSection } from '../../src/agents/prompt.js';

function mk(name, source) {
  return { name, description: name + ' desc', agentPath: '/x/' + name + '.md', systemPrompt: 'body', source };
}

// ===== mergeAgents =====

test('mergeAgents: 同名项目级优先', () => {
  const p = [mk('a', 'project'), mk('b', 'project')];
  const u = [mk('a', 'user'), mk('c', 'user')];
  const merged = mergeAgents(p, u);
  const a = merged.find((x) => x.name === 'a');
  assert.strictEqual(a.source, 'project');
  assert.strictEqual(merged.length, 3);
});

test('mergeAgents: 空列表', () => {
  assert.deepStrictEqual(mergeAgents([], []), []);
});

test('mergeAgents: 插件级优先级最低（项目 > 用户 > 插件）', () => {
  const p = [mk('a', 'project')];
  const u = [mk('a', 'user'), mk('b', 'user')];
  const pl = [mk('a', 'plugin'), mk('b', 'plugin'), mk('c', 'plugin')];
  const merged = mergeAgents(p, u, pl);
  assert.strictEqual(merged.find((x) => x.name === 'a').source, 'project');
  assert.strictEqual(merged.find((x) => x.name === 'b').source, 'user');
  assert.strictEqual(merged.find((x) => x.name === 'c').source, 'plugin');
  assert.strictEqual(merged.length, 3);
});

// ===== scanAgents 的插件扫描根 =====

test('scanAgents: 额外扫描根被识别且 source=plugin', () => {
  const root = path.join(os.tmpdir(), 'cuckoo-agent-root-test', 'agents');
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'from-plugin.md'),
    '---\nname: from-plugin\ndescription: 来自插件的代理\n---\n你是助手',
    'utf-8'
  );

  const agents = scanAgents(null, [root]);
  const found = agents.find((a) => a.name === 'from-plugin');
  assert.ok(found, '插件目录里的代理应被扫到');
  assert.strictEqual(found.source, 'plugin');

  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

test('scanAgents: 不传额外扫描根时行为不变', () => {
  const agents = scanAgents(null);
  assert.ok(Array.isArray(agents));
  assert.ok(!agents.some((a) => a.source === 'plugin'));
});

// ===== buildAgentsSection =====

test('buildAgentsSection: 无代理返回空串', () => {
  assert.strictEqual(buildAgentsSection([]), '');
});

test('buildAgentsSection: 包含 name 与 description', () => {
  const s = buildAgentsSection([mk('code-reviewer', 'project')]);
  assert.ok(s.includes('## 可用子代理'));
  assert.ok(s.includes('code-reviewer'));
  assert.ok(s.includes('code-reviewer desc'));
  assert.ok(s.includes('runAgent'));
});

test('buildAgentsSection: 多个代理都列出', () => {
  const s = buildAgentsSection([mk('a', 'project'), mk('b', 'user')]);
  assert.ok(s.includes('- a：'));
  assert.ok(s.includes('- b：'));
});

// ===== tools 字段解析（fail-closed）=====

/** 建一个临时 agents 目录并写入指定 md 文件，返回目录路径 */
function makeAgentDir(files) {
  const root = path.join(os.tmpdir(), 'cuckoo-agent-tools-test-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'agents');
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name + '.md'), content, 'utf-8');
  }
  return root;
}

test('tools: 逗号分隔正常解析', () => {
  const root = makeAgentDir({
    ok: '---\nname: ok\ndescription: d\ntools: read, grep, bash\n---\nbody',
  });
  try {
    const a = scanAgents(null, [root]).find((x) => x.name === 'ok' && x.agentPath.startsWith(root));
    assert.ok(a, '应扫到');
    assert.deepStrictEqual(a.tools, ['read', 'grep', 'bash']);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('tools: 缺省（不写该键）时 tools=undefined（全部工具）', () => {
  const root = makeAgentDir({
    noTools: '---\nname: noTools\ndescription: d\n---\nbody',
  });
  try {
    const a = scanAgents(null, [root]).find((x) => x.name === 'noTools' && x.agentPath.startsWith(root));
    assert.ok(a, '应扫到');
    assert.strictEqual(a.tools, undefined);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('tools: YAML 数组式（无法解析）→ 跳过该代理，fail-closed', () => {
  const root = makeAgentDir({
    arr: '---\nname: arr\ndescription: d\ntools:\n  - read\n  - grep\n---\nbody',
    normal: '---\nname: normal\ndescription: d\ntools: read\n---\nbody',
  });
  try {
    const list = scanAgents(null, [root]).filter((x) => x.agentPath.startsWith(root));
    assert.strictEqual(list.find((x) => x.name === 'arr'), undefined, '数组式 tools 应被跳过，不能变成全权限');
    assert.ok(list.find((x) => x.name === 'normal'), '正常代理不受影响');
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('tools: 内联数组 [a, b]（无法解析）→ 跳过该代理', () => {
  const root = makeAgentDir({
    inline: '---\nname: inline\ndescription: d\ntools: [read, grep]\n---\nbody',
  });
  try {
    const list = scanAgents(null, [root]).filter((x) => x.agentPath.startsWith(root));
    assert.strictEqual(list.find((x) => x.name === 'inline'), undefined);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('tools: 键存在但值为空 → 跳过该代理（不能变成全权限）', () => {
  const root = makeAgentDir({
    empty: '---\nname: empty\ndescription: d\ntools:\n---\nbody',
  });
  try {
    const list = scanAgents(null, [root]).filter((x) => x.agentPath.startsWith(root));
    assert.strictEqual(list.find((x) => x.name === 'empty'), undefined);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('tools: YAML null/~ 占位值 → 跳过该代理（不当成工具名）', () => {
  const root = makeAgentDir({
    n: '---\nname: n\ndescription: d\ntools: null\n---\nbody',
    t: '---\nname: t\ndescription: d\ntools: ~\n---\nbody',
  });
  try {
    const list = scanAgents(null, [root]).filter((x) => x.agentPath.startsWith(root));
    assert.strictEqual(list.find((x) => x.name === 'n'), undefined);
    assert.strictEqual(list.find((x) => x.name === 't'), undefined);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('tools: 单工具 / 带空格逗号式 正常解析', () => {
  const root = makeAgentDir({
    one: '---\nname: one\ndescription: d\ntools: read\n---\nbody',
    sp: '---\nname: sp\ndescription: d\ntools: " read ,  grep "\n---\nbody',
  });
  try {
    const list = scanAgents(null, [root]).filter((x) => x.agentPath.startsWith(root));
    assert.deepStrictEqual(list.find((x) => x.name === 'one').tools, ['read']);
    assert.deepStrictEqual(list.find((x) => x.name === 'sp').tools, ['read', 'grep']);
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});
