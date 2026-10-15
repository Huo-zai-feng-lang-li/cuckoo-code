/**
 * Cuckoo Remote 手机端逻辑
 * 成熟化：XSS 消毒 + 可靠队列 + 断线回退 + 多窗口隔离 + 停止/复制/主题 + 代码块美化与快捷操作
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const login = $('login'), app = $('app'), messages = $('messages');
  const input = $('input'), sendBtn = $('send'), stopBtn = $('stop'), connDot = $('conn-dot');
  const connText = $('conn-text'), profileLabel = $('profile-label');
  const profileSelect = $('profile-select'), reconnectBtn = $('btn-reconnect'), themeBtn = $('btn-theme');
  const clearBtn = $('btn-clear'), attachBtn = $('attach'), fileInput = $('file-input');
  const execStatus = $('exec-status'), execText = $('exec-text'), offlineBanner = $('offline-banner');
  const emptyState = $('empty-state'), scrollBottomBtn = $('scroll-bottom-btn'), scrollNewBadge = $('scroll-new-badge');
  const pasteBtn = $('token-paste-btn');

  let token = localStorage.getItem('cuckoo-token') || '';
  let ws = null;
  let connected = false;
  let wsGen = 0;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let failStreak = 0;
  let lastPong = Date.now(); // 心跳：最近一次 pong 时间
  const MAX_QUEUE = 50;
  const sendQueue = []; // 断线暂存

  // 当前展示窗口（多窗口隔离：只渲染该 profileId 的消息）
  let currentProfileId = '';
  // 当前流式气泡（streamingEl = 气泡容器；streamNode = 内部纯文本容器；streamingText = 累积文本）
  let streamingEl = null;
  let streamNode = null;
  let streamingText = '';
  // 思考气泡（正文气泡上方的可折叠块）
  let thinkEl = null;        // 思考块容器（.msg-think）
  let thinkBody = null;      // 思考正文容器（流式 append）
  let thinkLabel = null;     // 标题（"思考中…" / "已思考 (N 字)"）
  let thinkText = '';        // 累积思考文本
  let thinkUserToggled = false; // 用户手动展开/折叠过 → 不再自动折叠
  let sawText = false;       // 本轮正文是否已出现（出现后 think 不再自动展开，防交替抖动）
  // 是否在执行（切换 发送/停止 按钮）
  let executing = false;

  const MAX_MSG_NODES = 200;

  // ===== 主题 =====
  function applyTheme(theme) {
    const t = theme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0d0f12' : '#f8f9fa');
  }
  let theme = localStorage.getItem('cuckoo-theme') || '';
  applyTheme(theme);
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem('cuckoo-theme', theme);
      applyTheme(theme);
    });
  }

  // ===== 空状态管理 =====
  function checkEmptyState() {
    if (!emptyState) return;
    const hasMsgs = messages.querySelectorAll('.msg').length > 0;
    if (hasMsgs) {
      if (emptyState.parentNode === messages) emptyState.remove();
    } else {
      if (emptyState.parentNode !== messages) messages.appendChild(emptyState);
    }
  }

  // 快捷指令推荐点击
  document.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (!prompt) return;
      input.value = prompt;
      autoGrow();
      syncSendBtn();
      input.focus();
    });
  });

  // ===== 登录 =====
  function showLogin(err) {
    app.classList.add('hidden');
    login.classList.remove('hidden');
    $('login-err').textContent = err || '';
  }
  function showApp() {
    login.classList.add('hidden');
    app.classList.remove('hidden');
    checkEmptyState();
    setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 50);
  }

  $('token-btn').addEventListener('click', () => {
    const t = $('token-input').value.trim();
    if (!t) return;
    verifyAndConnect(t);
  });
  $('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('token-btn').click();
  });

  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          $('token-input').value = text.trim();
          $('token-input').focus();
        }
      } catch {
        $('token-input').focus();
      }
    });
  }

  /** 先用 HTTP 预检 token，正确才连 WS；错误给出明确提示 */
  async function verifyAndConnect(t) {
    $('login-err').textContent = '验证中…';
    try {
      const resp = await fetch('/api/ping?token=' + encodeURIComponent(t), { cache: 'no-store' });
      if (resp.status === 401) { $('login-err').textContent = '令牌错误，请检查后重试'; return; }
      if (!resp.ok) { $('login-err').textContent = '连接失败（HTTP ' + resp.status + '）'; return; }
    } catch {
      $('login-err').textContent = '无法连接电脑（请确认电脑在线、隧道已开）';
      return;
    }
    token = t;
    localStorage.setItem('cuckoo-token', t);
    $('login-err').textContent = '';
    failStreak = 0;
    connect();
  }

  // ===== WebSocket =====
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws?token=' + encodeURIComponent(token);
  }

  function connect() {
    const gen = ++wsGen;
    if (ws) { try { ws.close(); } catch {} }
    setConn('connecting');
    let sock;
    try {
      sock = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (gen !== wsGen) { try { sock.close(); } catch {} return; }
      connected = true;
      failStreak = 0;
      lastPong = Date.now();
      reconnectDelay = 1000;
      setConn('on');
      hideOffline();
      if (token) { localStorage.setItem('cuckoo-token', token); showApp(); }
      flushQueue();
    };
    sock.onmessage = (ev) => {
      if (gen !== wsGen) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      handleServerMessage(msg);
    };
    sock.onclose = () => {
      if (gen !== wsGen) return;
      connected = false;
      setConn('off');
      hideExec();
      setExecuting(false);

      if (!token) {
        showLogin();
        return;
      }

      showOffline('连接已断开，正在自动重连…');
      // 失败 3 次以上时，在后台静默探测是否是令牌被电脑端重置（401）
      if (++failStreak >= 3 && failStreak % 3 === 0) {
        fetch('/api/ping?token=' + encodeURIComponent(token), { cache: 'no-store' })
          .then((res) => {
            if (res.status === 401) {
              localStorage.removeItem('cuckoo-token');
              token = '';
              showLogin('电脑端令牌已重置，请重新输入');
            }
          })
          .catch(() => {});
      }
      scheduleReconnect();
    };
    sock.onerror = () => { if (gen === wsGen) setConn('off'); };
  }

  // 手机端自愈生命周期：网络恢复或切回前台时立即尝试秒级重连
  window.addEventListener('online', () => {
    if (!connected && token) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectDelay = 1000;
      failStreak = 0;
      connect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !connected && token) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectDelay = 1000;
      connect();
    }
  });

  // 心跳保活
  setInterval(() => {
    if (!connected) return;
    if (Date.now() - lastPong > 60000) {
      console.warn('[Remote] 心跳超时，主动重连');
      try { ws.close(); } catch {}
      return;
    }
    sendRaw({ type: 'ping' });
  }, 25000);

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
      connect();
    }, reconnectDelay);
  }

  function setConn(state) {
    connDot.className = 'dot' + (state === 'on' ? ' on' : state === 'off' ? ' off' : state === 'connecting' ? ' connecting' : '');
    if (connText) {
      connText.textContent = state === 'on' ? '已在线' : state === 'off' ? '已离线' : '重连中';
    }
  }
  function showOffline(text) {
    const t = $('offline-text') || offlineBanner;
    t.textContent = text;
    offlineBanner.classList.add('show');
  }
  function hideOffline() { offlineBanner.classList.remove('show'); }

  // 半开连接判定：TCP 已死但 ws.readyState 仍为 1 时，send() 会把消息发进死连接
  // 且不报错（消息静默丢失）。用"最近 pong 距今过久"作为可疑半开的信号。
  // 阈值取 130s，**明显大于服务端判死阈值（约 120s）**：让"服务端先断 → 客户端收到 close
  // → 走正常重连"成为主路径，避免客户端把底层仍健康的连接（手机后台唤醒后）主动掐掉。
  const STALE_MS = 130000;
  function isConnStale() {
    return connected && (Date.now() - lastPong > STALE_MS);
  }

  function sendRaw(obj) {
    // 可疑半开：不发送（避免静默丢），返回 false 让调用方走队列/重连
    if (isConnStale()) {
      console.warn('[Remote] 连接疑似半开（pong 超时），触发重连');
      try { ws.close(); } catch {}
      return false;
    }
    if (connected && ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; } catch {}
    }
    return false;
  }

  function flushQueue() {
    while (sendQueue.length && connected) {
      const t = sendQueue[0];
      if (!sendRaw({ type: 'send', text: t })) break;
      sendQueue.shift();
    }
  }

  // ===== 服务端消息 =====
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'ready':
      case 'profiles':
        updateProfiles(msg.profiles || [], msg.currentProfileId || '');
        break;
      case 'ai-start':
        if (!isMyProfile(msg.profileId)) break;
        // 防御性：异常顺序下可能残留旧流式气泡，先移除避免僵尸 DOM 累积
        if (streamingEl) { try { streamingEl.remove(); } catch {} }
        showExec('正在生成回复…');
        setExecuting(true);
        streamingText = '';
        streamingEl = null;
        streamNode = null;
        // 只重置引用，**不动历史 think DOM**（上一轮的思考块应保留在会话里）
        thinkEl = null; thinkBody = null; thinkLabel = null;
        thinkText = ''; thinkUserToggled = false; sawText = false;
        cancelStreamMd();
        break;
      case 'ai-stream':
        if (!isMyProfile(msg.profileId)) break;
        if (msg.reset) {
          // 重排/重连补发：清空**当前轮**的 think/text 容器重来（保留历史消息 DOM）
          if (thinkEl) { try { thinkEl.remove(); } catch {} }
          thinkEl = null; thinkBody = null; thinkLabel = null;
          thinkText = ''; thinkUserToggled = false; sawText = false;
          if (streamingEl) { try { streamingEl.remove(); } catch {} }
          streamingEl = null; streamNode = null; streamingText = '';
          cancelStreamMd();
        }
        if (msg.thinkDelta) appendThink(msg.thinkDelta);
        if (msg.textDelta) appendStreaming(msg.textDelta);
        break;
      case 'ai-reply':
        if (!isMyProfile(msg.profileId)) break;
        finishStreaming(msg.text || '');
        hideExec();
        setExecuting(false);
        break;
      case 'ai-stop':
        if (!isMyProfile(msg.profileId)) break;
        finishStreaming(streamingText);
        hideExec();
        setExecuting(false);
        break;
      case 'ai-error':
        if (!isMyProfile(msg.profileId)) break;
        finishStreaming(streamingText);
        hideExec();
        setExecuting(false);
        if (msg.error) addSystem('生成失败: ' + msg.error);
        break;
      case 'tool':
        if (!isMyProfile(msg.profileId)) break;
        onToolEvent(msg.phase);
        break;
      case 'sys':
        if (msg.profileId && !isMyProfile(msg.profileId)) break;
        if (msg.text) {
          addSystem(msg.text);
          if (!msg.keepBusy) { hideExec(); setExecuting(false); }
        }
        break;
      case 'attach-result':
        addSystem(msg.success ? ('已上传：' + (msg.name || '图片')) : ('上传失败：' + (msg.error || '未知错误')));
        break;
      case 'pong':
        lastPong = Date.now();
        break;
    }
  }

  function isMyProfile(pid) {
    if (!currentProfileId) return true;
    return pid === currentProfileId;
  }

  function resetView() {
    messages.innerHTML = '';
    streamingEl = null;
    streamNode = null;
    streamingText = '';
    resetThink();
    hideExec();
    setExecuting(false);
    checkEmptyState();
  }

  function syncProfileLabel() {
    if (!profileLabel || !profileSelect) return;
    const opt = profileSelect.options[profileSelect.selectedIndex];
    profileLabel.textContent = opt ? opt.text : '默认窗口';
  }

  function updateProfiles(list, currentId) {
    if (!list.length) {
      profileSelect.innerHTML = '<option>（无可用窗口）</option>';
      if (currentProfileId) { resetView(); addSystem('目标窗口已关闭'); }
      currentProfileId = '';
      syncProfileLabel();
      return;
    }
    const prevId = currentProfileId;
    const ids = list.map((p) => p.id);
    const fallbackId = currentId || (list[0] && list[0].id) || '';
    if (prevId && !ids.includes(prevId)) {
      resetView();
      addSystem('原目标窗口已关闭，已切到：' + nameOf(list, fallbackId));
    }
    profileSelect.innerHTML = list.map((p) =>
      '<option value="' + escapeAttr(p.id) + '"' + (p.id === fallbackId ? ' selected' : '') + '>' +
      escapeHtml(p.name || p.id) + '</option>'
    ).join('');
    currentProfileId = fallbackId;
    syncProfileLabel();
  }

  function nameOf(list, id) {
    const p = list.find((x) => x.id === id);
    return (p && p.name) || id || '';
  }

  // ===== Markdown 渲染 + XSS 消毒 =====
  const md = window.marked ? window.marked.marked : null;
  if (md) {
    try { md.setOptions({ breaks: true, gfm: true }); } catch {}
  }
  const ALLOWED_TAGS = new Set(['P','BR','HR','STRONG','EM','DEL','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','A','TABLE','THEAD','TBODY','TR','TH','TD','SPAN','DIV']);

  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    if (!root) return '';
    const walk = (node) => {
      const kids = Array.from(node.childNodes);
      for (const child of kids) {
        if (child.nodeType === 1) {
          const tag = child.tagName;
          if (!ALLOWED_TAGS.has(tag)) { child.remove(); continue; }
          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            if (tag === 'A' && name === 'href') {
              const v = (attr.value || '').trim().toLowerCase();
              if (v.startsWith('javascript:') || v.startsWith('data:')) child.removeAttribute(attr.name);
              else { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
            } else if (name !== 'class') {
              child.removeAttribute(attr.name);
            }
          }
          walk(child);
        } else if (child.nodeType === 8) {
          child.remove();
        }
      }
    };
    walk(root);
    return root.innerHTML;
  }

  function renderMd(text) {
    if (!text) return '';
    if (!md) return escapeHtml(text).replace(/\n/g, '<br>');
    try { return sanitize(md.parse(text)); } catch { return escapeHtml(text); }
  }

  // ===== 代码块增强（语言标识 + 独立复制） =====
  function decorateContent(container) {
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = 'true';
      const code = pre.querySelector('code');
      const rawText = code ? code.innerText : pre.innerText;
      let lang = 'CODE';
      if (code && code.className) {
        const m = code.className.match(/language-([a-zA-Z0-9_-]+)/);
        if (m) lang = m[1].toUpperCase();
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'code-wrapper';
      const header = document.createElement('div');
      header.className = 'code-header';
      header.innerHTML = `
        <span class="code-lang">${escapeHtml(lang)}</span>
        <button class="code-copy-btn" type="button" title="复制代码" aria-label="复制代码">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>复制</span>
        </button>
      `;

      const copyBtn = header.querySelector('.code-copy-btn');
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(rawText);
          copyBtn.classList.add('copied');
          copyBtn.querySelector('span').textContent = '已复制';
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.querySelector('span').textContent = '复制';
          }, 1800);
        } catch {
          copyBtn.querySelector('span').textContent = '复制失败';
        }
      });

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  // ===== 消息渲染 =====
  function capMessages() {
    while (messages.querySelectorAll('.msg').length > MAX_MSG_NODES) {
      const first = messages.querySelector('.msg');
      if (first) first.remove();
    }
  }

  function addUser(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    messages.appendChild(el);
    checkEmptyState();
    capMessages();
    scroll(true);
  }

  function addImageBubble(name, dataUrl) {
    const el = document.createElement('div');
    el.className = 'msg user msg-image';
    el.innerHTML = `
      <div class="image-bubble">
        <img src="${dataUrl}" alt="${escapeAttr(name)}" class="uploaded-thumb" />
        <div class="image-name"><svg width="12" height="12" aria-hidden="true" style="vertical-align:-1px"><use href="#i-image" /></svg> ${escapeHtml(name)}</div>
      </div>
    `;
    messages.appendChild(el);
    checkEmptyState();
    capMessages();
    scroll(true);
  }

  function addSystem(text) {
    const el = document.createElement('div');
    el.className = 'msg sys';
    el.textContent = text;
    messages.appendChild(el);
    checkEmptyState();
    capMessages();
    scroll();
  }

  // AI 消息尾部签名（✦ Cuckoo）——与电脑端一致。流式期间兼作光标
  const SIG_HTML = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1l1.8 4.6L14.5 8l-4.7 2.4L8 15l-1.8-4.6L1.5 8l4.7-2.4z"/></svg>Cuckoo';
  function createSigNode() {
    const s = document.createElement('span');
    s.className = 'msg-sig';
    s.innerHTML = SIG_HTML;
    return s;
  }
  function startStreaming() {
    streamingEl = document.createElement('div');
    streamingEl.className = 'msg ai streaming';
    // 内部结构：正文容器（流式期间低频渲染 markdown）+ 末尾签名。
    // 用 div 而非 span：流式期间会放入 <p> 等块级 HTML（span 放块级不合法）。
    streamNode = document.createElement('div');
    streamNode.className = 'stream-text';
    streamingEl.appendChild(streamNode);
    streamingEl.appendChild(createSigNode());
    streamingText = '';
    messages.appendChild(streamingEl);
    checkEmptyState();
    capMessages();
    scroll();
  }

  // ===== 思考块（正文上方，流式展开 → 正文出现后自动折叠）=====
  function ensureThinkEl() {
    if (thinkEl) return;
    // 用局部 el 捕获当前节点：监听器绝不能引用全局 thinkEl（多轮后它已指向新轮次，
    // 会导致所有历史思考框的点击都操作最新元素 → 表现为"几个框同步、点不动"）
    const el = document.createElement('div');
    el.className = 'msg think-block open';
    el.innerHTML =
      '<button class="think-head" type="button">' +
        '<svg class="think-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2z"/><path d="M10 21h4"/></svg>' +
        '<span class="think-label">思考中…</span>' +
        '<svg class="think-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
      '</button>' +
      '<div class="think-body"></div>';
    el.querySelector('.think-head').addEventListener('click', () => {
      // 只操作被点击的这个块
      el.classList.toggle('open');
      // 只有点击的是"当前活跃"的思考块，才标记用户手动（影响自动折叠策略）；
      // 点历史思考块不应干扰当前轮
      if (el === thinkEl) thinkUserToggled = true;
    });
    messages.appendChild(el);
    thinkEl = el;
    thinkBody = el.querySelector('.think-body');
    thinkLabel = el.querySelector('.think-label');
    checkEmptyState();
  }

  function appendThink(delta) {
    if (!delta) return;
    ensureThinkEl();
    // 增量 append 纯文本（性能：不做 markdown、不重建 DOM）
    thinkBody.appendChild(document.createTextNode(delta));
    thinkText += delta;
    thinkLabel.textContent = '思考中… (' + thinkText.length + ' 字)';
    // 正文尚未出现时才自动展开（一旦正文出现就不再展开，防 think/text 交替抖动）
    if (!thinkUserToggled && !sawText) thinkEl.classList.add('open');
    checkEmptyState();
    capMessages();
    scroll();
  }

  /** 思考收尾：标记"已思考"，非用户手动时折叠 */
  function finishThink() {
    if (!thinkEl) return;
    try {
      thinkEl.classList.add('done'); // 停止脉动动画
      if (thinkLabel) thinkLabel.textContent = '已思考 (' + thinkText.length + ' 字)';
      if (!thinkUserToggled) thinkEl.classList.remove('open');
    } catch { /* ignore */ }
  }

  function resetThink() {
    if (thinkEl) { try { thinkEl.remove(); } catch {} }
    thinkEl = null; thinkBody = null; thinkLabel = null;
    thinkText = ''; thinkUserToggled = false; sawText = false;
  }

  // 流式 markdown 渲染节流：每 ~200ms 把累积文本渲染一次 markdown，
  // 让手机端流式期间也有格式（而非"先出现一大坨 md 再变格式"）。
  // 用 200ms 低频控制性能（每帧全量 renderMd 会累积 O(n²)；200ms 一次可控）。
  let streamMdTimer = null;
  let lastStreamMdAt = 0;
  const STREAM_MD_INTERVAL = 200;
  function cancelStreamMd() {
    if (streamMdTimer) { clearTimeout(streamMdTimer); streamMdTimer = null; }
  }
  function flushStreamMd() {
    if (streamMdTimer) { clearTimeout(streamMdTimer); streamMdTimer = null; }
    lastStreamMdAt = Date.now();
    if (!streamNode || !streamingText) return;
    try {
      // 渲染 markdown 后切到 normal 空白（pre-wrap 会让 <p> 之间产生双重间距）
      streamNode.classList.add('stream-text--md');
      streamNode.innerHTML = renderMd(streamingText);
    } catch { /* ignore */ }
  }
  function scheduleStreamMd() {
    if (streamMdTimer) return;
    const delay = Math.max(0, STREAM_MD_INTERVAL - (Date.now() - lastStreamMdAt));
    streamMdTimer = setTimeout(function () { streamMdTimer = null; flushStreamMd(); }, delay);
  }

  /**
   * 流式增量追加：
   *  累积文本 + 低频（~200ms）渲染 markdown 到 streamNode（流式期间即有格式）。
   *  reset（清空重来）由调用方 handleServerMessage 的 msg.reset 分支处理。
   *  收尾由 finishStreaming 用全量做最后一次 markdown 渲染 + 代码块增强/复制按钮。
   */
  function appendStreaming(delta) {
    if (!delta) return;
    if (!streamingEl) startStreaming();
    streamingText += delta;
    // 正文已出现 → 标记 + 思考块自动折叠（非用户手动）
    sawText = true;
    if (thinkEl && !thinkUserToggled) thinkEl.classList.remove('open');
    scheduleStreamMd();
    scroll();
  }

  function finishStreaming(fullText) {
    cancelStreamMd(); // 取消流式期间的 pending markdown 渲染（收尾会全量渲染一次）
    const finalText = fullText || streamingText || '';
    finishThink();
    if (!streamingEl) {
      if (finalText) addAi(finalText);
    } else if (finalText) {
      streamingEl.innerHTML = renderMd(finalText);
      streamingEl.classList.remove('streaming'); // 收尾还原正式气泡样式
      // 尾部签名（✦ Cuckoo）：innerHTML 覆盖后补上，保证在正文末尾
      streamingEl.appendChild(createSigNode());
      decorateContent(streamingEl);
      attachActions(streamingEl, finalText);
    } else {
      streamingEl.remove();
    }
    streamingEl = null;
    streamNode = null;
    streamingText = '';
    checkEmptyState();
    scroll();
  }

  function addAi(text) {
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'msg ai';
    el.innerHTML = renderMd(text);
    // 尾部签名（✦ Cuckoo）：innerHTML 后补上
    el.appendChild(createSigNode());
    decorateContent(el);
    attachActions(el, text);
    messages.appendChild(el);
    checkEmptyState();
    capMessages();
    scroll();
  }

  /** AI 消息底部操作：复制全文 */
  function attachActions(el, rawText) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-act';
    copyBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>复制全文</span>
    `;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rawText);
        copyBtn.classList.add('copied');
        copyBtn.querySelector('span').textContent = '已复制';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.querySelector('span').textContent = '复制全文';
        }, 1600);
      } catch {}
    });
    bar.appendChild(copyBtn);
    el.appendChild(bar);
  }

  function onToolEvent(phase) {
    if (phase === 'start') { showExec('正在调用系统工具…'); setExecuting(true); }
  }

  // ===== 执行状态条 / 发送停止按钮 =====
  let execVisible = false;
  function showExec(text) {
    if (!execStatus) return;
    execText.textContent = text || '正在执行…';
    if (!execVisible) { execStatus.classList.remove('hidden'); execVisible = true; }
  }
  function hideExec() {
    if (!execStatus || !execVisible) return;
    execStatus.classList.add('hidden');
    execVisible = false;
  }

  function setExecuting(on) {
    executing = on;
    stopBtn.classList.toggle('hidden', !on);
    sendBtn.classList.toggle('hidden', on);
    syncSendBtn();
  }

  // ===== 自动滚动与回到底部 FAB =====
  let stickToBottom = true;
  let hasNewWhileScrolled = false;
  const BOTTOM_THRESHOLD = 80;

  function isNearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= BOTTOM_THRESHOLD;
  }

  function updateScrollBtn() {
    if (!scrollBottomBtn) return;
    const near = isNearBottom();
    if (near) {
      scrollBottomBtn.classList.add('hidden');
      hasNewWhileScrolled = false;
      if (scrollNewBadge) scrollNewBadge.classList.add('hidden');
    } else {
      scrollBottomBtn.classList.remove('hidden');
      if (hasNewWhileScrolled && scrollNewBadge) {
        scrollNewBadge.classList.remove('hidden');
      }
    }
  }

  messages.addEventListener('scroll', () => {
    stickToBottom = isNearBottom();
    updateScrollBtn();
  });

  if (scrollBottomBtn) {
    scrollBottomBtn.addEventListener('click', () => {
      messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
      hasNewWhileScrolled = false;
      if (scrollNewBadge) scrollNewBadge.classList.add('hidden');
      scrollBottomBtn.classList.add('hidden');
    });
  }

  let scrollTimer = null;
  function scroll(force) {
    if (!stickToBottom && !force) {
      hasNewWhileScrolled = true;
      updateScrollBtn();
      return;
    }
    if (scrollTimer) return;
    scrollTimer = requestAnimationFrame(() => {
      scrollTimer = null;
      messages.scrollTop = messages.scrollHeight;
      updateScrollBtn();
    });
  }

  // 清屏按钮
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      messages.innerHTML = '';
      streamingEl = null;
      streamNode = null;
      streamingText = '';
      resetThink();
      checkEmptyState();
      updateScrollBtn();
    });
  }

  // ===== 发送 =====
  function doSend() {
    if (executing) { addSystem('正在执行中，请等本轮结束后再发'); return; }
    const text = input.value.trim();
    if (!text) return;
    addUser(text);
    input.value = '';
    autoGrow();
    syncSendBtn();
    if (sendRaw({ type: 'send', text })) {
      showExec('正在生成回复…');
      setExecuting(true);
    } else {
      if (sendQueue.length >= MAX_QUEUE) sendQueue.shift();
      sendQueue.push(text);
      showOffline('离线中，消息将在重连后自动发送');
    }
  }

  // ===== 图片上传 =====
  if (attachBtn && fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      handleUpload(f);
    });
  }

  function handleUpload(file) {
    if (!connected) { addSystem('未连接电脑，无法上传'); return; }
    if (file.size > 8 * 1024 * 1024) { addSystem('文件过大（上限 8MB）'); return; }
    const reader = new FileReader();
    addSystem('正在上传：' + (file.name || '图片') + '…');
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      addImageBubble(file.name || 'image.png', dataUrl);
      const comma = dataUrl.indexOf(',');
      const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const ok = sendRaw({ type: 'attach', name: file.name || 'image.png', mime: file.type || 'image/png', data: b64 });
      if (!ok) addSystem('上传失败：连接已断开');
    };
    reader.onerror = () => addSystem('读取图片文件失败');
    reader.readAsDataURL(file);
  }

  sendBtn.addEventListener('click', doSend);
  stopBtn.addEventListener('click', () => {
    if (!sendRaw({ type: 'stop' })) {
      // 发送失败（连接半开/断开）：不能静默——用户以为停了，实际没停
      addSystem('连接已断开，停止指令未送达，正在重连…');
    }
    hideExec();
    setExecuting(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  function syncSendBtn() {
    if (executing) { sendBtn.disabled = true; return; }
    sendBtn.disabled = !input.value.trim();
  }
  input.addEventListener('input', () => { autoGrow(); syncSendBtn(); });
  syncSendBtn();

  reconnectBtn.addEventListener('click', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 1000;
    failStreak = 0;
    connect();
  });

  profileSelect.addEventListener('change', () => {
    currentProfileId = profileSelect.value;
    syncProfileLabel();
    resetView();
    sendRaw({ type: 'select-profile', profileId: profileSelect.value });
  });

  // ===== 工具函数 =====
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  // ===== 启动 =====
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    token = urlToken;
    localStorage.setItem('cuckoo-token', token);
    try { history.replaceState(null, '', location.pathname); } catch {}
  }

  if (token) {
    showApp();
    connect();
  } else {
    showLogin();
  }
})();
