'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { deepseek } from '../../src/providers/deepseek.js';

test('deepseek: matchesUrl 正确匹配 deepseek 域名', () => {
  assert.strictEqual(deepseek.matchesUrl('https://chat.deepseek.com/'), true);
  assert.strictEqual(deepseek.matchesUrl('https://chat.deepseek.com/a/chat/s/12345'), true);
  assert.strictEqual(deepseek.matchesUrl('https://claude.ai/'), false);
});

test('deepseek.findSendButton: 拒绝上传文件按钮（含 input[type=file]）', () => {
  const origDoc = globalThis.document;
  globalThis.document = { body: {}, querySelectorAll: () => [] };
  try {
    const fileInput = { tagName: 'INPUT', type: 'file' };
    const uploadBtn = {
      tagName: 'BUTTON',
      offsetWidth: 40,
      offsetHeight: 40,
      disabled: false,
      getAttribute: (attr) => (attr === 'aria-label' ? '上传附件' : null),
      querySelector: (sel) => (sel === 'input[type="file"]' ? fileInput : (sel === 'svg' ? {} : null)),
      querySelectorAll: () => [],
    };
    const sendBtn = {
      tagName: 'BUTTON',
      offsetWidth: 40,
      offsetHeight: 40,
      disabled: false,
      getAttribute: (attr) => (attr === 'aria-label' ? '发送' : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const inputArea = {
      tagName: 'TEXTAREA',
      parentElement: {
        querySelector: (sel) => (sel.includes('发送') ? sendBtn : null),
        querySelectorAll: () => [uploadBtn, sendBtn],
      },
    };

    const found = deepseek.findSendButton(inputArea);
    assert.strictEqual(found, sendBtn, '必须精准选中发送按钮，严禁误选上传附件按钮');
  } finally {
    globalThis.document = origDoc;
  }
});

test('deepseek.findSendButton: 即使无显式发送文字，也坚决排除回形针/上传按钮', () => {
  const origDoc = globalThis.document;
  globalThis.document = { body: {}, querySelectorAll: () => [] };
  try {
    const uploadBtn = {
      tagName: 'BUTTON',
      offsetWidth: 40,
      offsetHeight: 40,
      disabled: false,
      getAttribute: (attr) => (attr === 'aria-label' ? '上传附件' : null),
      querySelector: (sel) => (sel === 'svg' ? { getAttribute: () => 'paperclip' } : null),
    };
    const svgSendBtn = {
      tagName: 'BUTTON',
      offsetWidth: 40,
      offsetHeight: 40,
      disabled: false,
      getAttribute: () => null,
      querySelector: (sel) => (sel === 'svg' ? {} : null),
    };

    const inputArea = {
      tagName: 'TEXTAREA',
      parentElement: {
        querySelector: () => null,
        querySelectorAll: () => [uploadBtn, svgSendBtn],
      },
    };

    const found = deepseek.findSendButton(inputArea);
    assert.strictEqual(found, svgSendBtn, '必须排除上传附件按钮，只选中有效候选');
  } finally {
    globalThis.document = origDoc;
  }
});
