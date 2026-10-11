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

  // 查找可见的聊天输入框（严格排除搜索框）
  findInput() {
    const isSearchElement = (el: any) => {
      if (!el) return false;
      try {
        const ph = String((typeof el.getAttribute === 'function' ? el.getAttribute('placeholder') : el.placeholder) || '').toLowerCase();
        const aria = String((typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : el.ariaLabel) || '').toLowerCase();
        if (ph.includes('搜索') || ph.includes('search') || aria.includes('搜索') || aria.includes('search')) return true;
        if (typeof el.closest === 'function' && el.closest('[role="dialog"], .modal, [class*="modal"], [class*="search"]')) return true;
      } catch (_) {}
      return false;
    };

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
        const els = document.querySelectorAll(sel);
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (this.isElementVisible(el) && !isSearchElement(el)) return el;
        }
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮（严格限制在输入框容器内或显式发送标记，严禁误选侧边栏/搜索/导航）
  findSendButton(knownInput?: any) {
    const isSafeButton = (el: any) => {
      if (!el || !this.isElementVisible(el)) return false;
      if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return false;

      // 绝对不能是文件上传 input 或内部包含文件上传 input 的元素（严防唤起系统文件管理器）
      if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file') return false;
      if (typeof el.querySelector === 'function' && el.querySelector('input[type="file"]')) {
        return false;
      }

      // 绝对不能位于侧边栏、顶部导航、模态弹窗或搜索框内
      if (typeof el.closest === 'function') {
        if (el.closest('aside, nav, [class*="sidebar"], [class*="side-bar"], [class*="nav"], header, [role="dialog"], .modal, [class*="modal"], [class*="search"]')) {
          return false;
        }
      }

      // 绝对不能包含侧边栏、折叠、菜单、搜索、新建对话、以及上传附件等功能属性
      const aria = String((typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : el.ariaLabel) || '').toLowerCase();
      const title = String((typeof el.getAttribute === 'function' ? el.getAttribute('title') : el.title) || '').toLowerCase();
      const className = String(el.className || '').toLowerCase();
      const testId = String((typeof el.getAttribute === 'function' ? el.getAttribute('data-testid') : '') || '').toLowerCase();
      const text = String(el.innerText || el.textContent || '').trim().toLowerCase();

      const forbiddenWords = [
        '搜索', 'search', '侧边栏', 'sidebar', 'menu', '菜单', 'collapse', 'expand',
        '折叠', '展开', '关闭', 'close', '新对话', '新建对话', 'new chat',
        '深度思考', '联网搜索', 'think', 'history', '历史',
        '上传', '附件', '文件', 'upload', 'attach', 'file', 'image', '图片', '语音', 'audio', 'mic', '录音', 'paperclip', 'clip'
      ];
      if (forbiddenWords.some(w => aria.includes(w) || title.includes(w) || className.includes(w) || testId.includes(w) || text.includes(w))) {
        return false;
      }

      // 检查内部 svg 是否有附件/上传相关属性
      if (typeof el.querySelector === 'function') {
        const svg = el.querySelector('svg');
        if (svg) {
          const svgAria = String(svg.getAttribute?.('aria-label') || '').toLowerCase();
          const svgClass = String(svg.getAttribute?.('class') || '').toLowerCase();
          if (forbiddenWords.some(w => svgAria.includes(w) || svgClass.includes(w))) {
            return false;
          }
        }
      }

      return true;
    };

    // 优先复用调用方已获取的 input 实例，避免每次重试循环均全量扫描 15 个输入框选择器
    const input = knownInput || this.findInput();

    // 策略 1 (最高优先级)：从输入框向上查找输入区容器，并在输入区容器内部寻找发送按钮
    if (input) {
      let cur = input.parentElement;
      for (let depth = 0; depth < 5 && cur && (typeof document === 'undefined' || !document.body || cur !== document.body); depth++) {
        // 先找带显式发送标识的元素
        const explicitSelectors = [
          'button[aria-label*="发送"]',
          'button[aria-label*="send" i]',
          'div[role="button"][aria-label*="发送"]',
          'div[role="button"][aria-label*="send" i]',
          '[data-testid*="send" i]',
          'button[type="submit"]',
          '.send-btn',
          '.submit-btn',
          '[class*="sendBtn"]',
          '[class*="send-btn"]',
          '[class*="sendButton"]',
        ];
        for (const sel of explicitSelectors) {
          const btn = cur.querySelector(sel);
          if (isSafeButton(btn)) return btn;
        }

        // 如果没有显式发送文字，从输入框容器内寻找具有发送/提交意图的可点击按钮
        // 注意：严格排除任何可能打开文件管理器或与上传关联的按钮，并从后向前查找（发送按钮通常位于右侧末端）
        const candidates = Array.from(cur.querySelectorAll('button, div[role="button"]'));
        for (let i = candidates.length - 1; i >= 0; i--) {
          const el = candidates[i] as any;
          if (el === input) continue;
          if (!isSafeButton(el)) continue;
          if (el.querySelector && el.querySelector('svg')) {
            return el;
          }
        }
        cur = cur.parentElement;
      }
    }

    // 策略 2 (兜底)：全局仅通过绝对精确的选择器查找，绝不使用通配符（严禁 button:has(svg) 等全局通配）
    const strictGlobalSelectors = [
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="发送消息"]',
      'div[role="button"][aria-label="发送"]',
      'div[role="button"][aria-label="Send"]',
      'button[data-testid="send-button"]',
      'button[data-testid="send"]',
      '[data-testid="chat-input-send"]',
    ];
    for (const sel of strictGlobalSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (isSafeButton(el)) return el;
        }
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

  // 判断元素是否可见（优先使用原生 checkVisibility 避免强制触发 Layout）
  isElementVisible(el: any) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: true });
      } catch (_) {}
    }
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 返回注入主世界的网络拦截器源码（拦截模式使用）
  // 源码由 scripts/build-hooks.mjs 从 hooks/deepseek.ts 打包生成（自包含 IIFE）
  getHookSource() {
    return DEEPSEEK_HOOK;
  },
};

export { deepseek };
