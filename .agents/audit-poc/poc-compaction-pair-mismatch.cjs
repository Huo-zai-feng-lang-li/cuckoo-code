/**
 * PoC: compaction.ts pickRecentPairedIds 回退分支可能混入 branch 消息
 *
 * 原代码（compaction.ts 约 line 207-250）：
 *   先走 parent_id 链拿到主链；若主链长度 <=1 但消息总数 >1，
 *   回退到 ordered = msgs（全部按 message_id 排序），不区分主链/分支。
 *
 * 问题：回退分支下，start 调整为 USER、end 调整为 ASSISTANT，
 * 但中间可能混入 branch 的消息，导致 keep 段不是 USER-ASSISTANT 严格配对。
 * 后续 share/conversation create 要求消息严格配对（user→assistant→user...），
 * 会抛 MESSAGES_MUST_APPEAR_IN_PAIRS。
 *
 * 运行：node .agents/audit-poc/poc-compaction-pair-mismatch.js
 */

function pickRecentPairedIds(msgs, currentMessageId, ratio) {
  // 复刻 compaction.ts 的逻辑（简化版）
  const ordered = msgs.slice().sort((a, b) => a.message_id - b.message_id);
  // 模拟：主链 walk 失败（chain.length <= 1），回退到全量 ordered
  // （原代码注释说"可能混入 branch 消息"）
  let start = 0;
  let end = ordered.length;
  const keep = Math.max(2, Math.round(ordered.length * ratio));
  start = Math.max(0, ordered.length - keep);

  // 调整 start 到最近的 USER
  while (start < end && ordered[start].role !== 'user') start++;
  // 调整 end 到最近的 ASSISTANT（不越界）
  while (end > start + 1 && ordered[end - 1].role !== 'assistant') end--;

  return ordered.slice(start, end).map(m => m.message_id);
}

// 构造场景：主链 [U1, A1, U2, A2]，branch 消息 [B1(assistant, 属于A1的分支)]
// 按 message_id 排序后：U1(1), A1(2), B1(3, branch), U2(4), A2(5)
const msgs = [
  { message_id: 1, role: 'user', text: 'U1', parent_id: null },
  { message_id: 2, role: 'assistant', text: 'A1', parent_id: 1 },
  { message_id: 3, role: 'assistant', text: 'B1-branch', parent_id: 2 }, // branch
  { message_id: 4, role: 'user', text: 'U2', parent_id: 2 },           // 主链下一步
  { message_id: 5, role: 'assistant', text: 'A2', parent_id: 4 },
];

console.log('=== PoC: 压缩回退分支可能导致消息配对错误 ===\n');
console.log('消息列表（按 message_id）：');
msgs.forEach(m => console.log('  id=' + m.message_id + ' role=' + m.role + ' parent=' + m.parent_id + (m.text.includes('branch') ? '  ← branch' : '')));

const keptIds = pickRecentPairedIds(msgs, 5, 0.6);
console.log('\n压缩后保留的消息 id:', keptIds.join(', '));

const keptMsgs = keptIds.map(id => msgs.find(m => m.message_id === id));
console.log('保留消息序列：');
keptMsgs.forEach(m => console.log('  ' + m.role + ' (id=' + m.message_id + ') ' + m.text));

// 检查配对是否严格 user→assistant→user...
let paired = true;
let expectedRole = 'user';
for (const m of keptMsgs) {
  if (m.role !== expectedRole) {
    paired = false;
    break;
  }
  expectedRole = expectedRole === 'user' ? 'assistant' : 'user';
}
console.log('\n严格配对检查（user→assistant→user...）：', paired ? '通过' : '失败');
if (!paired) {
  console.log('→ 确认 BUG：branch 消息 B1(id=3) 混入保留段，破坏了 USER-ASSISTANT 配对');
  console.log('  后续 share/create conversation 会抛 MESSAGES_MUST_APPEAR_IN_PAIRS');
}
console.log('\n=== 结论：compaction.ts 回退分支（主链 walk 失败时）应过滤 branch 消息 ===');
