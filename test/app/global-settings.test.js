'use strict';
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
let gs;

beforeEach(async () => {
  // 隔离用户目录，别污染真实 ~/.cuckoo
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-gs-'));
  process.env.CUCKOO_HOME = tmpHome;
  gs = await import('../../src/app/global-settings.js');
  gs._clearCache();
});

afterEach(() => {
  delete process.env.CUCKOO_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
});

test('文件不存在时 readAgentSettings 返回防封默认值', () => {
  assert.strictEqual(gs.hasAgentSettingsFile(), false);
  const s = gs.readAgentSettings();
  assert.strictEqual(s.retryCount, 3);
  assert.strictEqual(s.retryDelayMin, 15);
  assert.strictEqual(s.retryDelayMax, 30);
  assert.strictEqual(s.sendDelayMin, 6);
  assert.strictEqual(s.sendDelayMax, 16);
  assert.strictEqual(s.retryEnabled, true);
  assert.strictEqual(s.retry429Count, 1);
  assert.strictEqual(s.watchdogCount, 1);
  // 子代理新字段默认值（并发 3、间隔 0 = 保持旧行为）
  assert.strictEqual(s.maxConcurrentAgents, 3);
  assert.strictEqual(s.agentStartIntervalMin, 0);
  assert.strictEqual(s.agentStartIntervalMax, 0);
});

test('子代理并发：1~10 合法，越界回退/压顶', () => {
  assert.strictEqual(gs.writeAgentSettings({ maxConcurrentAgents: 5 }).maxConcurrentAgents, 5);
  assert.strictEqual(gs.writeAgentSettings({ maxConcurrentAgents: 0 }).maxConcurrentAgents, 3, '0 回退默认 3');
  assert.strictEqual(gs.writeAgentSettings({ maxConcurrentAgents: -2 }).maxConcurrentAgents, 3, '负数回退默认 3');
  assert.strictEqual(gs.writeAgentSettings({ maxConcurrentAgents: 99 }).maxConcurrentAgents, 10, '超 10 压到 10');
  assert.strictEqual(gs.writeAgentSettings({ maxConcurrentAgents: 'abc' }).maxConcurrentAgents, 3, '非数字回退默认');
});

test('子代理启动间隔：非负；max<min 时抬到 min', () => {
  const s1 = gs.writeAgentSettings({ agentStartIntervalMin: -5, agentStartIntervalMax: 10 });
  assert.strictEqual(s1.agentStartIntervalMin, 0, '负数归零');
  assert.strictEqual(s1.agentStartIntervalMax, 10);
  const s2 = gs.writeAgentSettings({ agentStartIntervalMin: 30, agentStartIntervalMax: 5 });
  assert.strictEqual(s2.agentStartIntervalMin, 30);
  assert.strictEqual(s2.agentStartIntervalMax, 30, 'max 应被抬到 min');
});

test('写入后落盘且可读回', () => {
  gs.writeAgentSettings({ retryCount: 7, sendDelayMin: 9 });
  assert.strictEqual(gs.hasAgentSettingsFile(), true);
  gs._clearCache();
  const s = gs.readAgentSettings();
  assert.strictEqual(s.retryCount, 7);
  assert.strictEqual(s.sendDelayMin, 9);
  // 未提供字段回退默认
  assert.strictEqual(s.retryDelayMin, 15);
});

test('规整：区间 max < min 时自动抬到 min', () => {
  const s = gs.writeAgentSettings({ retryDelayMin: 20, retryDelayMax: 5, sendDelayMin: 10, sendDelayMax: 2 });
  assert.strictEqual(s.retryDelayMax, 20);
  assert.strictEqual(s.sendDelayMax, 10);
});

test('规整：负数时间归零、非法文本回退默认、非法次数回退默认', () => {
  const s = gs.writeAgentSettings({
    retryDelayMin: -5,
    retryCount: 'abc',
    retryPrompt: '   ',
    watchdogPrompt: '',
  });
  assert.strictEqual(s.retryDelayMin, 0);
  assert.strictEqual(s.retryCount, 3);
  assert.ok(s.retryPrompt.length > 0);
  assert.strictEqual(s.watchdogPrompt, '请继续');
});

test('规整：ssrfGuard 严格布尔、goalMaxIterations 必须为正', () => {
  const s = gs.writeAgentSettings({ ssrfGuard: 'yes', goalMaxIterations: -1 });
  assert.strictEqual(s.ssrfGuard, false);
  assert.strictEqual(s.goalMaxIterations, 50);
});

test('规整：retryEnabled 缺字段回退默认 true（不能误判为 false）', () => {
  const s = gs.writeAgentSettings({});
  assert.strictEqual(s.retryEnabled, true, '缺字段必须回退默认 true');
  const s2 = gs.writeAgentSettings({ retryEnabled: false });
  assert.strictEqual(s2.retryEnabled, false);
  const s3 = gs.writeAgentSettings({ retryEnabled: 'false' });
  assert.strictEqual(s3.retryEnabled, false, "字符串 'false' 不应判为开");
});

test('损坏的 JSON 文件回退默认值而不抛错', () => {
  fs.writeFileSync(gs.getAgentSettingsFile(), '{ 这不是合法 json', 'utf-8');
  gs._clearCache();
  const s = gs.readAgentSettings();
  assert.strictEqual(s.retryCount, 3);
});

// ===== 迁移：老用户 localStorage 中的旧默认值应被新默认替换 =====

test('migrateLegacy：恰好等于旧默认的字段替换为新默认', () => {
  // 旧版 state.ts / getSettingsData 的 sendDelay 默认是 1000/10000 毫秒（即 1/10 秒），
  // 不是需求文档里早先设想的 4/12 秒。此测试用真实旧默认值，否则会掩盖迁移失效 bug。
  const s = gs.migrateLegacy({
    retryDelayMin: 4, retryDelayMax: 10, retryCount: 10,
    sendDelayMin: 1, sendDelayMax: 10,
  });
  assert.strictEqual(s.retryCount, 3);
  assert.strictEqual(s.retryDelayMin, 15);
  assert.strictEqual(s.retryDelayMax, 30);
  assert.strictEqual(s.sendDelayMin, 6);
  assert.strictEqual(s.sendDelayMax, 16);
});

test('migrateLegacy：用户真实自定义的值原样保留', () => {
  const s = gs.migrateLegacy({
    retryDelayMin: 8, retryDelayMax: 20, retryCount: 5,
    sendDelayMin: 2, sendDelayMax: 3,
  });
  assert.strictEqual(s.retryCount, 5);
  assert.strictEqual(s.retryDelayMin, 8);
  assert.strictEqual(s.retryDelayMax, 20);
  assert.strictEqual(s.sendDelayMin, 2);
  assert.strictEqual(s.sendDelayMax, 3);
});

test('migrateLegacy：旧真值 sendDelay 1/10 秒必须命中迁移（防回归）', () => {
  // 回归点：曾把 LEGACY_DEFAULTS.sendDelay 误写成 4/12（那是需求文档的目标值，
  // 不是旧代码真值 1000/10000ms）。一旦写错，老用户 1/10 秒的配置不会被迁移，
  // 防封新默认（6/16）对其完全失效 —— 本用例锁死这个语义。
  const s = gs.migrateLegacy({ sendDelayMin: 1, sendDelayMax: 10 });
  assert.strictEqual(s.sendDelayMin, 6, '旧真值 1s 必须被迁移到 6s');
  assert.strictEqual(s.sendDelayMax, 16, '旧真值 10s 必须被迁移到 16s');
});

test('migrateLegacy：空对象 → 全默认', () => {
  const s = gs.migrateLegacy({});
  assert.strictEqual(s.retryCount, 3);
  assert.strictEqual(s.sendDelayMin, 6);
});

// ===== applyDelta：多窗口并发保存不同字段不能互相覆盖 =====

test('applyDelta：只覆盖增量字段，其余保留基底值', () => {
  const latest = gs.writeAgentSettings({ retryCount: 7, sendDelayMin: 9, retryPrompt: '自定义A' });
  const next = gs.applyDelta(latest, { retryCount: 5 });
  assert.strictEqual(next.retryCount, 5, '增量字段应被覆盖');
  assert.strictEqual(next.sendDelayMin, 9, '未提及字段应保留');
  assert.strictEqual(next.retryPrompt, '自定义A', '未提及字段应保留');
});

test('applyDelta：两窗口并发改不同字段 → 都生效（回归）', () => {
  // 初始状态
  const s0 = gs.writeAgentSettings({ retryCount: 3, sendDelayMin: 6 });
  // 窗口 A 读到 s0，准备改 retryCount
  const aBase = gs.applyDelta(s0, {});
  // 窗口 B 先写入 sendDelayMin
  const s1 = gs.writeAgentSettings(gs.applyDelta(gs.readAgentSettings(), { sendDelayMin: 12 }));
  // 窗口 A 再写入 retryCount（基底用最新值，模拟主进程在 await 后重读）
  const s2 = gs.writeAgentSettings(gs.applyDelta(gs.readAgentSettings(), { retryCount: 8 }));
  assert.strictEqual(s2.retryCount, 8, 'A 的改动应生效');
  assert.strictEqual(s2.sendDelayMin, 12, 'B 的改动不能被 A 覆盖');
  // 用陈旧基底（aBase）合并会覆盖 B —— 验证必须用最新基底
  const stale = gs.applyDelta(aBase, { retryCount: 8 });
  assert.strictEqual(stale.sendDelayMin, 6, '（反例）陈旧基底会丢掉 B 的改动');
});

test('applyDelta：undefined 视为未提供，不清空字段', () => {
  const latest = gs.writeAgentSettings({ retryPrompt: '保留我' });
  const next = gs.applyDelta(latest, { retryPrompt: undefined, retryCount: 4 });
  assert.strictEqual(next.retryPrompt, '保留我');
  assert.strictEqual(next.retryCount, 4);
});

test('applyDelta：空增量 → 完全保留基底', () => {
  const latest = gs.writeAgentSettings({ retryCount: 6, sendDelayMax: 20 });
  const next = gs.applyDelta(latest, {});
  assert.strictEqual(next.retryCount, 6);
  assert.strictEqual(next.sendDelayMax, 20);
});

test('applyDelta：增量非法值被 normalize 规整而非写脏', () => {
  const latest = gs.writeAgentSettings({});
  const next = gs.applyDelta(latest, { retryDelayMin: -99, retryPrompt: '   ' });
  assert.strictEqual(next.retryDelayMin, 0, '负数归零');
  assert.ok(next.retryPrompt.length > 0, '空文本回退默认');
});
