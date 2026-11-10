import { test } from 'vitest';
import assert from 'node:assert';

test('randomDelay 返回默认发送延迟区间（4-30 秒，需求 114）', async () => {
  const { randomDelay } = await import('../../src/overlay/chat-input.js');
  const { state } = await import('../../src/overlay/state.js');
  // 需求 114：旧默认 12/36 对短消息太重（20 字也要等 12 秒），
  // 且超长工具回传总贴死上限。改为 4/30 并配合 sqrt 分布压缩。
  assert.strictEqual(state.sendDelayMin, 4000, '默认下限应为 4s');
  assert.strictEqual(state.sendDelayMax, 30000, '默认上限应为 30s');
  for (let i = 0; i < 30; i++) {
    const d = randomDelay();
    assert.ok(d >= 4000 && d <= 30000, '实际返回 ' + d + ' 超出 4000-30000');
  }
});

test('updateProjectDirDisplay 更新显示', async () => {
  const span = { textContent: '' };
  const section = { style: {} };
  global.document = {
    getElementById: (id) => id === 'cuckoo-project-dir-display' ? { querySelector: () => span } : null,
    querySelector: (sel) => sel === '.cuckoo-project-dir-section' ? section : null,
  };
  const { updateProjectDirDisplay } = await import('../../src/overlay/project-dir.js');
  updateProjectDirDisplay('C:\\proj');
  assert.strictEqual(span.textContent, 'C:\\proj');
  assert.strictEqual(section.style.display, '');
  updateProjectDirDisplay(null);
  assert.strictEqual(span.textContent, '未选择');
  assert.strictEqual(section.style.display, 'none');
});

test('renderSessions API 不可用显示提示', async () => {
  const el = { innerHTML: '' };
  global.document = { getElementById: () => el };
  global.window = {};
  const { renderSessions } = await import('../../src/overlay/session-list.js');
  await renderSessions();
  assert.match(el.innerHTML, /API 不可用/);
});

test('renderSessions 无会话显示暂无', async () => {
  const el = { innerHTML: '', querySelectorAll: () => [] };
  global.document = { getElementById: () => el };
  global.window = { electronAPI: { listSessions: async () => ({ success: true, sessions: [] }) } };
  const { renderSessions } = await import('../../src/overlay/session-list.js');
  await renderSessions();
  assert.match(el.innerHTML, /暂无会话/);
});

test('renderSessions 有会话渲染并绑定', async () => {
  const el = { innerHTML: '', querySelectorAll: () => [] };
  const mkEl = () => {
    let text = '';
    return {
      set textContent(v) { text = String(v); },
      get textContent() { return text; },
      get innerHTML() { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
      set innerHTML(v) {},
      style: {},
    };
  };
  global.document = { getElementById: () => el, createElement: () => mkEl() };
  global.window = { electronAPI: { listSessions: async () => ({ success: true, sessions: ['abc'] }) } };
  const { renderSessions } = await import('../../src/overlay/session-list.js');
  await renderSessions();
  assert.match(el.innerHTML, /abc/);
});
