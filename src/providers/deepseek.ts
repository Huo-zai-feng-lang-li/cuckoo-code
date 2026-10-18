/**
 * DeepSeek Provider 定义
 * 包含主进程和 preload 都需要的信息：
 * - 主进程：homeUrl（打开窗口）、sessionUrlBase（导航到会话）
 * - preload：输入框/发送按钮选择器、用户信息选择器、首页判断正则
 */

import { DEEPSEEK_HOOK } from './generated/hook-sources.js';

const deepseek = {
  id: 'deepseek',
  name: 'DeepSeek',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://chat.deepseek.com/',
  sessionUrlBase: 'https://chat.deepseek.com/a/chat/s/',

  // 查找可见的聊天输入框
  findInput() {
    const selectors = [
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="输入消息"]',
      'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="提问"]',
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="send"]',
      'textarea[placeholder*="deepseek"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea.chat-input',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (this.isElementVisible(el)) return el;
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      'button[type="submit"]',
      'button[aria-label*="send"]',
      'button[aria-label*="发送"]',
      'button[title*="send"]',
      'button[title*="发送"]',
      'button[data-action="send"]',
      'button[data-type="send"]',
      '.send-btn',
      '.submit-btn',
      'button svg[data-icon="send"]',
      '[data-testid="send"]',
      '[data-testid="send-button"]',
      'button:has(svg[data-icon="arrow"])',
      // B-010：收窄兜底——必须带 aria-label，避免误点到任意含 svg 的按钮（新对话/分享/收藏）
      'button[aria-label]:has(> svg)',
    ];
    for (const sel of selectors) {
      try {
        const btn = document.querySelector(sel) as any;
        if (this.isElementVisible(btn) && !btn.disabled) return btn;
      } catch (_) {}
    }
    return null;
  },

  // 提取当前用户信息文本（脱敏手机号/微信昵称）
  extractUserInfo() {
    const el = document.querySelector('._9d8da05');
    return el ? el.textContent.trim() : '';
  },

  // 首页判断正则（用于覆盖层首页模式）
  homeUrlPattern: /^https:\/\/chat\.deepseek\.com\/?(\?.*)?$/,

  // 从 URL 提取会话 ID
  extractSessionId(url: string): string | null {
    if (!url) return null;
    const match = url.match(/\/chat\/s\/([a-f0-9-]+)/i);
    if (match) return match[1];
    const altMatch = url.match(/\/s\/([a-f0-9-]+)/i);
    return altMatch ? altMatch[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url: string) {
    return url.includes('chat.deepseek.com');
  },

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el: any) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 返回注入主世界的网络拦截器源码（拦截模式使用）
  // 源码由 scripts/build-hooks.mjs 从 hooks/deepseek.ts 打包生成（自包含 IIFE）
  getHookSource() {
    return DEEPSEEK_HOOK;
  },

  /**
   * 精确定位「停止生成」按钮（供 harness stopGeneration 使用）。
   *
   * DeepSeek 输入区主按钮是同一个元素：生成中显示方块图标（可停止），
   * 空闲时显示箭头图标（= 发送按钮）。若不加区分地点击，空闲时会**误发消息**。
   *
   * 判据（真机取证 2026-10-18）：
   *   方块：<path d="M2 4.88C2 3.68...">
   *   箭头：<path d="M8.3125 0.980206...">
   *
   * 因此只在确认为「生成中」时才返回坐标；空闲/找不到一律 found: false。
   * 必须自包含：被序列化后注入页面主世界执行。
   */
  getStopFn() {
    return function (doc: any, win: any) {
      try {
        var vh = win.innerHeight || 800;
        var vw = win.innerWidth || 1200;
        var cands = doc.querySelectorAll('.ds-button--primary, button[class*="ds-button--primary"]');
        for (var i = 0; i < cands.length; i++) {
          var el = cands[i];
          if (!el) continue;
          var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!rect || rect.width === 0 || rect.height === 0) continue;
          if (rect.left < 0 || rect.top < 0 || rect.left > vw || rect.top > vh) continue;
          // 判断图标：方块（停止）vs 箭头（发送）
          var pathEl = el.querySelector ? el.querySelector('svg path') : null;
          var d = pathEl && pathEl.getAttribute ? (pathEl.getAttribute('d') || '') : '';
          var isSquare = d.indexOf('M2 4.88') !== -1;
          var isArrow = d.indexOf('M8.3125') !== -1;
          if (!isSquare && !isArrow) continue;
          if (isArrow) {
            // 空闲态：这是发送按钮，绝不能点
            return { found: false, generating: false, reason: 'idle-arrow' };
          }
          var cx = Math.round(rect.left + rect.width / 2);
          var cy = Math.round(rect.top + rect.height / 2);
          return { found: true, generating: true, x: cx, y: cy, tag: 'DIV.ds-button--primary(square)' };
        }
        return { found: false, generating: false, reason: 'no-primary-button' };
      } catch (e) {
        // 执行出错不表态（generating: null），避免上层误判为"已停止"
        return { found: false, generating: null, reason: 'error:' + String(e) };
      }
    };
  },
};

export { deepseek };
