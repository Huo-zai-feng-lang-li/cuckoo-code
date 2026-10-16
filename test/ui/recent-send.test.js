'use strict';
/**
 * 底栏「最近」快捷方式：点击后只回显到输入框，不自动发送（留给用户确认后再发）。
 * 注：技能/MCP/子代理/提示词统一 autoSend=false；发送由用户按 Enter 触发。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SHELL_HTML = path.join(import.meta.dirname, '../../src/ui/shell.html');
const HARNESS_HTML = path.join(import.meta.dirname, '../../src/ui/harness.html');
const SNIPPETS_TS = path.join(import.meta.dirname, '../../src/app/ipc/snippets.ts');
const PRELOAD_TS = path.join(import.meta.dirname, '../../src/app/harness-preload.ts');

test('底栏快捷方式点击 → triggerSnippet(autoSend=false) 只填入不发送', () => {
  const shell = fs.readFileSync(SHELL_HTML, 'utf8');
  // 非 snippet 类（技能/MCP/子代理）点击应走 triggerSnippet 且 autoSend=false（只回显）
  assert.ok(shell.includes('await api.triggerSnippet(snippetText(type, name), false)'), '底栏快捷方式应以 autoSend=false 只填入输入框');
  // snippet 类同样只填入
  assert.ok(shell.includes('await api.triggerSnippet(it.payload, false)'), '底栏提示词快捷方式应以 autoSend=false 只填入');
  // 不应再以 autoSend=true 触发（防止回归到"点击即发送"）
  assert.ok(!shell.includes('await api.triggerSnippet(snippetText(type, name), true)'), '不应再自动发送');
});

test('纯净模式 trigger-snippet 透传 autoSend 给 harness', () => {
  const src = fs.readFileSync(SNIPPETS_TS, 'utf8');
  assert.ok(/harness-append-input['"],\s*\{\s*text:\s*content,\s*autoSend/.test(src), '纯净模式应透传 autoSend');
});

test('harness-preload onAppendInput 传递 autoSend', () => {
  const src = fs.readFileSync(PRELOAD_TS, 'utf8');
  assert.ok(/cb\(\(d && d\.text\) \|\| ''\s*,\s*!!\(d && d\.autoSend\)\)/.test(src), 'onAppendInput 应回传 autoSend');
});

test('harness appendToInput 支持 autoSend（忙时入队、空闲发送）', () => {
  const html = fs.readFileSync(HARNESS_HTML, 'utf8');
  assert.ok(/function appendToInput\(text, autoSend\)/.test(html), 'appendToInput 应接收 autoSend');
  assert.ok(/if \(isBusy\(\)\) \{ tryEnqueue\(\); \} else \{ send\(\); \}/.test(html), 'autoSend 时应忙入队/空闲发送');
});
