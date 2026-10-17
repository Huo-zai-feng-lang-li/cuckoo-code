"use strict";
var CuckooSanitize = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/overlay/sanitizer.ts
  var sanitizer_exports = {};
  __export(sanitizer_exports, {
    escapeAttr: () => escapeAttr,
    escapeHtml: () => escapeHtml,
    isAllowedAttribute: () => isAllowedAttribute,
    isAllowedTag: () => isAllowedTag,
    isSafeUrl: () => isSafeUrl,
    sanitizeHtml: () => sanitizeHtml,
    walkAndSanitize: () => walkAndSanitize
  });
  function escapeHtml(input) {
    return String(input ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  var escapeAttr = escapeHtml;
  var ALLOWED_TAGS = /* @__PURE__ */ new Set([
    "A",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DEL",
    "DIV",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "I",
    "IMG",
    "INPUT",
    "KBD",
    "LI",
    "MARK",
    "OL",
    "P",
    "PRE",
    "S",
    "SAMP",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "U",
    "UL"
  ]);
  var ALLOWED_ATTRS = /* @__PURE__ */ new Set([
    "alt",
    "checked",
    "class",
    "colspan",
    "disabled",
    "height",
    "href",
    "id",
    "rel",
    "rowspan",
    "src",
    "target",
    "title",
    "type",
    "width"
  ]);
  function isAllowedTag(tagName) {
    return ALLOWED_TAGS.has(String(tagName || "").toUpperCase());
  }
  function isAllowedAttribute(tagName, attrName) {
    const name = String(attrName || "").toLowerCase();
    if (!name) return false;
    if (name.startsWith("on")) return false;
    if (name.startsWith("aria-") || name.startsWith("data-")) return true;
    if (String(tagName || "").toUpperCase() === "INPUT") {
      return name === "type" || name === "checked" || name === "disabled";
    }
    return ALLOWED_ATTRS.has(name);
  }
  function isSafeUrl(raw) {
    const url = String(raw ?? "").trim();
    if (!url) return false;
    if (url.startsWith("#")) return true;
    if (url.startsWith("//")) return false;
    if (/^mailto:/i.test(url)) return true;
    if (/^https?:\/\//i.test(url)) return true;
    const colon = url.indexOf(":");
    const slash = url.indexOf("/");
    if (colon !== -1 && (slash === -1 || colon < slash)) return false;
    return true;
  }
  function sanitizeElement(el, tag) {
    const attrs = Array.prototype.slice.call(el.attributes || []);
    for (const attr of attrs) {
      const name = attr.name;
      const lower = name.toLowerCase();
      if (!isAllowedAttribute(tag, name)) {
        el.removeAttribute?.(name);
        continue;
      }
      if ((lower === "href" || lower === "src") && !isSafeUrl(attr.value)) {
        el.removeAttribute?.(name);
      }
    }
    if (tag === "A") {
      el.setAttribute?.("rel", "nofollow noopener");
      const href = el.getAttribute?.("href") ?? null;
      if (href && /^https?:\/\//i.test(href)) {
        el.setAttribute?.("target", "_blank");
      }
    } else if (tag === "IMG") {
      if ((el.getAttribute?.("alt") ?? null) == null) el.setAttribute?.("alt", "");
    }
  }
  function walkAndSanitize(node) {
    const children = Array.prototype.slice.call(node.childNodes || []);
    for (const child of children) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) {
        child.remove?.();
        continue;
      }
      const tag = String(child.tagName || "").toUpperCase();
      if (!isAllowedTag(tag)) {
        child.remove?.();
        continue;
      }
      if (tag === "INPUT" && (child.getAttribute?.("type") ?? "") !== "checkbox") {
        child.remove?.();
        continue;
      }
      sanitizeElement(child, tag);
      walkAndSanitize(child);
    }
  }
  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html ?? "");
    walkAndSanitize(template.content);
    return template.innerHTML;
  }
  return __toCommonJS(sanitizer_exports);
})();
;if (typeof globalThis !== "undefined") globalThis.CuckooSanitize = CuckooSanitize;
