import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

// window 模块是单例，用 resetModules + 动态 import 隔离前先重置
let windowState;

beforeEach(async () => {
  vi.resetModules();
  windowState = await import('../../src/app/window.js');
});

test('getMainWindow 初始为 null', () => {
  assert.strictEqual(windowState.getMainWindow(), null);
});

test('getMainContext 初始为 null', () => {
  assert.strictEqual(windowState.getMainContext(), null);
});

test('addWindow 与 getWindowContext 往返', () => {
  const fakeWin = { id: 1, on: () => {}, isDestroyed: () => false };
  const fakeStore = { state: { selectedProjectDir: 'C:/x' } };
  windowState.addWindow(fakeWin, 'p1', 'deepseek', fakeStore);
  const ctx = windowState.getWindowContext(1);
  assert.ok(ctx);
  assert.strictEqual(ctx.profileId, 'p1');
  assert.strictEqual(ctx.providerId, 'deepseek');
  assert.strictEqual(ctx.sessionStore, fakeStore);
  assert.strictEqual(ctx.win, fakeWin);
});

test('getContextByWebContents 查找对应上下文', () => {
  const wcA = { id: 'wc-a' };
  const wcB = { id: 'wc-b' };
  const winA = { id: 'a', on: () => {}, webContents: wcA, isDestroyed: () => false };
  const winB = { id: 'b', on: () => {}, webContents: wcB, isDestroyed: () => false };
  windowState.addWindow(winA, 'p1', 'deepseek', { a: 1 });
  windowState.addWindow(winB, 'p2', 'claude', { b: 2 });
  assert.strictEqual(windowState.getContextByWebContents(wcA).profileId, 'p1');
  assert.strictEqual(windowState.getContextByWebContents(wcB).profileId, 'p2');
  assert.strictEqual(windowState.getContextByWebContents({ id: 'nope' }), null);
});

test('getWindowByProfileId 查找窗口', () => {
  const winA = { id: 'wa', on: () => {}, isDestroyed: () => false };
  windowState.addWindow(winA, 'pA', 'deepseek', {});
  assert.strictEqual(windowState.getWindowByProfileId('pA').win, winA);
  assert.strictEqual(windowState.getWindowByProfileId('missing'), null);
});

test('removeWindow 后 getWindowContext 返回 null', () => {
  const fakeWin = { id: 2, on: () => {}, isDestroyed: () => false };
  windowState.addWindow(fakeWin, 'p1', 'deepseek', {});
  assert.ok(windowState.getWindowContext(2));
  windowState.removeWindow(2);
  assert.strictEqual(windowState.getWindowContext(2), null);
});

test('子代理窗口不抢主窗口地位（getMainContext 跳过子代理）', () => {
  const mainWin = { id: 10, on: () => {}, isDestroyed: () => false };
  const subWin = { id: 11, on: () => {}, isDestroyed: () => false };
  windowState.addWindow(mainWin, 'p1', 'deepseek', {});
  // 子代理复用同一 profileId
  windowState.addWindow(subWin, 'p1', 'deepseek', {}, undefined, true);
  assert.strictEqual(windowState.getMainContext().win, mainWin, '子代理创建后主窗口不应被顶替');
});

test('只有子代理时 getMainContext 返回 null（不回落到子代理）', () => {
  const subWin = { id: 20, on: () => {}, isDestroyed: () => false };
  windowState.addWindow(subWin, 'p1', 'deepseek', {}, undefined, true);
  assert.strictEqual(windowState.getMainContext(), null);
});

test('主窗口移除后回退选举跳过子代理', () => {
  const mainWin = { id: 30, on: () => {}, isDestroyed: () => false };
  const subWin = { id: 31, on: () => {}, isDestroyed: () => false };
  windowState.addWindow(mainWin, 'p1', 'deepseek', {});
  windowState.addWindow(subWin, 'p1', 'deepseek', {}, undefined, true);
  windowState.removeWindow(30);
  assert.strictEqual(windowState.getMainContext(), null, '回退不应选中子代理');
});

test('多主窗口移除当前活跃者后回退到另一个主窗口', () => {
  const winA = { id: 50, on: () => {}, isDestroyed: () => false };
  const winB = { id: 51, on: () => {}, isDestroyed: () => false };
  windowState.addWindow(winA, 'pA', 'deepseek', {});
  windowState.addWindow(winB, 'pB', 'claude', {});
  assert.strictEqual(windowState.getMainContext().win, winB, '最近创建的是活跃主窗口');
  windowState.removeWindow(51);
  assert.strictEqual(windowState.getMainContext().win, winA, '应回退到剩下的主窗口');
});

test('setMainWindow 拒绝把子代理窗口设为主窗口', () => {
  const mainWin = { id: 40, on: () => {}, isDestroyed: () => false };
  const subWin = { id: 41, on: () => {}, isDestroyed: () => false };
  windowState.addWindow(mainWin, 'p1', 'deepseek', {});
  windowState.addWindow(subWin, 'p1', 'deepseek', {}, undefined, true);
  windowState.setMainWindow(subWin);
  assert.strictEqual(windowState.getMainWindow(), mainWin, '子代理不应被设为主窗口');
});

test('getAllWindows 返回窗口数组', () => {
  const winA = { id: 'a', on: () => {}, isDestroyed: () => false };
  const winB = { id: 'b', on: () => {}, isDestroyed: () => false };
  windowState.addWindow(winA, 'p1', 'deepseek', {});
  windowState.addWindow(winB, 'p2', 'claude', {});
  const all = windowState.getAllWindows();
  assert.strictEqual(all.length, 2);
  assert.ok(all.includes(winA));
  assert.ok(all.includes(winB));
});
