'use strict';
/**
 * shell.html 插件页的样式安全检查
 *
 * 背景：插件市场页曾出现"看不到按钮"——
 * 按钮被包进了 .ck-snip-actions（snippet 卡片的"悬停才显形"样式：
 * opacity:0 + pointer-events:none，且显示规则绑定 .ck-snip-item:hover），
 * 卡片本身是别的类，选择器不匹配 → 按钮永远不可见也点不到。
 *
 * 这类 bug 靠肉眼很难发现（语法、类型、单测全绿），所以固化成检查：
 * **市场区段用到的每个 class，其基础 CSS 规则都不得隐藏元素。**
 *
 * 2026-10 市场页：浏览 + 管理（已安装 / 自动更新）并存，类名 ck-mkt-*。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SHELL = path.join(import.meta.dirname, '../../src/ui/shell.html');

function readShell() {
  return fs.readFileSync(SHELL, 'utf-8');
}

/** 截取市场 JS 区段（编译进 bundle，用函数锚点定位） */
function marketSection(html) {
  const start = html.indexOf('function marketCardHtml');
  const end = html.indexOf('document.getElementById("plugin-upload-guide")');
  assert.ok(start > 0, '未找到「marketCardHtml」锚点，测试需要同步更新');
  assert.ok(end > start, '未找到「plugin-upload-guide」锚点，测试需要同步更新');
  return html.slice(start, end);
}

/** 区块自身的基础规则体（不含 :hover / 后代选择器） */
function baseRuleBodies(css, className) {
  const re = new RegExp('\\.' + className + '\\s*\\{[^}]*\\}', 'g');
  return css.match(re) || [];
}

test('shell.html 存在且可读', () => {
  const html = readShell();
  assert.ok(html.length > 10000, 'shell.html 内容异常');
  assert.ok(html.includes('cuckoo-plugin'), '市场区应标出唯一搜索源');
});

test('市场区段不复用 snippet 的悬停类（回归防护）', () => {
  const seg = marketSection(readShell());
  assert.ok(!seg.includes('ck-snip-actions'), '市场卡片不得使用 .ck-snip-actions（会永远不可见）');
  assert.ok(seg.includes('ck-mkt-card'), '市场卡片应用常驻可见的 .ck-mkt-card');
});

test('市场区段用到的每个 class，基础规则都不隐藏元素', () => {
  const html = readShell();
  const seg = marketSection(html);

  const classes = Array.from(new Set(seg.match(/ck-mkt-[a-z0-9-]+/g) || []));
  assert.ok(classes.length > 3, '未从市场区段解析出 class，选择器可能已变');

  const offenders = [];
  for (const c of classes) {
    for (const body of baseRuleBodies(html, c)) {
      if (/opacity:\\s*0(?!\\.)/.test(body) || /pointer-events:\\s*none/.test(body)) {
        offenders.push('.' + c + ' → ' + body.replace(/\\s+/g, ' '));
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    '市场区段用到了"悬停才显形"的 class，元素会不可见也点不到：\\n  ' + offenders.join('\\n  ')
  );
});

test('市场区段的关键 class 都在 CSS 里有定义', () => {
  const html = readShell();
  const required = [
    'ck-mkt-grid',
    'ck-mkt-card',
    'ck-mkt-cover',
    'ck-mkt-body',
    'ck-mkt-name',
    'ck-mkt-desc',
    'ck-mkt-meta',
    'ck-mkt-cat',
    'ck-mkt-badge',
  ];
  for (const c of required) {
    assert.ok(new RegExp('\\.' + c + '\\s*\\{').test(html), '缺少样式定义：.' + c);
  }
});

test('市场页同时具备浏览与管理（B 方案）', () => {
  const html = readShell();
  // 浏览：列表 + 搜索 + 详情
  assert.ok(html.includes('id="plugin-market-list"'), '缺少市场列表容器');
  assert.ok(html.includes('id="plugin-market-search"'), '缺少搜索框');
  assert.ok(html.includes('id="plugin-detail-mask"'), '缺少详情弹窗');
  // 管理：已安装 + 自动更新
  assert.ok(html.includes('id="plugin-installed-list"'), '缺少已安装列表');
  assert.ok(html.includes('id="plugin-auto-update"'), '缺少自动更新开关');
  assert.ok(html.includes('id="plugin-check-updates"'), '缺少检查更新按钮');
});

test('活动栏用购物袋图标标市场', () => {
  const html = readShell();
  const m = html.match(/data-tab="plugins"[\s\S]{0,400}?<\/button>/);
  assert.ok(m, '未找到市场活动栏按钮');
  assert.ok(m[0].includes('M6 2 3 6v14'), '市场图标应为购物袋（shopping-bag）');
});
