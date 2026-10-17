'use strict';
/**
 * sanitizer 安全决策测试（纯函数 + 手写 mock DOM 节点树）。
 * 不依赖 jsdom：walkAndSanitize 只依赖最小节点接口，这里用 mock 驱动遍历。
 */
import { test } from 'vitest';
import assert from 'node:assert';
import {
  escapeHtml,
  escapeAttr,
  isAllowedTag,
  isAllowedAttribute,
  isSafeUrl,
  walkAndSanitize,
} from '../../src/overlay/sanitizer.js';

// ========== 转义 ==========

test('escapeHtml 转义 & < > " \'', () => {
  assert.strictEqual(escapeHtml(`<&>"'`), `&lt;&amp;&gt;&quot;&#39;`);
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml('a<b'), 'a&lt;b');
});

test('escapeAttr 与 escapeHtml 等价', () => {
  assert.strictEqual(escapeAttr('"on"'), escapeHtml('"on"'));
});

// ========== 标签/属性白名单 ==========

test('标签白名单：危险标签拒绝、常规标签放行', () => {
  assert.strictEqual(isAllowedTag('SCRIPT'), false);
  assert.strictEqual(isAllowedTag('iframe'), false);
  assert.strictEqual(isAllowedTag('SVG'), false);
  assert.strictEqual(isAllowedTag('FORM'), false);
  assert.strictEqual(isAllowedTag('p'), true);
  assert.strictEqual(isAllowedTag('DIV'), true);
  assert.strictEqual(isAllowedTag('img'), true);
  assert.strictEqual(isAllowedTag('input'), true);
});

test('属性白名单：on* 一律拒绝，aria-/data- 放行', () => {
  assert.strictEqual(isAllowedAttribute('DIV', 'onclick'), false);
  assert.strictEqual(isAllowedAttribute('DIV', 'ONLOAD'), false);
  assert.strictEqual(isAllowedAttribute('DIV', 'class'), true);
  assert.strictEqual(isAllowedAttribute('DIV', 'aria-label'), true);
  assert.strictEqual(isAllowedAttribute('DIV', 'data-x'), true);
  assert.strictEqual(isAllowedAttribute('DIV', 'style'), false);
  assert.strictEqual(isAllowedAttribute('INPUT', 'type'), true);
  assert.strictEqual(isAllowedAttribute('INPUT', 'onclick'), false);
  assert.strictEqual(isAllowedAttribute('INPUT', 'value'), false);
});

// ========== URL 协议过滤 ==========

test('isSafeUrl：危险协议拒绝，安全形式放行', () => {
  assert.strictEqual(isSafeUrl('javascript:alert(1)'), false);
  assert.strictEqual(isSafeUrl('JaVaScRiPt:alert(1)'), false);
  assert.strictEqual(isSafeUrl('data:text/html,x'), false);
  assert.strictEqual(isSafeUrl('vbscript:msgbox'), false);
  assert.strictEqual(isSafeUrl('blob:uuid'), false);
  assert.strictEqual(isSafeUrl('//evil.com/x'), false);
  assert.strictEqual(isSafeUrl('https://ok.com/a'), true);
  assert.strictEqual(isSafeUrl('http://ok.com/a'), true);
  assert.strictEqual(isSafeUrl('mailto:a@b.com'), true);
  assert.strictEqual(isSafeUrl('#section'), true);
  assert.strictEqual(isSafeUrl('/relative/path'), true);
  assert.strictEqual(isSafeUrl('relative/path.html'), true);
  assert.strictEqual(isSafeUrl(''), false);
});

// ========== mock DOM 遍历 ==========

/** 构造一个 mock 元素节点。attrs: [[name, value], ...] */
function el(tag, attrs = [], children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    _attrs: {},
    _removed: false,
  };
  for (const [name, value] of attrs) node._attrs[name.toLowerCase()] = String(value);
  node.getAttribute = (name) => (name.toLowerCase() in node._attrs ? node._attrs[name.toLowerCase()] : null);
  node.setAttribute = (name, value) => { node._attrs[name.toLowerCase()] = String(value); };
  node.removeAttribute = (name) => { delete node._attrs[name.toLowerCase()]; };
  Object.defineProperty(node, 'attributes', {
    get: () => Object.entries(node._attrs).map(([name, value]) => ({ name, value })),
  });
  node.remove = () => { node._removed = true; };
  return node;
}
/** 文本节点（nodeType=3），遍历时原样保留 */
function textNode(text) {
  return { nodeType: 3, textContent: text, childNodes: [] };
}
/** 文档片段根（nodeType=11） */
function fragment(children) {
  return { nodeType: 11, childNodes: children };
}

test('遍历：script/iframe 整棵移除，img onerror 剥离', () => {
  const script = el('script', [], [textNode('alert(1)')]);
  const iframe = el('iframe', [['src', 'https://x']]);
  const img = el('img', [['src', 'a.png'], ['onerror', 'alert(1)'], ['alt', 'pic']]);
  const root = fragment([script, iframe, img]);
  walkAndSanitize(root);

  assert.strictEqual(script._removed, true);
  assert.strictEqual(iframe._removed, true);
  assert.strictEqual(img.getAttribute('onerror'), null);
  assert.strictEqual(img.getAttribute('src'), 'a.png');
  assert.strictEqual(img.getAttribute('alt'), 'pic');
});

test('遍历：javascript: href 清除，外链 a 注入 rel/target', () => {
  const badA = el('a', [['href', 'javascript:alert(1)'], ['class', 'x']]);
  const goodA = el('a', [['href', 'https://example.com']]);
  const root = fragment([badA, goodA]);
  walkAndSanitize(root);

  assert.strictEqual(badA.getAttribute('href'), null);
  assert.strictEqual(badA.getAttribute('class'), 'x');
  assert.strictEqual(goodA.getAttribute('href'), 'https://example.com');
  assert.strictEqual(goodA.getAttribute('rel'), 'nofollow noopener');
  assert.strictEqual(goodA.getAttribute('target'), '_blank');
});

test('遍历：onclick 剥离，class/aria 保留，危险 input 移除', () => {
  const div = el('div', [['class', 'c'], ['onclick', 'x()'], ['aria-label', 'l']]);
  const badInput = el('input', [['type', 'text']]);
  const cb = el('input', [['type', 'checkbox'], ['checked', '']]);
  const root = fragment([div, badInput, cb]);
  walkAndSanitize(root);

  assert.strictEqual(div.getAttribute('onclick'), null);
  assert.strictEqual(div.getAttribute('class'), 'c');
  assert.strictEqual(div.getAttribute('aria-label'), 'l');
  assert.strictEqual(badInput._removed, true);
  assert.strictEqual(cb._removed, false);
});

test('遍历：正常表格/代码块/数学占位纯文本保留（KaTeX 管线顺序）', () => {
  // marked 输出 <p>@@MATH0@@</p>：p 放行，占位文本节点原样存活
  const p = el('p', [], [textNode('@@MATH0@@')]);
  const table = el('table', [], [
    el('thead', [], [el('tr', [], [el('th', [], [textNode('h')])])]),
  ]);
  const code = el('pre', [], [el('code', [], [textNode('code')])]);
  const root = fragment([p, table, code]);
  walkAndSanitize(root);

  assert.strictEqual(p._removed, false);
  assert.strictEqual(p.childNodes[0].textContent, '@@MATH0@@');
  assert.strictEqual(table._removed, false);
  assert.strictEqual(code._removed, false);
});
