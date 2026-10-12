'use strict';
/**
 * 全局统一自定义 Tooltip 守卫测试
 *
 * 目标：彻底消灭浏览器原生 title，全项目统一使用高质感、防溢出、自适应快捷键的自定义 Tooltip。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SHELL_HTML = path.join(import.meta.dirname, '../../src/ui/shell.html');
const HARNESS_HTML = path.join(import.meta.dirname, '../../src/ui/harness.html');
const PLATFORM_HTML = path.join(import.meta.dirname, '../../src/ui/platform-select.html');
const TOOLTIP_TS = path.join(import.meta.dirname, '../../src/ui/shell/scripts/tooltip.ts');

test('shell.html 包含全局统一自定义 Tooltip 样式与打包逻辑', () => {
  const shell = fs.readFileSync(SHELL_HTML, 'utf8');
  assert.ok(shell.includes('.ck-tooltip'), 'shell.html 应包含 .ck-tooltip 样式');
  assert.ok(shell.includes('.ck-tooltip-kbd'), 'shell.html 应包含 .ck-tooltip-kbd 样式');
  assert.ok(shell.includes('initGlobalTooltip'), 'shell.html 应打包 initGlobalTooltip');
  assert.ok(/removeAttribute\(['"]title['"]\)/.test(shell), 'shell.html 应包含拦截并清除原生 title 逻辑');
});

test('harness.html 纯净模式包含自定义 Tooltip 样式与初始化引擎', () => {
  const harness = fs.readFileSync(HARNESS_HTML, 'utf8');
  assert.ok(harness.includes('.ck-tooltip {'), 'harness.html 应包含 .ck-tooltip 样式');
  assert.ok(harness.includes('.ck-tooltip-kbd {'), 'harness.html 应包含 .ck-tooltip-kbd 样式');
  assert.ok(harness.includes('initHarnessTooltip'), 'harness.html 应包含 initHarnessTooltip 引擎');
  assert.ok(harness.includes("removeAttribute('title')"), 'harness.html 应包含拦截原生 title 逻辑');
});

test('platform-select.html 平台选择页包含自定义 Tooltip 样式与引擎', () => {
  const platform = fs.readFileSync(PLATFORM_HTML, 'utf8');
  assert.ok(platform.includes('.ck-tooltip {'), 'platform-select.html 应包含 .ck-tooltip 样式');
  assert.ok(platform.includes("removeAttribute('title')"), 'platform-select.html 应包含拦截原生 title 逻辑');
});

test('tooltip.ts 具备防溢出与快捷键标签识别', () => {
  const src = fs.readFileSync(TOOLTIP_TS, 'utf8');
  // 视口安全边界保护
  assert.ok(src.includes('window.innerWidth - 8'), '应有水平右边界防溢出保护');
  assert.ok(src.includes('window.innerHeight - 8'), '应有垂直下边界翻转保护');
  // 快捷键解析
  assert.ok(src.includes('ck-tooltip-kbd'), '应将快捷键渲染为 ck-tooltip-kbd');
  // 逃生与失焦关闭
  assert.ok(src.includes("e.key === 'Escape'"), 'Esc 键应隐藏 tooltip');
  assert.ok(src.includes("'blur'"), '失焦应隐藏 tooltip');
});
