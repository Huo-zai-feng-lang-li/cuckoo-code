'use strict';
/**
 * compaction 纯函数测试：pickRecentPairedIds（消息链回溯 + 成对裁剪）
 * 这些逻辑不依赖 Electron，可独立测试；涉及 IDB/IPC 的部分靠真机验证。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

let compaction;

function setupGlobals() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  globalThis.window = {
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener() {},
    dispatchEvent() {},
  };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
  };
}

beforeEach(async () => {
  vi.resetModules();
  setupGlobals();
  compaction = await import('../../src/session/compaction.js');
});

// 构造：根(1,USER) → (2,ASSISTANT) → (3,USER) → (4,ASSISTANT)
function linearMsgs() {
  return [
    { message_id: 1, role: 'USER', parent_id: null },
    { message_id: 2, role: 'ASSISTANT', parent_id: 1 },
    { message_id: 3, role: 'USER', parent_id: 2 },
    { message_id: 4, role: 'ASSISTANT', parent_id: 3 },
  ];
}

test('_pickRecentPairedIds 空数组返回空', () => {
  assert.deepStrictEqual(compaction._pickRecentPairedIds([], null, 0.2), []);
});

test('_pickRecentPairedIds 沿 parent_id 回溯主链（含分支时只取主链）', () => {
  // 分支：3 下有两个回复 4 和 5（5 是另一个分支）
  const msgs = [
    { message_id: 1, role: 'USER', parent_id: null },
    { message_id: 2, role: 'ASSISTANT', parent_id: 1 },
    { message_id: 3, role: 'USER', parent_id: 2 },
    { message_id: 4, role: 'ASSISTANT', parent_id: 3 },
    { message_id: 5, role: 'ASSISTANT', parent_id: 3 },
  ];
  // 指定叶子 4 → 主链为 1,2,3,4，不应包含分支 5
  const picked = compaction._pickRecentPairedIds(msgs, 4, 1);
  assert.ok(picked.includes(4), '包含叶子 4');
  assert.ok(!picked.includes(5), '不包含分支 5');
});

test('_pickRecentPairedIds 结果按 message_id 降序', () => {
  const picked = compaction._pickRecentPairedIds(linearMsgs(), null, 1);
  for (let i = 1; i < picked.length; i++) {
    assert.ok(picked[i - 1] > picked[i], '应降序');
  }
});

test('_pickRecentPairedIds 起点对齐 USER、终点对齐 ASSISTANT（成对）', () => {
  const picked = compaction._pickRecentPairedIds(linearMsgs(), null, 0.5);
  assert.ok(picked.length >= 2, '至少一对');
  const sortedAsc = [...picked].sort((a, b) => a - b);
  // 最小 id 应是 USER 消息（1 或 3）
  assert.ok(sortedAsc[0] === 1 || sortedAsc[0] === 3, '起点是 USER');
});

test('_pickRecentPairedIds 无 parent_id 数据时回退按 id 取尾部', () => {
  // 全部无 parent_id（链长为 1）→ 回退 msgs 原序
  const msgs = [
    { message_id: 1, role: 'USER' },
    { message_id: 2, role: 'ASSISTANT' },
    { message_id: 3, role: 'USER' },
    { message_id: 4, role: 'ASSISTANT' },
  ];
  const picked = compaction._pickRecentPairedIds(msgs, null, 1);
  assert.strictEqual(picked.length, 4);
});

test('_pickRecentPairedIds leafId 不存在时用最大 message_id', () => {
  const picked = compaction._pickRecentPairedIds(linearMsgs(), 999, 1);
  assert.ok(picked.includes(4), '回退到最大 id 作为叶子');
});

// ===== 真截断：sliceChainUpTo =====

test('_sliceChainUpTo 截取主链到目标 id 为止（降序，对齐 share API）', () => {
  const msgs = [
    { message_id: 1, role: 'USER', parent_id: null },
    { message_id: 2, role: 'ASSISTANT', parent_id: 1 },
    { message_id: 3, role: 'USER', parent_id: 2 },
    { message_id: 4, role: 'ASSISTANT', parent_id: 3 },
  ];
  assert.deepStrictEqual(compaction._sliceChainUpTo(msgs, 4, 2), [2, 1]);
  assert.deepStrictEqual(compaction._sliceChainUpTo(msgs, 4, 4), [4, 3, 2, 1]);
});

test('_sliceChainUpTo 目标不在主链 → null（不回退，避免误分享）', () => {
  const msgs = [
    { message_id: 1, role: 'USER', parent_id: null },
    { message_id: 2, role: 'ASSISTANT', parent_id: 1 },
    { message_id: 5, role: 'ASSISTANT', parent_id: 1 }, // 分支
  ];
  // 叶子为 2，主链 1→2；目标 5 在分支上 → null
  assert.strictEqual(compaction._sliceChainUpTo(msgs, 2, 5), null);
});

test('_sliceChainUpTo 目标 id 根本不存在 → null', () => {
  assert.strictEqual(compaction._sliceChainUpTo(linearMsgs(), null, 999), null);
});

test('_sliceChainUpTo 空数组 → null', () => {
  assert.strictEqual(compaction._sliceChainUpTo([], null, 1), null);
});

test('_sliceChainUpTo 截断点非 ASSISTANT → null（防不成对）', () => {
  const msgs = [
    { message_id: 1, role: 'USER', parent_id: null },
    { message_id: 2, role: 'ASSISTANT', parent_id: 1 },
    { message_id: 3, role: 'USER', parent_id: 2 },
  ];
  // 目标 3 是 USER，截到此为止链尾是 USER → 不成对，返回 null
  assert.strictEqual(compaction._sliceChainUpTo(msgs, 3, 3), null);
});

// ===== 压缩标题解析：parseSummaryTitle =====

test('_parseSummaryTitle 标准格式：首行标题 + 正文', () => {
  const r = compaction._parseSummaryTitle('【标题】修复登录 bug\n\n这是摘要正文。');
  assert.strictEqual(r.title, '修复登录 bug');
  assert.strictEqual(r.body, '这是摘要正文。');
});

test('_parseSummaryTitle 无标题行 → title 空、body 为全文', () => {
  const r = compaction._parseSummaryTitle('这是一段没有标题的摘要。');
  assert.strictEqual(r.title, '');
  assert.strictEqual(r.body, '这是一段没有标题的摘要。');
});

test('_parseSummaryTitle 标签后标题为空 → 不把正文首行误当标题', () => {
  // 【标题】后直接换行，正文另起一行：不应把正文首行当作标题
  const r = compaction._parseSummaryTitle('【标题】\n这是正文第一行。');
  assert.strictEqual(r.title, '');
  assert.ok(!r.body.includes('【标题】'), '正文不含标签');
});

test('_parseSummaryTitle 仅标题行无正文', () => {
  const r = compaction._parseSummaryTitle('【标题】测试标题');
  assert.strictEqual(r.title, '测试标题');
  assert.strictEqual(r.body, '');
});

test('_parseSummaryTitle 标题超 20 字截断', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五';
  const r = compaction._parseSummaryTitle('【标题】' + long + '\n正文');
  assert.strictEqual(r.title.length, 20);
});

test('_parseSummaryTitle 首尾空白容错', () => {
  const r = compaction._parseSummaryTitle('  \n【标题】  带空格标题  \n正文');
  assert.strictEqual(r.title, '带空格标题');
  assert.strictEqual(r.body, '正文');
});

test('_parseSummaryTitle 空字符串', () => {
  const r = compaction._parseSummaryTitle('');
  assert.strictEqual(r.title, '');
  assert.strictEqual(r.body, '');
});

// ===== C-004：回退分支混入 branch 孤立消息 → 必须保证 user/assistant 严格配对 =====

test('C-004 回退分支：链断裂时同角色相邻 branch 消息被剔除，结果严格成对', () => {
  // 叶子 7 的 parent_id 指向不存在的 id → 主链 walk 断裂（长度 1），进入回退分支
  // 消息 5 是挂在 3 下的 branch ASSISTANT（与 4 同角色相邻）
  const msgs = [
    { message_id: 1, role: 'USER', parent_id: null },
    { message_id: 2, role: 'ASSISTANT', parent_id: 1 },
    { message_id: 3, role: 'USER', parent_id: 2 },
    { message_id: 4, role: 'ASSISTANT', parent_id: 3 },
    { message_id: 5, role: 'ASSISTANT', parent_id: 3 }, // branch 孤立消息
    { message_id: 6, role: 'USER', parent_id: 4 },
    { message_id: 7, role: 'ASSISTANT', parent_id: 'nonexistent' }, // 链断裂 → 回退
  ];
  const picked = compaction._pickRecentPairedIds(msgs, 7, 1);
  // 按 id 升序检查严格交替
  const sorted = [...picked].sort((a, b) => a - b);
  const byId = Object.fromEntries(msgs.map((m) => [m.message_id, m]));
  for (let i = 1; i < sorted.length; i++) {
    assert.notStrictEqual(byId[sorted[i]].role, byId[sorted[i - 1]].role, `id ${sorted[i]} 与前一条 ${sorted[i - 1]} 同角色相邻（不配对）`);
  }
  assert.strictEqual(byId[sorted[0]].role, 'USER', '起点必须是 USER');
  assert.strictEqual(byId[sorted[sorted.length - 1]].role, 'ASSISTANT', '终点必须是 ASSISTANT');
  assert.ok(!picked.includes(5), 'branch 孤立消息 5 不应出现在压缩对里');
});
