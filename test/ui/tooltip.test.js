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

test('原生 title 仅在内容被裁剪时才弹提示（data-tooltip 显式声明总是展示）', () => {
  const src = fs.readFileSync(TOOLTIP_TS, 'utf8');
  // 溢出判定函数
  assert.ok(/function isClipped\(/.test(src), '应有 isClipped 溢出判定函数');
  assert.ok(/scrollWidth > .*clientWidth/.test(src), 'isClipped 应用 scrollWidth/clientWidth 判定');
  // 原生 title 转存为 data-ck-title，且只在裁剪时展示
  assert.ok(src.includes("setAttribute('data-ck-title'"), '原生 title 应转存为 data-ck-title');
  assert.ok(/if \(implicit && isClipped\(el\)\) text = implicit/.test(src), '原生 title 应仅在裁剪时作为提示');
  // data-tooltip 显式声明仍优先、总是展示
  assert.ok(src.includes("getAttribute('data-tooltip')"), 'data-tooltip 显式声明应始终被读取');

  // harness 内联版同样具备裁剪判定
  const harness = fs.readFileSync(HARNESS_HTML, 'utf8');
  assert.ok(/function isClipped\(el\)/.test(harness), 'harness 内联版应有 isClipped');
  // platform-select 同样
  const platform = fs.readFileSync(PLATFORM_HTML, 'utf8');
  assert.ok(/function isClipped\(el\)/.test(platform), 'platform-select 版应有 isClipped');
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
