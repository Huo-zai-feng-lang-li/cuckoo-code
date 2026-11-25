'use strict';
/**
 * API 模式壳页面工具栏守卫。
 *
 * 背景：API transport 窗口没有真实网页，壳页面会隐藏后退/前进/刷新/地址栏/外开/网页模式开关。
 * 但 toolbar 里前后两个 divider 不会跟着消失，二者之间只剩下 display:none 的按钮，
 * 视觉上就是两根紧挨着的竖线（用户实测截图 370x46）。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SHELL_HTML = path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell.html');
const BASE_CSS = path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'shell', 'styles', 'base.css');
const html = fs.readFileSync(SHELL_HTML, 'utf8');
const css = fs.readFileSync(BASE_CSS, 'utf8');

test('API 模式隐藏网页导航后只保留一个工具栏分隔线', () => {
  const rule = 'body.ck-api-mode #btn-theme-toggle + .divider { display: none !important; }';
  assert.ok(css.includes(rule), 'base.css 应隐藏主题按钮后的第一个 divider');
  assert.ok(html.includes(rule), 'shell.html 生成产物应包含该规则');
  // 网页导航本身仍必须隐藏，避免 API 模式出现可点的无效后退/刷新
  assert.ok(css.includes('body.ck-api-mode #btn-back'), 'API 模式应继续隐藏后退按钮');
});
