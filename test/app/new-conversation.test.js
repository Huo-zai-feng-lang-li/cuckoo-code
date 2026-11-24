'use strict';
/**
 * "新对话"契约守卫测试。
 *
 * 背景：harness 视图是**独立的 WebContentsView**，它的消息流/计划/目标/附件
 * 全在页面自己的内存里。主进程把 AI 网页导航到首页，harness 视图是不知情的 ——
 * 必须显式通知它重置。
 *
 * 这里钉住三条不变式：
 *   1) 两条入口（harness 页面自己的按钮 / 壳页面侧栏按钮）走**同一段**重置逻辑
 *   2) 主进程发的是独立的 `reset` 事件，不复用 `session-changed`；API 模式还带新 sessionId
 *   3) harness 侧网页模式 reset 必须把 currentSessionId 归零；API 模式切到新会话但保留旧会话存档
 *
 * 第 3 条最容易被忽略却最关键：网页新对话落到平台首页，URL 没有会话 id，
 * 紧接着到达的 session-changed 带的是空 sid；若 currentSessionId 没归零，
 * onSessionChanged 会照常执行并把 localStorage 里的旧记录 loadHist() 回来，
 * 刚清干净的界面又被填满 —— 等于白清。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HARNESS_HTML = read('src/ui/harness.html');
const HARNESS_IPC = read('src/app/ipc/harness.ts');
const HARNESS_PRELOAD = read('src/app/harness-preload.ts');
const SHELL_IPC = read('src/app/ipc/shell.ts');
const SESSION_IPC = read('src/app/ipc/session.ts');
const ENTRY = read('src/app/entry.ts');

/** 取某段源码的正文（从标记处向后截断） */
function bodyFrom(src, marker, len = 2200) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, '未找到标记：' + marker);
  return src.slice(i, i + len);
}

// ===== harness 页面 =====

test('harness 页面处理 reset 事件', () => {
  assert.ok(HARNESS_HTML.includes("case 'reset':"), '事件分发应处理 reset');
  assert.ok(/function resetConversation\s*\(/.test(HARNESS_HTML), '应有 resetConversation');
});

test('resetConversation 网页模式归零 sid，API 模式切到新 session（不误删旧会话）', () => {
  const body = bodyFrom(HARNESS_HTML, 'function resetConversation(');
  assert.ok(
    /if\s*\(!apiTransportMode\)\s*currentSessionId\s*=\s*''/.test(body),
    '网页模式仍必须归零 currentSessionId，否则随后的 session-changed 会 loadHist() 把旧记录填回来'
  );
  assert.ok(body.includes('nextApiSessionId'), 'API 模式应接收主进程新建的 sessionId');
  assert.ok(body.includes('saveHist()'), '应把空历史写入该 key，挡住后续 loadHist()');
});

test('API 新对话入口走 startNewApiSession，并把新 sessionId 传给页面 reset', () => {
  const body = bodyFrom(HARNESS_IPC, "ipcMain.handle('harness-new-conversation'", 2500);
  assert.ok(body.includes('startNewApiSession('), 'API 新对话不能再走 resetApiSession 删旧快照');
  assert.ok(/prepareNewConversation\(ctx,\s*(created|r)\.sessionId\)/.test(body), 'reset 事件必须带新 sessionId');
});

test('resetConversation 清掉各类会话级状态', () => {
  const body = bodyFrom(HARNESS_HTML, 'function resetConversation(', 3000);
  for (const [name, re] of [
    ['消息历史', /history\s*=\s*\[\]/],
    ['消息 DOM', /stream\.innerHTML\s*=\s*''/],
    ['适配流式气泡', /cur\s*=\s*null/],
    ['计划状态', /planState\s*=\s*null/],
    ['计划条目', /planBySession\[/],
    ['目标', /goal\s*=\s*null/],
  ]) {
    assert.ok(re.test(body), 'resetConversation 应清理：' + name);
  }
});

test('clearTransientState 清掉附件与提示（否则会跟到下一条消息）', () => {
  const body = bodyFrom(HARNESS_HTML, 'function clearTransientState()');
  assert.ok(/pendingFiles\s*=\s*\[\]/.test(body), '应清空待发送附件');
  assert.ok(/pendingHints\s*=\s*\[\]/.test(body), '应清空待发送提示');
  assert.ok(body.includes('renderAttach()'), '应刷新附件区');
  assert.ok(body.includes('renderHints()'), '应刷新提示区');
  assert.ok(/toolRunningCount\s*=\s*0/.test(body), '应清零工具运行计数');
});

test('onSessionChanged 也清临时状态（切换会话同样不该带附件过去）', () => {
  const body = bodyFrom(HARNESS_HTML, 'function onSessionChanged');
  assert.ok(body.includes('clearTransientState()'), '切换会话时应清理临时状态');
});

// ===== 主进程：两条入口共用同一段逻辑 =====

test('主进程发送独立的 reset 事件（不复用 session-changed）', () => {
  assert.ok(/function notifyHarnessReset\s*\(/.test(HARNESS_IPC), '应有 notifyHarnessReset');
  const body = bodyFrom(HARNESS_IPC, 'function notifyHarnessReset');
  assert.ok(body.includes("type: 'reset'"), '应发送 type: reset');
});

test('harness 自己的新对话入口调用公共重置', () => {
  const body = bodyFrom(HARNESS_IPC, "ipcMain.handle('harness-new-conversation'");
  assert.ok(body.includes('prepareNewConversation('), 'harness-new-conversation 应调 prepareNewConversation');
});

test('壳页面侧栏的新对话入口也调用公共重置（曾经完全没通知 harness）', () => {
  const body = bodyFrom(SHELL_IPC, "ipcMain.handle('web-new-conversation'");
  assert.ok(
    body.includes('prepareNewConversation('),
    'web-new-conversation 必须也重置 harness —— 这里曾只做 loadURL，导致新对话后满屏残留'
  );
  assert.ok(SHELL_IPC.includes("from './harness.js'"), '应从 harness.ts 复用同一段逻辑');
});

test('API 项目新对话写目录后必须推送 harness 状态', () => {
  const body = bodyFrom(SESSION_IPC, 'async function startNewConversationForProject', 6000);
  assert.ok(
    body.includes('pushHarnessState(ctx)'),
    'initProject 写目录后必须推 needInit=false，否则输入框仍被“首次选择项目”挡住'
  );
});

test('API 壳侧新对话也推送 harness 状态', () => {
  const body = bodyFrom(SHELL_IPC, "ipcMain.handle('web-new-conversation'");
  assert.ok(body.includes('pushHarnessState(ctx)'), 'API 分支 reset 后应同步最新 needInit');
});

test('API 多会话 IPC/preload 已接通', () => {
  for (const ch of ['harness-api-sessions', 'harness-api-session-select', 'harness-api-session-delete']) {
    assert.ok(HARNESS_IPC.includes("ipcMain.handle('" + ch + "'"), '缺少 IPC: ' + ch);
  }
  assert.ok(HARNESS_PRELOAD.includes('listApiSessions:'), 'preload 应暴露 listApiSessions');
  assert.ok(HARNESS_PRELOAD.includes('selectApiSession:'), 'preload 应暴露 selectApiSession');
  assert.ok(HARNESS_PRELOAD.includes('deleteApiSession:'), 'preload 应暴露 deleteApiSession');
  assert.ok(HARNESS_PRELOAD.includes('sendMessage: (text: string, requestId?: string, files?: any[], displayText?: string)'), '发送应支持 displayText');
  assert.ok(ENTRY.includes('apiSessionId'), 'session-changed 应带 apiSessionId');
  assert.ok(HARNESS_IPC.includes('getActiveApiSessionId'), 'ready 补发事件应带 active session');
});

test('prepareNewConversation 同时清 todo 缓存并通知重置', () => {
  const body = bodyFrom(HARNESS_IPC, 'function prepareNewConversation');
  assert.ok(body.includes('resetTodosCache()'), '应清主进程侧 todo 缓存');
  assert.ok(body.includes('notifyHarnessReset('), '应通知 harness 重置');
});
