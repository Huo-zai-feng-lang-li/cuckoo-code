/**
 * 白名单 HTML sanitizer —— 全应用唯一真源。
 *
 * 设计：
 *  - 安全决策全部拆为纯函数（标签/属性白名单、事件属性判定、URL 协议过滤、rel 注入），
 *    不依赖 DOM，便于 vitest 直接断言；
 *  - DOM 遍历器 {@link walkAndSanitize} 只依赖一个极小的节点接口
 *    （nodeType/tagName/childNodes/attributes/getAttribute/setAttribute/removeAttribute/remove），
 *    真实 DOM 与手写 mock 节点树都满足，无需 jsdom；
 *  - {@link sanitizeHtml} 用 `<template>` 解析输入并就地白名单重建，绝不使用正则去 HTML。
 *
 * 安全模型：
 *  - 非白名单标签整棵移除（含 script/iframe/object/embed/link/style/meta/form/button/svg 等）；
 *  - 删除全部 on* 事件属性；
 *  - href/src 只放行 http(s)/mailto/相对路径/#锚点，删除 javascript:/data:/vbscript:/blob: 等；
 *  - <a> 强制 rel="nofollow noopener"，外链补 target="_blank"；<img> 必须有 alt；
 *  - 放行 class/id/title/colspan/rowspan/aria- 前缀/data- 前缀等无害属性。
 *
 * KaTeX 约定：本函数运行在 marked.parse 之后、KaTeX 受信 HTML 恢复之前；
 * `@@MATHn@@` 数学占位是纯文本，会被完整保留。
 */

// ========== 转义（纯函数） ==========

/**
 * 转义 HTML 文本与双引号属性中的特殊字符（& < > " '）。
 * 同时适用于内容插值与属性值（属性值用双引号包裹时，单/双引号都需转义）。
 *
 * @param input 任意输入（null/undefined → 空串）
 * @returns 转义后的安全字符串
 */
export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 属性值转义（与 {@link escapeHtml} 等价，显式命名以表属性语义）。
 * @param input 任意输入
 * @returns 转义后的安全字符串
 */
export const escapeAttr = escapeHtml;

// ========== 白名单常量 ==========

/** 允许的标签集合（统一大写比较）。 */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'INPUT', 'KBD', 'LI', 'MARK', 'OL',
  'P', 'PRE', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);

/** 全局允许的属性名（小写）。 */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'alt', 'checked', 'class', 'colspan', 'disabled', 'height', 'href', 'id',
  'rel', 'rowspan', 'src', 'target', 'title', 'type', 'width',
]);

// ========== 纯函数：安全决策 ==========

/**
 * 判断标签是否在白名单内。
 * @param tagName 标签名（大小写不敏感）
 * @returns 允许返回 true
 */
export function isAllowedTag(tagName: string): boolean {
  return ALLOWED_TAGS.has(String(tagName || '').toUpperCase());
}

/**
 * 判断属性是否放行。on* 事件属性一律拒绝；aria- 前缀与 data- 前缀放行；
 * <input> 仅放行 type/checked/disabled（任务列表 checkbox 场景）。
 *
 * @param tagName 所属标签名
 * @param attrName 属性名
 * @returns 允许返回 true
 */
export function isAllowedAttribute(tagName: string, attrName: string): boolean {
  const name = String(attrName || '').toLowerCase();
  if (!name) return false;
  if (name.startsWith('on')) return false;
  if (name.startsWith('aria-') || name.startsWith('data-')) return true;
  if (String(tagName || '').toUpperCase() === 'INPUT') {
    return name === 'type' || name === 'checked' || name === 'disabled';
  }
  return ALLOWED_ATTRS.has(name);
}

/**
 * 判断 URL 是否可用于 href/src。
 * 放行：http(s)、mailto、#锚点、无 scheme 的相对路径；
 * 拒绝：javascript:/data:/vbscript:/blob:、协议相对 //host、以及任何带未知 scheme 的 URL。
 *
 * @param raw 原始 URL 字符串
 * @returns 安全返回 true
 */
export function isSafeUrl(raw: string): boolean {
  const url = String(raw ?? '').trim();
  if (!url) return false;
  if (url.startsWith('#')) return true;
  if (url.startsWith('//')) return false; // 协议相对地址 → 视为外域
  if (/^mailto:/i.test(url)) return true;
  if (/^https?:\/\//i.test(url)) return true;
  // 其余形式：若 ':' 出现在首个 '/' 之前（或根本没有 '/'），视为带 scheme → 拒绝
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  if (colon !== -1 && (slash === -1 || colon < slash)) return false;
  return true;
}

// ========== DOM 遍历器 ==========

/**
 * sanitizer 遍历器所需的最小 DOM 节点接口。
 * 真实 DOM 节点（Element/Text/DocumentFragment）天然满足；测试用手写 mock 实现。
 */
export interface SanitizerNode {
  /** 节点类型：1=元素，3=文本，8=注释，11=文档片段。 */
  nodeType: number;
  /** 元素标签名（大写）；文本/片段无。 */
  tagName?: string;
  /** 子节点列表（数组或类数组）。 */
  childNodes: ArrayLike<SanitizerNode>;
  /** 元素属性（真实 DOM 为 NamedNodeMap；测试用 {name,value}[]）。 */
  attributes?: ArrayLike<{ name: string; value: string }>;
  /** 读取属性；无则返回 null。 */
  getAttribute?: (name: string) => string | null;
  /** 设置属性。 */
  setAttribute?: (name: string, value: string) => void;
  /** 删除属性。 */
  removeAttribute?: (name: string) => void;
  /** 从父节点移除自身（含子树）。 */
  remove?: () => void;
}

/**
 * 净化单个元素的属性：删除未放行/危险属性；href/src 过 URL 白名单；
 * <a> 强制 rel、外链 target=_blank；<img> 补 alt。
 *
 * @param el 元素节点
 * @param tag 大写标签名
 */
function sanitizeElement(el: SanitizerNode, tag: string): void {
  const attrs = Array.prototype.slice.call(el.attributes || []) as Array<{ name: string; value: string }>;
  for (const attr of attrs) {
    const name = attr.name;
    const lower = name.toLowerCase();
    if (!isAllowedAttribute(tag, name)) {
      el.removeAttribute?.(name);
      continue;
    }
    if ((lower === 'href' || lower === 'src') && !isSafeUrl(attr.value)) {
      el.removeAttribute?.(name);
    }
  }
  if (tag === 'A') {
    el.setAttribute?.('rel', 'nofollow noopener');
    const href = el.getAttribute?.('href') ?? null;
    if (href && /^https?:\/\//i.test(href)) {
      el.setAttribute?.('target', '_blank');
    }
  } else if (tag === 'IMG') {
    if ((el.getAttribute?.('alt') ?? null) == null) el.setAttribute?.('alt', '');
  }
}

/**
 * 递归遍历节点树并就地净化。
 * - 文本节点原样保留；非元素/非文本节点（注释等）移除；
 * - 非白名单标签整棵移除；
 * - 元素先净化属性再递归子节点。
 *
 * @param node 根节点（通常是 <template>.content 文档片段）
 */
export function walkAndSanitize(node: SanitizerNode): void {
  const children = Array.prototype.slice.call(node.childNodes || []) as SanitizerNode[];
  for (const child of children) {
    if (child.nodeType === 3) continue; // 文本节点安全保留
    if (child.nodeType !== 1) {
      child.remove?.();
      continue;
    }
    const tag = String(child.tagName || '').toUpperCase();
    if (!isAllowedTag(tag)) {
      child.remove?.();
      continue;
    }
    // <input> 仅允许 checkbox（任务列表），其余 input 整棵移除
    if (tag === 'INPUT' && (child.getAttribute?.('type') ?? '') !== 'checkbox') {
      child.remove?.();
      continue;
    }
    sanitizeElement(child, tag);
    walkAndSanitize(child);
  }
}

/**
 * 净化 HTML 字符串（真实 DOM 入口）。
 * 用 `<template>` 解析输入，白名单重建后返回序列化字符串。
 *
 * @param html 待净化的 HTML 字符串
 * @returns 安全的 HTML 字符串
 */
export function sanitizeHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  walkAndSanitize(template.content as unknown as SanitizerNode);
  return template.innerHTML;
}
