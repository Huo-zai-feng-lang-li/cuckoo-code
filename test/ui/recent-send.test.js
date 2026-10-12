'use strict';
/**
 * 底栏「最近」快捷方式：点击后回显到输入框并直接发送（而非只回显等手动发送）。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SHELL_HTML = path.join(import.meta.dirname, '../../src/ui/shell.html');
const HARNESS_HTML = path.join(import.meta.dirname, '../../src/ui/harness.html');
const SNIPPETS_TS = path.join(import.meta.dirname, '../../src/app/ipc/snippets.ts');
const PRELOAD_TS = path.join(import.meta.dirname, '../../src/app/harness-preload.ts');

test('底栏快捷方式点击 → triggerSnippet(autoSend=true) 直接发送', () => {
  const shell = fs.readFileSync(SHELL_HTML, 'utf8');
  // 非 snippet 类（技能/MCP/子代理）点击应走 triggerSnippet 且 autoSend=true
  assert.ok(shell.includes('await api.triggerSnippet(snippetText(type, name), true)'), '底栏快捷方式应以 autoSend=true 触发发送');
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
