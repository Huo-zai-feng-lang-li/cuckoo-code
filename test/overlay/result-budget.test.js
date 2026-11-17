'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { budgetPerItem, clipToolText, fitDraftAndResult, MAX_ITEM_CHARS, MAX_RESULT_TOTAL_CHARS, TRUNC_MARKER } from '../../src/overlay/result-budget.js';

test('budgetPerItem: 单条保持 15,000 上限', () => {
  assert.strictEqual(budgetPerItem(1), MAX_ITEM_CHARS);
});

test('budgetPerItem: 多段按总预算均分', () => {
  assert.strictEqual(budgetPerItem(2), 13000);
  assert.strictEqual(budgetPerItem(3), Math.floor(MAX_RESULT_TOTAL_CHARS / 3));
  assert.strictEqual(budgetPerItem(10), 2600);
});

test('budgetPerItem: 段数异常返回 0，且不低于 200', () => {
  assert.strictEqual(budgetPerItem(0), 0);
  assert.strictEqual(budgetPerItem(-1), 0);
  assert.strictEqual(budgetPerItem(100), 260);
  assert.strictEqual(budgetPerItem(200), 200);
  // 总预算不能因为段数多而失效
  assert.ok(budgetPerItem(100) * 100 <= MAX_RESULT_TOTAL_CHARS);
});

test('clipToolText: 未超限原样返回', () => {
  const text = '短输出';
  assert.strictEqual(clipToolText(text, 100), text);
});

test('clipToolText: 超限时保留头尾并带自救标记', () => {
  const head = 'HEAD_' + 'a'.repeat(5000);
  const tail = 'b'.repeat(2000) + '_TAIL_END';
  const text = head + 'MIDDLE_' + tail;
  const max = 4000;
  const out = clipToolText(text, max);
  assert.ok(out.length <= max, '截断后长度 ' + out.length + ' 应 <= ' + max);
  assert.ok(out.includes('HEAD_'), '必须保留头部');
  assert.ok(out.includes('_TAIL_END'), '必须保留尾部（错误栈/结论常在尾部）');
  assert.ok(out.includes(TRUNC_MARKER), '必须带截断标记供模型自救');
  assert.ok(!out.includes('MIDDLE_'), '中间段应被裁掉');
});

test('clipToolText: 上限小于标记长度时退化为头部截断，不抛错', () => {
  const out = clipToolText('x'.repeat(1000), 50);
  assert.strictEqual(out.length, 50);
});

test('fitDraftAndResult: 短草稿 + 短结果原样拼接', () => {
  const out = fitDraftAndResult('我的草稿', '工具结果');
  assert.strictEqual(out, '我的草稿\n\n工具结果');
});

test('fitDraftAndResult: 超长只裁结果段，草稿只出现一次', () => {
  const draft = 'DRAFT_UNIQUE';
  const result = 'HEAD_' + 'a'.repeat(50000) + '_TAIL_' + 'b'.repeat(500);
  const out = fitDraftAndResult(draft, result, 39000);
  assert.ok(out.length <= 39000, '总长度 ' + out.length);
  assert.strictEqual(out.split(draft).length - 1, 1, '草稿不得重复');
  assert.ok(out.startsWith(draft + '\n\n'), '草稿必须在最前');
  assert.ok(out.includes('_TAIL_'), '结果尾部必须保留');
  assert.ok(out.includes(TRUNC_MARKER), '必须带截断标记');
});

test('fitDraftAndResult: 无草稿时等同单段截断', () => {
  const result = 'a'.repeat(50000);
  const out = fitDraftAndResult('', result, 39000);
  assert.ok(out.length <= 39000);
  assert.ok(out.includes(TRUNC_MARKER));
});
