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
      } catch (_) {
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

  function sendRaw(obj) {
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
        break;
      case 'ai-stream':
        if (!isMyProfile(msg.profileId)) break;
        appendStreaming(msg.delta || '', !!msg.reset);
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
    // 内部结构：纯文本容器（流式期间 appendChild 文本）+ 末尾签名
    streamNode = document.createElement('span');
    streamNode.className = 'stream-text';
    streamingEl.appendChild(streamNode);
    streamingEl.appendChild(createSigNode());
    streamingText = '';
    messages.appendChild(streamingEl);
    checkEmptyState();
    capMessages();
    scroll();
  }

  /**
   * 流式增量追加（性能关键路径）：
   *  - reset=true：服务端 strip 结果回退/重排 → 清空文本重新累积
   *  - 否则：把 delta 作为纯文本 appendChild（不做 markdown 解析、不重建 DOM）
   * 流式期间为纯文本（快速），结束帧由 finishStreaming 用全量做一次 markdown 渲染。
   */
  function appendStreaming(delta, reset) {
    if (!streamingEl) startStreaming();
    if (reset) {
      // 服务端 strip 结果回退/重排：清空重来（全量覆盖一次）
      streamNode.textContent = delta || '';
      streamingText = delta || '';
    } else {
      if (!delta) return;
      // 增量挂文本节点，不重设 textContent（避免每帧 O(n) 覆盖 → 累积 O(n²)）
      streamNode.appendChild(document.createTextNode(delta));
      streamingText += delta;
    }
    // 注：流式期间只 appendChild 到 streamNode，未改 streamingEl 的直接子节点顺序 → sig 恒在末位。
    //     收尾由 finishStreaming 用全量渲染一次。
    scroll();
  }

  function finishStreaming(fullText) {
    const finalText = fullText || streamingText || '';
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
    sendRaw({ type: 'stop' });
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
