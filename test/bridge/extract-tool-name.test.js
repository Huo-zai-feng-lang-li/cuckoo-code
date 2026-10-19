'use strict';
/**
 * extractFirstToolName：从工具脚本里提取首个工具名（供远程显示"正在执行：bash"）。
 * 纯函数，直接 import 测。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import { extractFirstToolName } from '../../src/bridge/parser/js-detector.js';

test('extractFirstToolName 识别内置工具', () => {
  assert.strictEqual(extractFirstToolName('await bash({ command: "ls" })'), 'bash');
  assert.strictEqual(extractFirstToolName('await read({ path: "a.txt" })'), 'read');
  assert.strictEqual(extractFirstToolName('const x = await write({ path: "b", content: "c" })'), 'write');
  assert.strictEqual(extractFirstToolName('await todoWrite({ todos: [] })'), 'todoWrite');
});

test('extractFirstToolName 识别 readLines 优先于 read', () => {
  // 正则交替顺序必须让 readLines 先匹配，否则 "read" 会截断 "readLines"
  assert.strictEqual(extractFirstToolName('await readLines({ path: "a" })'), 'readLines');
});

test('extractFirstToolName 识别 MCP 工具', () => {
  assert.strictEqual(extractFirstToolName('await mcpCall("srv", "tool", {})'), 'mcpCall');
  assert.strictEqual(extractFirstToolName('await mcpGithubSearch({ q: "x" })'), 'mcpGithubSearch');
});

test('extractFirstToolName 识别 log(await xxx( 包裹', () => {
  assert.strictEqual(extractFirstToolName('log(await someCustomTool({}))'), 'someCustomTool');
});

test('extractFirstToolName 取首个工具（多工具脚本）', () => {
  const code = 'await bash({ command: "ls" });\nawait read({ path: "a" });';
  assert.strictEqual(extractFirstToolName(code), 'bash');
});

test('extractFirstToolName 无工具调用 → 空串（调用方退化为通用文案）', () => {
  assert.strictEqual(extractFirstToolName('const a = 1 + 2;'), '');
  assert.strictEqual(extractFirstToolName(''), '');
  assert.strictEqual(extractFirstToolName(null), '');
  assert.strictEqual(extractFirstToolName(undefined), '');
});

test('extractFirstToolName 不误判普通函数调用', () => {
  // 无 await 的普通函数调用不是工具
  assert.strictEqual(extractFirstToolName('fs.readFile("a")'), '');
  assert.strictEqual(extractFirstToolName('console.log("hi")'), '');
});
