'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { reconcileWindowGroups } from '../../src/app/window-groups-reconcile.js';

test('清理已删除窗口：从组内移除、清空 lastWindowId/lastSessionId 与限流记录', () => {
  const data = {
    groups: [
      {
        id: 'wg-1',
        name: '未封禁',
        windowIds: ['profile-alive-1', 'profile-dead', 'profile-alive-2'],
        lastWindowId: 'profile-dead',
        lastSessionId: 's-dead',
      },
    ],
    rateLimits: { 'profile-dead': 1, 'profile-alive-1': 2 },
  };
  const r = reconcileWindowGroups(data, ['profile-alive-1', 'profile-alive-2']);
  assert.equal(r.changed, true);
  assert.deepEqual(r.data.groups[0].windowIds, ['profile-alive-1', 'profile-alive-2']);
  assert.equal(r.data.groups[0].lastWindowId, null);
  assert.equal(r.data.groups[0].lastSessionId, null);
  assert.deepEqual(r.data.rateLimits, { 'profile-alive-1': 2 });
});

test('组内窗口全被删除时删掉空组，其他组保持不变', () => {
  const data = {
    groups: [
      { id: 'empty', name: '空组', windowIds: ['dead'], lastWindowId: null, lastSessionId: null },
      { id: 'keep', name: '保留', windowIds: ['alive'], lastWindowId: 'alive', lastSessionId: 's' },
    ],
    rateLimits: {},
  };
  const r = reconcileWindowGroups(data, ['alive']);
  assert.equal(r.changed, true);
  assert.deepEqual(r.data.groups.map((g) => g.id), ['keep']);
});

test('没有孤儿引用时不写盘（changed=false）', () => {
  const data = {
    groups: [{ id: 'keep', name: '保留', windowIds: ['alive'], lastWindowId: 'alive', lastSessionId: 's' }],
    rateLimits: { alive: 1 },
  };
  const r = reconcileWindowGroups(data, ['alive']);
  assert.equal(r.changed, false);
  assert.deepEqual(r.data.groups, data.groups);
});

test('validIds 为空时不得清空组配置（profile 读取失败/空列表保护）', () => {
  const data = {
    groups: [{ id: 'keep', name: '保留', windowIds: ['a'], lastWindowId: 'a', lastSessionId: 's' }],
    rateLimits: { a: 1 },
  };
  const r = reconcileWindowGroups(data, []);
  assert.equal(r.changed, false);
  assert.deepEqual(r.data.groups, data.groups);
  assert.deepEqual(r.data.rateLimits, { a: 1 });
});

test('数据损坏/缺字段时安全返回，不抛错', () => {
  assert.equal(reconcileWindowGroups(null, ['alive']).changed, false);
  const r = reconcileWindowGroups({ groups: [{ id: 'g' }, { id: 'h', windowIds: 'bad' }] }, ['alive']);
  assert.equal(r.changed, true);
  assert.equal(r.data.groups.length, 0);
});
