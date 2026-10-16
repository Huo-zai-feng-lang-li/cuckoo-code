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
  assert.ok(/implicit && \(isIconLike\(el\) \|\| isClipped\(el\)\)/.test(src), '原生 title 应在图标型或裁剪时作为提示');
  assert.ok(/function isIconLike\(/.test(src), '应有 isIconLike 判定（图标/极短缩写应展示）');
  // data-tooltip 显式声明仍优先、总是展示
  assert.ok(src.includes("getAttribute('data-tooltip')"), 'data-tooltip 显式声明应始终被读取');

  // harness 内联版同样具备裁剪判定
  const harness = fs.readFileSync(HARNESS_HTML, 'utf8');
  assert.ok(/function isClipped\(el\)/.test(harness), 'harness 内联版应有 isClipped');
  // platform-select 同样
  const platform = fs.readFileSync(PLATFORM_HTML, 'utf8');
  assert.ok(/function isClipped\(el\)/.test(platform), 'platform-select 版应有 isClipped');
});

test('tooltip 独立窗口具备防溢出与快捷键标签识别', () => {
  // 边界判定/定位已移至主进程 tooltip-window.ts（壳页面内 tooltip 会被 AI 视图遮挡）
  const winSrc = fs.readFileSync(path.join(import.meta.dirname, '../../src/app/tooltip-window.ts'), 'utf8');
  assert.ok(winSrc.includes('EDGE'), '主进程定位应有屏幕边缘留白常量');
  assert.ok(/wa\.x \+ wa\.width - EDGE/.test(winSrc), '应有水平右边界防溢出保护');
  assert.ok(/y \+ contentH > wa\.y \+ wa\.height/.test(winSrc), '应有垂直下边界翻转保护');
  // 快捷键解析：渲染在 tooltip.html（独立窗口页面）
  const html = fs.readFileSync(path.join(import.meta.dirname, '../../src/ui/tooltip.html'), 'utf8');
  assert.ok(html.includes('kbd'), '应将快捷键渲染为 kbd 徽标');
  // tooltip.ts 仍负责逃生/失焦关闭
  const src = fs.readFileSync(TOOLTIP_TS, 'utf8');
  assert.ok(src.includes("e.key === 'Escape'"), 'Esc 键应隐藏 tooltip');
  assert.ok(src.includes("'blur'"), '失焦应隐藏 tooltip');
});
