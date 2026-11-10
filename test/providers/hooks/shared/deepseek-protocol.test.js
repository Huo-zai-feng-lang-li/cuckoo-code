'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import {
  flattenDelta,
  decideDeepSeekStreamExit,
  planFragmentsUpdate
} from '../../../../src/providers/hooks/shared/deepseek-protocol.js';

// ===== planFragmentsUpdate（思考/正文重复叠加回归）=====

test('planFragmentsUpdate: SET 且片段组不短于已有时视为全量快照（需重置）', () => {
  const p = planFragmentsUpdate(['THINK', 'RESPONSE'], ['THINK', 'RESPONSE'], 'SET');
  assert.strictEqual(p.reset, true, 'SET 快照必须重置累积文本，否则重复下发的内容被叠加');
  assert.deepStrictEqual(p.types, ['THINK', 'RESPONSE']);
});

test('planFragmentsUpdate: 缺省 op 按 SET 处理（官方协议默认覆盖语义）', () => {
  assert.strictEqual(planFragmentsUpdate([], ['THINK'], undefined).reset, true);
  assert.strictEqual(planFragmentsUpdate(['THINK'], ['THINK'], undefined).reset, true);
});

test('planFragmentsUpdate: 追加语义（append/add）不得重置已累积内容', () => {
  const p = planFragmentsUpdate(['THINK'], ['RESPONSE'], 'append');
  assert.strictEqual(p.reset, false, '追加帧若重置会丢已输出内容');
  assert.deepStrictEqual(p.types, ['THINK', 'RESPONSE'], '类型列表必须级联追加');
});

test('planFragmentsUpdate: SET 但片段组变短（疑似增量块）按追加处理，避免清空', () => {
  const p = planFragmentsUpdate(['THINK', 'RESPONSE', 'RESPONSE'], ['RESPONSE'], 'SET');
  assert.strictEqual(p.reset, false, '短于已有长度的 SET 帧应保守按增量处理');
  assert.deepStrictEqual(p.types, ['THINK', 'RESPONSE', 'RESPONSE', 'RESPONSE']);
});

test('planFragmentsUpdate: 入参非数组时不崩（边界）', () => {
  const p = planFragmentsUpdate(null, undefined, 'SET');
  assert.strictEqual(p.reset, true);
  assert.deepStrictEqual(p.types, []);
});

// ===== planFragmentsUpdate：BATCH 重放（本轮真机 bug 的回归用例）=====
// 真机根因：flattenDelta 展开 BATCH 批量帧时，子项 o 继承 'BATCH'，
// 旧实现只认 op==='SET' 才重置 → 整组重放的 BATCH 帧被当成增量，内容叠加成两份、三份。
// 现判据改为内容前缀比对，与 op 无关。以下用例直接锁定这个真实故障场景。

test('planFragmentsUpdate(BATCH): 整组重放（内容前缀一致）必须重置，不得叠加', () => {
  // 第 1 帧：思考 + 正文
  const p = planFragmentsUpdate([], [], 'BATCH', '', '', '思考A', '正文A');
  assert.strictEqual(p.reset, true, '首帧必重置');

  // 第 2 帧：服务端整组重放同样内容（BATCH）→ 必须以内容判定为重放，否则翻倍
  const p2 = planFragmentsUpdate(
    p.types, p.types, 'BATCH',
    '正文A', '思考A',   // 已累积
    '正文A', '思考A'    // 本帧重建
  );
  assert.strictEqual(p2.reset, true, 'BATCH 重放即使 op 不是 SET 也必须重置（真机 bug 的回归点）');
});

test('planFragmentsUpdate(BATCH): 重放且内容变长（前缀一致）仍须重置', () => {
  // 已累积「正文A」，本帧重放「正文AB」——前缀一致 = 全量快照的扩展帧
  const p = planFragmentsUpdate(['RESPONSE'], ['RESPONSE'], 'BATCH', '正文A', '', '正文AB', '');
  assert.strictEqual(p.reset, true, '前缀一致且更长应视为快照重放，重置后整体重建');
});

test('planFragmentsUpdate(BATCH): 真实增量（内容非前缀）必须追加，不得清空', () => {
  // 已累积「正文A」，本帧是全新的一段「B」→ 前缀不符 = 真增量
  const p = planFragmentsUpdate(['RESPONSE'], ['RESPONSE'], 'BATCH', '正文A', '', 'B', '');
  assert.strictEqual(p.reset, false, '真增量帧重置会丢已输出内容');
  assert.deepStrictEqual(p.types, ['RESPONSE', 'RESPONSE'], '类型须级联追加');
});

test('planFragmentsUpdate(BATCH): 思考重放但正文是增量时按追加处理（保守不丢内容）', () => {
  // 思考一致（重放），但正文新增了内容且非前缀 → 宁可追加也不清空（丢内容比重复更糟）
  const p = planFragmentsUpdate(['THINK', 'RESPONSE'], ['RESPONSE'], 'BATCH', '正文A', '思考A', '全新正文', '思考A');
  assert.strictEqual(p.reset, false, '任一维度非前缀即保守追加，避免丢内容');
});

// ===== flattenDelta =====

test('flattenDelta 解析单个标准 patch', () => {
  const state = { op: 'SET', path: '' };
  const res = flattenDelta({ p: 'response/status', o: 'SET', v: 'FINISHED' }, '', state);
  assert.deepStrictEqual(res, [
    { p: 'response/status', o: 'SET', v: 'FINISHED', raw: { p: 'response/status', o: 'SET', v: 'FINISHED' } }
  ]);
  assert.strictEqual(state.path, 'response/status');
  assert.strictEqual(state.op, 'SET');
});

test('flattenDelta 解析 BATCH 操作并自动级联父级路径', () => {
  const state = { op: 'SET', path: '' };
  const batch = {
    o: 'BATCH',
    p: 'response',
    v: [
      { p: 'fragments/0/content', o: 'SET', v: '你好' },
      { p: 'accumulated_token_usage', o: 'SET', v: 10 }
    ]
  };
  const res = flattenDelta(batch, '', state);
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].p, 'response/fragments/0/content');
  assert.strictEqual(res[0].v, '你好');
  assert.strictEqual(res[1].p, 'response/accumulated_token_usage');
  assert.strictEqual(res[1].v, 10);
});

test('flattenDelta 状态继承：缺省 p 和 o 时延续上一帧路径与操作', () => {
  const state = { op: 'SET', path: 'response/fragments/0/content' };
  // 缺省 p 和 o 的后续数据块
  const res = flattenDelta({ v: '，世界！' }, '', state);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].p, 'response/fragments/0/content');
  assert.strictEqual(res[0].o, 'SET');
  assert.strictEqual(res[0].v, '，世界！');
});

test('flattenDelta 嵌套 BATCH 路径深层级联', () => {
  const state = { op: 'SET', path: '' };
  const nested = {
    o: 'BATCH',
    p: 'response',
    v: [
      {
        o: 'BATCH',
        p: 'fragments/0',
        v: [
          { p: 'content', o: 'SET', v: 'chunk' }
        ]
      }
    ]
  };
  const res = flattenDelta(nested, '', state);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].p, 'response/fragments/0/content');
  assert.strictEqual(res[0].v, 'chunk');
});

// ===== decideDeepSeekStreamExit =====

test('decideDeepSeekStreamExit 用户主动停止返回 stopped', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: true,
    incomplete: false,
    streamRateLimit: false,
    finished: false,
    textLen: 10
  });
  assert.strictEqual(status, 'stopped');
});

test('decideDeepSeekStreamExit 服务端截断返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: true,
    streamRateLimit: false,
    finished: false,
    textLen: 50
  });
  assert.strictEqual(status, 'error');
});

test('decideDeepSeekStreamExit 流内限流返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: true,
    finished: true,
    textLen: 20
  });
  assert.strictEqual(status, 'error');
});

test('decideDeepSeekStreamExit 收到完成事件且正文非空返回 finished', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: true,
    textLen: 100
  });
  assert.strictEqual(status, 'finished');
});

test('decideDeepSeekStreamExit 收到完成事件但正文为空（仅思考截断）返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: true,
    textLen: 0
  });
  assert.strictEqual(status, 'error');
});

test('decideDeepSeekStreamExit 未收到完成事件但流自然结束且有正文返回 finished（宽容策略）', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: false,
    textLen: 80
  });
  assert.strictEqual(status, 'finished');
});

test('decideDeepSeekStreamExit 无正文且无完成事件返回 error', () => {
  const status = decideDeepSeekStreamExit({
    userStopped: false,
    incomplete: false,
    streamRateLimit: false,
    finished: false,
    textLen: 0
  });
  assert.strictEqual(status, 'error');
});
