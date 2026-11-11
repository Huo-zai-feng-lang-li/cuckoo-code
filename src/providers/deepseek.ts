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
  // 查找可见的聊天输入框（优先唯一 ID #chat-input，支持 querySelectorAll 遍历可见项）
  findInput() {
    const selectors = [
      '#chat-input',
      'textarea#chat-input',
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
        const list = typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll(sel))
          : (document.querySelector(sel) ? [document.querySelector(sel)] : []);
        for (const el of list) {
          if (this.isElementVisible(el)) return el;
        }
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
        const list = typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll(sel))
          : (document.querySelector(sel) ? [document.querySelector(sel)] : []);
        for (const btn of list) {
          if (this.isElementVisible(btn) && !(btn as any).disabled) return btn;
        }
      } catch (_) {}
    }
    // DeepSeek 真机（2026-11-10 取证）：发送/停止主按钮是 DIV.ds-button--primary，
    // 非 <button>、aria-label/title 全空，上面的 button 选择器全部 0 命中。
    // 空闲显示箭头（发送）、生成中显示方块（停止）；禁用态带 ds-button--disabled。
    // 使用 querySelectorAll 遍历，防止顶部栏等其它 primary 按钮干扰。
    try {
      const btns = typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll('.ds-button--primary'))
        : (document.querySelector('.ds-button--primary') ? [document.querySelector('.ds-button--primary')] : []);
      for (const btn of btns) {
        if (this.isElementVisible(btn) && !(btn as any).disabled) {
          const cls = String((btn as any).className || '');
          const path = (btn as any).querySelector ? (btn as any).querySelector('svg path') : null;
          const d = path && path.getAttribute ? (path.getAttribute('d') || '') : '';
          const isSquare = d.indexOf('M2 4.88') !== -1;
          if (cls.indexOf('ds-button--disabled') === -1 && !isSquare) return btn;
        }
      }
    } catch (_) {}
    return null;
  },

  // 触发发送：纯净模式下 AI 视图在后台/无窗口焦点，原生键盘事件会被 Chromium 静默丢弃。
  // 必须优先通过 DOM click 触发发送按钮（完全不受焦点限制，100% 触发 Vue 绑定的提交逻辑）。
  async triggerSend(input: any) {
    if (input) {
      try {
        if (typeof input.focus === 'function') input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
    }

    // 轮询等待 Vue 响应式将发送按钮从 disabled 状态解除（最多等 400ms）
    let btn: any = null;
    for (let i = 0; i < 8; i++) {
      btn = this.findSendButton();
      if (btn) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (btn) {
      try {
        const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
        const cx = rect && rect.width > 0 ? Math.round(rect.left + rect.width / 2) : 0;
        const cy = rect && rect.height > 0 ? Math.round(rect.top + rect.height / 2) : 0;
        const win = window;
        const opts = { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, button: 0 };
        try { btn.dispatchEvent(new win.PointerEvent('pointerdown', opts)); } catch (_) {}
        try { btn.dispatchEvent(new win.MouseEvent('mousedown', opts)); } catch (_) {}
        try { btn.dispatchEvent(new win.PointerEvent('pointerup', opts)); } catch (_) {}
        try { btn.dispatchEvent(new win.MouseEvent('mouseup', opts)); } catch (_) {}
        btn.click();
        console.log('[Cuckoo Code][DeepSeek] 已通过完整 Pointer/Mouse 序列及 DOM click 点击发送按钮');
        return true;
      } catch (_) {}
    }

    // 兜底一：主进程原生 Enter
    try {
      const api = (window as any).electronAPI;
      if (api && typeof api.sendEnterToChat === 'function') {
        const ok = await api.sendEnterToChat();
        if (ok) return true;
      }
    } catch (_) {}

    // 兜底二：合成 Enter 按键事件
    if (input) {
      try {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };
        input.dispatchEvent(new KeyboardEvent('keydown', opts));
        input.dispatchEvent(new KeyboardEvent('keypress', opts));
        input.dispatchEvent(new KeyboardEvent('keyup', opts));
        return true;
      } catch (_) {}
    }
    return false;
  },

  // 提取当前用户信息文本（脱敏手机号/微信昵称）
  extractUserInfo() {
    const el = document.querySelector('._9d8da05');
    return el && el.textContent ? el.textContent.trim() : '';
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

  // 判断元素是否可用/可见（优先几何尺寸，后台/纯净模式视口折叠时回退样式与 DOM 挂载检查）
  isElementVisible(el: any) {
    if (!el) return false;
    if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (el.isConnected !== undefined && el.isConnected === false) return false;
        return true;
      }
    } catch (_) {}
    return false;
  },

  // 返回注入主世界的网络拦截器源码（拦截模式使用）
  // 源码由 scripts/build-hooks.mjs 从 hooks/deepseek.ts 打包生成（自包含 IIFE）
  getHookSource() {
    return DEEPSEEK_HOOK;
  },

  /**
   * 附件上传入口探测（供 CDP 上传通道使用）。
   *
   * 真机取证（2026-11-10）：DeepSeek 上传键是 `div.ds-button[role=button]`，
   * 类名是 hash（如 `db183363`），aria-label/title 全空 —— 通用关键词探测必然 0 命中。
   * 但页面存在隐藏的 `input[type=file]`（display:none、multiple、accept 含 .txt/.md/.json/.log），
   * 这是最干净的入口：返回 isFileInput 让核心跳过点击、直接 DOM.setFileInputFiles 注入，
   * 全程不派发任何合成事件。
   *
   * 必须自包含：被序列化后注入页面主世界执行。
   */
  getAttachProbeSource() {
    return function (doc: any, win: any) {
      try {
        // 清掉上一次的标记，避免多轮探测选错元素
        var olds = doc.querySelectorAll('input[data-cuckoo-attach-input]');
        for (var oi = 0; oi < olds.length; oi++) {
          try { olds[oi].removeAttribute('data-cuckoo-attach-input'); } catch (e) {}
        }
        var inputs = doc.querySelectorAll('input[type=file]');
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          if (!el) continue;
          var accept = String(el.getAttribute('accept') || '');
          // 只认支持纯文本的入口（长工具输出走 .txt）
          if (accept && accept.indexOf('.txt') === -1 && accept.indexOf('.md') === -1) continue;
          try { el.setAttribute('data-cuckoo-attach-input', '1'); } catch (e) {}
          return {
            found: true,
            isFileInput: true,
            x: 0,
            y: 0,
            tag: 'INPUT[type=file]',
            accept: accept.slice(0, 60),
          };
        }
        return { found: false, reason: 'no-file-input' };
      } catch (e) {
        return { found: false, reason: 'error:' + String(e) };
      }
    };
  },

  /**
   * 附件就绪判定（供 CDP 上传通道使用）。
   *
   * 核心内置启发式只认 zhipu/mimo 的类名与预览图，DeepSeek 的附件卡片是
   * hash 类名（真机取证：`_871cbca`），.txt 也没有缩略图 → 必然超时误判失败。
   * 注意：不能用 `input[type=file].files.length > 0` 当就绪判据——文件写入 input
   * 后该值立即为真，但站点上传是异步的，此刻附件尚未挂进输入区，提前发送会被拒。
   * 只认本次文件的视觉证据：输入区附近出现精确文件名，避免旧卡片冒充上传完成。
   *
   * 必须自包含：被序列化后注入页面主世界执行。
   */
  getAttachReadySource() {
    return function (doc: any, win: any, fileInfo?: { name?: string }) {
      try {
        var name = fileInfo && fileInfo.name;
        if (!name) return { ready: false, via: 'missing-file-name' };
        var vh = win.innerHeight || 800;
        var box = doc.querySelector('textarea, [contenteditable="true"]');
        var boxTop = box ? box.getBoundingClientRect().top : vh * 0.7;
        var all = doc.querySelectorAll('div, span');
        for (var k = 0; k < all.length; k++) {
          var el = all[k];
          if (el.children && el.children.length > 2) continue;
          var t = String(el.textContent || '').trim();
          if (t !== name) continue;
          var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!r || r.width === 0 || r.height === 0) continue;
          if (r.top < boxTop - 200 || r.top > boxTop + 120) continue;
          return { ready: true, via: 'file-card' };
        }
        return { ready: false, via: 'no-attachment' };
      } catch (e) {
        return { ready: false, via: 'error:' + String(e) };
      }
    };
  },

  /**
   * 新会话默认开关：开「深度思考」、关「智能搜索」。
   *
   * 真机 DOM（2026-11-10 取证）：
   *   深度思考 div.ds-toggle-button.ds-toggle-button--selected  aria-pressed="true"
   *   智能搜索 div.ds-toggle-button                              aria-pressed="false"
   * 以 aria-pressed 为准（不依赖 selected 类名，抗样式类改名）。
   *
   * 点击必须走 PointerEvent 序列：DeepSeek 只认真实指针事件，DOM .click()
   * 不会触发其内部状态机（与 stopGeneration 的 clickInPage 同一结论）。
   * 状态已符合预期时不点击，避免多余交互痕迹。
   * 必须自包含：被序列化后注入页面主世界执行。
   */
  setupNewSession() {
    return function (doc: any, win: any) {
      try {
        var toggles = doc.querySelectorAll('.ds-toggle-button');
        var found = 0;
        for (var i = 0; i < toggles.length; i++) {
          var el = toggles[i];
          var txt = (el.textContent || '').trim();
          if (txt.length > 12) continue;

          var wantOn = -1;
          if (txt.indexOf('深度思考') !== -1) wantOn = 1;
          else if (txt.indexOf('智能搜索') !== -1) wantOn = 0;
          if (wantOn === -1) continue;
          found++;

          var pressed = el.getAttribute('aria-pressed') === 'true';
          if (pressed === (wantOn === 1)) continue; // 已是目标态

          var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!rect || rect.width === 0 || rect.height === 0) continue;

          var cx = Math.round(rect.left + rect.width / 2);
          var cy = Math.round(rect.top + rect.height / 2);
          var opts = { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, button: 0 };
          try { el.dispatchEvent(new win.PointerEvent('pointerdown', opts)); } catch (e) {}
          try { el.dispatchEvent(new win.MouseEvent('mousedown', opts)); } catch (e) {}
          try { el.dispatchEvent(new win.PointerEvent('pointerup', opts)); } catch (e) {}
          try { el.dispatchEvent(new win.MouseEvent('mouseup', opts)); } catch (e) {}
          try { el.dispatchEvent(new win.MouseEvent('click', opts)); } catch (e) {}
        }
        // ready 表示"目标开关已在 DOM 里出现"（无论是否点击）。
        // 主进程据此判断页面是否渲染到位：未就绪时轮询重试，避免首页刚加载完
        // 按钮还没画出来就执行一次、结果什么都没设上。
        return { ready: found > 0, found: found };
      } catch (e) {
        /* 静默：开关设置失败不应阻断新会话初始化 */
        return { ready: false, found: 0 };
      }
    };
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
        // 清理旧的标记，防止多次调用产生重影
        var olds = doc.querySelectorAll('[data-cuckoo-stop-target]');
        for (var oi = 0; oi < olds.length; oi++) {
          try { olds[oi].removeAttribute('data-cuckoo-stop-target'); } catch (e) {}
        }
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
            // 空闲态：这是发送按钮，绝不能点。跳过继续遍历（可能有多个主按钮）
            continue;
          }
          try { el.setAttribute('data-cuckoo-stop-target', '1'); } catch (e) {}
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
