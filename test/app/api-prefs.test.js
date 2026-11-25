'use strict';
/**
 * API 连接配置的多窗口隔离。
 *
 * 背景：不同窗口可能接不同厂商/Key/模型，甚至同一 Key 下上下文窗口也不同。
 * 配置必须按 profile（窗口）隔离；旧版全局 apiTransport 继续作为默认值。
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp;
let ui;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-api-prefs-'));
  process.env.CUCKOO_HOME = tmp;
  ui = await import('../../src/app/ui-prefs.js');
});

afterEach(() => {
  delete process.env.CUCKOO_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

test('未配置过的窗口继承旧版全局配置（兼容老用户）', () => {
  ui.writePrefs({ apiTransport: { baseUrl: 'http://global/v1', model: 'global-model', maxToolRounds: 12 } });
  const prefs = ui.readPrefs();
  const conn = ui.getApiConnection(prefs, 'win-a');
  assert.equal(conn.baseUrl, 'http://global/v1');
  assert.equal(conn.model, 'global-model');
  assert.equal(conn.maxToolRounds, 12);
});

test('每个窗口可以独立配置 Base URL / Key / 模型 / 上下文窗口', () => {
  ui.writePrefs({ apiTransport: { baseUrl: 'http://global/v1', model: 'global-model' } });
  ui.setApiConnection('win-a', {
    baseUrl: 'http://a/v1', apiKey: 'key-a', model: 'model-a', contextWindow: 524288, maxToolRounds: 120,
  });
  ui.setApiConnection('win-b', {
    baseUrl: 'http://b/v1', apiKey: 'key-b', model: 'model-b', contextWindow: 131072, maxToolRounds: 32,
  });

  const prefs = ui.readPrefs();
  assert.equal(ui.getApiConnection(prefs, 'win-a').baseUrl, 'http://a/v1');
  assert.equal(ui.getApiConnection(prefs, 'win-a').apiKey, 'key-a');
  assert.equal(ui.getApiConnection(prefs, 'win-a').contextWindow, 524288);
  assert.equal(ui.getApiConnection(prefs, 'win-b').model, 'model-b');
  assert.equal(ui.getApiConnection(prefs, 'win-b').apiKey, 'key-b');
  // 其它窗口仍走全局默认，不能串 Key
  const other = ui.getApiConnection(prefs, 'win-c');
  assert.equal(other.baseUrl, 'http://global/v1');
  assert.equal(other.apiKey, '');
});

test('工具轮数上限放宽到 500，超出钳制', () => {
  ui.setApiConnection('win-a', { maxToolRounds: 9999 });
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-a').maxToolRounds, 500);
  ui.setApiConnection('win-a', { maxToolRounds: 0 });
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-a').maxToolRounds, 1);
});

test('未显式关闭时默认启用图片输入', () => {
  const conn = ui.getApiConnection(ui.readPrefs(), 'win-new');
  assert.equal(conn.vision, true);
  ui.setApiConnection('win-new', { vision: false });
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-new').vision, false);
});

test('工具模式默认 native，cuckoo-js 按窗口独立保存', () => {
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-new').toolMode, 'native');
  ui.setApiConnection('win-a', { toolMode: 'cuckoo-js' });
  ui.setApiConnection('win-b', { toolMode: 'native' });
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-a').toolMode, 'cuckoo-js');
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-b').toolMode, 'native');
  // 非法值必须回落 native，不能误开实验分支
  ui.setApiConnection('win-a', { toolMode: 'garbage' });
  assert.equal(ui.getApiConnection(ui.readPrefs(), 'win-a').toolMode, 'native');
});

test('渲染进程只能看到 Key 已配置标记，拿不到明文', () => {
  ui.setApiConnection('win-a', { apiKey: 'secret-a' });
  const safe = ui.redactPrefsForRenderer(ui.readPrefs());
  assert.equal(safe.apiTransport.apiKey, '');
  assert.equal(safe.apiTransport.byProfile['win-a'].apiKey, '');
  assert.equal(safe.apiTransport.byProfile['win-a'].hasApiKey, true);
  assert.notEqual(JSON.stringify(safe), JSON.stringify(ui.readPrefs()));
});

test('更新部分字段不会清掉已保存的 Key', () => {
  ui.setApiConnection('win-a', { apiKey: 'secret-a', model: 'm1' });
  ui.setApiConnection('win-a', { model: 'm2' });
  const conn = ui.getApiConnection(ui.readPrefs(), 'win-a');
  assert.equal(conn.apiKey, 'secret-a');
  assert.equal(conn.model, 'm2');
});
