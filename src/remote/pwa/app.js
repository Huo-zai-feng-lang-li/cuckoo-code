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
  const clearBtn = $('btn-clear');
  const execStatus = $('exec-status'), execText = $('exec-text'), offlineBanner = $('offline-banner');
  const emptyState = $('empty-state'), scrollBottomBtn = $('scroll-bottom-btn'), scrollNewBadge = $('scroll-new-badge');
  const pasteBtn = $('token-paste-btn');

  let token = localStorage.getItem('cuckoo-token') || '';
  // 服务器地址（APK 内 location.host 是 localhost，必须手动指定电脑地址）
  let serverBase = localStorage.getItem('cuckoo-server') || '';
  /** 规范化地址：补协议、去尾斜杠、去掉误粘的 /#/ws 等后缀 */
  function normalizeBase(raw) {
    let s = (raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    // 去掉路径、查询、hash，只保留 origin
    try { const u = new URL(s); return u.protocol + '//' + u.host; } catch { return ''; }
  }
  /** 计算请求基址：有 serverBase 用它，否则用当前页面 origin（浏览器场景） */
  function base() {
    return serverBase || (location.protocol + '//' + location.host);
  }
  /** 是否运行在 Capacitor 原生壳里（APK）。只信 window.Capacitor，避免误伤浏览器本地开发 */
  function isNativeShell() {
    const c = window.Capacitor;
    if (!c) return false;
    if (typeof c.isNativePlatform === 'function') return c.isNativePlatform();
    return !!c.isNative;
  }
  const DRAFT_KEY = 'cuckoo-draft';
  // 为当前浏览器标签页生成唯一 ID，用于服务端去重
  let clientId = localStorage.getItem('cuckoo-client-id');
  if (!clientId) {
    clientId = 'c_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    localStorage.setItem('cuckoo-client-id', clientId);
  }
  let ws = null;
  let connected = false;
  let wsGen = 0;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let disconnectTimer = null; // 断线降级防抖（3 秒内重连成功则不闪"已离线"）
  let startupWatchdog = null; // 启动乐观显示"已在线"的看门狗（8 秒未连上则降级为已离线）
  let failStreak = 0;
  let lastPong = Date.now(); // 心跳：最近一次 pong 时间
  let foregroundProbeTimer = null; // 切前台探活定时器
  const MAX_QUEUE = 50;
  const sendQueue = []; // 断线暂存

  // 当前展示窗口（多窗口隔离：只渲染该 profileId 的消息）
  let currentProfileId = '';
  let profilesReady = false; // 是否已收到服务端的 profile 列表
  // 滚动与回到底部状态（提前声明，避免 renderHistory 时因 TDZ 死区报错）
  let stickToBottom = true;
  let hasNewWhileScrolled = false;
  const BOTTOM_THRESHOLD = 50;
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
    // 连接刚建立、历史尚未到达：先显示"同步中"过渡态。
    // 原实现直接 checkEmptyState() → 用户看到"已就绪"空态卡片，误以为没有历史/卡住了。
    // 历史到达（renderHistory）或超时（无历史）后才切到真正的空态。
    setSyncing(true);
    setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 50);
  }

  /** 同步中过渡态：复用 empty-state 卡片，只改标题文案与可见性。
   *  - true：显示"正在同步对话…"，隐藏快捷指令卡
   *  - false：恢复正常空态（无历史时）或直接移除（有历史时）
   *  同时设 2.5 秒兜底：即使服务端历史因故未到，也不能让用户永久看"同步中"。 */
  let syncTimeoutTimer = null;
  function setSyncing(on) {
    if (!emptyState) return;
    if (syncTimeoutTimer) { clearTimeout(syncTimeoutTimer); syncTimeoutTimer = null; }
    const titleEl = emptyState.querySelector('.empty-title');
    const descEl = emptyState.querySelector('.empty-desc');
    const quickEl = emptyState.querySelector('.quick-prompts-card');
    if (on) {
      // 如果已经有消息渲染了（比如秒开缓存），就不插入“正在同步”的占位卡
      if (messages.querySelector('.msg')) return;
      if (emptyState.parentNode !== messages) messages.appendChild(emptyState);
      if (titleEl) titleEl.textContent = '正在同步对话…';
      if (descEl) descEl.textContent = '正在从电脑端拉取最近的对话记录，请稍候。';
      if (quickEl) quickEl.style.display = 'none';
      syncTimeoutTimer = setTimeout(() => { setSyncing(false); }, 2500);
    } else {
      if (titleEl) titleEl.textContent = 'Cuckoo Remote 已就绪';
      if (descEl) descEl.textContent = '已与电脑端建立低延迟安全直连。随时在手机上发送指令、控制电脑、查看实时生成并随时中断。';
      if (quickEl) quickEl.style.display = '';
      checkEmptyState();
    }
  }

  $('token-btn').addEventListener('click', () => {
    const t = $('token-input').value.trim();
    if (!t) return;
    const serverEl = $('server-input');
    if (serverEl) {
      const raw = serverEl.value.trim();
      // APK 场景必须填地址；浏览器场景留空即用当前 origin
      if (raw) {
        const nb = normalizeBase(raw);
        if (!nb) { $('login-err').textContent = '服务器地址格式不正确'; return; }
        serverBase = nb;
        localStorage.setItem('cuckoo-server', nb);
      } else if (isNativeShell()) {
        $('login-err').textContent = '请填写电脑端地址（如 http://192.168.1.5:7788）';
        return;
      } else {
        serverBase = '';
        localStorage.removeItem('cuckoo-server');
      }
    }
    verifyAndConnect(t);
  });
  $('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('token-btn').click();
  });

  // 回填已保存的服务器地址；APK 内必须填，浏览器内可留空
  (function initServerField() {
    const el = $('server-input');
    const scanBtn = $('btn-scan');
    if (!el) return;
    const group = $('server-group');
    if (!isNativeShell()) {
      // 浏览器场景：用 location.origin 自动连，不需要用户填地址 → 隐藏整行
      if (group) group.style.display = 'none';
      if (scanBtn) scanBtn.style.display = 'none';
      return;
    }
    // 原生壳显示扫码按钮
    if (scanBtn) {
      // 清空内联 display，回落到 CSS 的 flex 布局（写死 'block' 会压过
      // style.css 的 #btn-scan{display:flex}，导致图标与文字上下错位）
      scanBtn.style.display = '';
      scanBtn.addEventListener('click', async () => {
        try {
          const cap = window.Capacitor || {};
          const BarcodeScanner = (cap.Plugins && cap.Plugins.BarcodeScanner) || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('BarcodeScanner') : null);
          if (!BarcodeScanner) {
            $('login-err').textContent = '扫码插件不可用，请手动输入地址';
            return;
          }
          const { camera } = await BarcodeScanner.requestPermissions();
          if (camera !== 'granted' && camera !== 'limited') {
            $('login-err').textContent = '未获得相机权限，请去系统设置开启';
            return;
          }
          const { barcodes } = await BarcodeScanner.scan();
          if (barcodes && barcodes.length > 0) {
            const raw = barcodes[0].rawValue;
            // 期望格式：http://ip:port/?token=xxx 或 JSON
            let parsedUrl = null;
            try { parsedUrl = new URL(raw); } catch {}
            if (parsedUrl && parsedUrl.searchParams.get('token')) {
              const tk = parsedUrl.searchParams.get('token');
              const sb = parsedUrl.origin;
              el.value = sb;
              $('token-input').value = tk;
              // 自动触发连接
              $('token-btn').click();
            } else {
              $('login-err').textContent = '二维码格式不正确';
            }
          }
        } catch (e) {
          console.warn('扫码失败', e);
          $('login-err').textContent = '扫码失败或已取消';
        }
      });
    }
    if (serverBase) el.value = serverBase;
    if (!serverBase) {
      el.placeholder = '必填：电脑端地址（如 http://192.168.1.5:7788）';
    }
  })();

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
      // D-005：token 走 Authorization 头，不进 URL（访问/代理日志）。
      const resp = await fetch(base() + '/api/ping', {
        cache: 'no-store',
        headers: { Authorization: 'Bearer ' + t },
      });
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
    // APK 首次登录也要启动前台保活（否则首个会话后台易被系统回收）
    startNativeKeepAlive();
    connect();
  }

  // ===== WebSocket =====
  function wsUrl() {
    const b = base();
    const proto = b.startsWith('https:') ? 'wss:' : 'ws:';
    const host = b.replace(/^https?:\/\//i, '');
    return proto + '//' + host + '/ws';
  }

  function connect(force = false) {
    // 增加并发防抖：如果是强制重连，先置空 ws 并打断旧的回调链
    if (!force && ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    if (foregroundProbeTimer) {
      clearTimeout(foregroundProbeTimer);
      foregroundProbeTimer = null;
    }
    // 已有消息或本地缓存时静默重连：不切"重连中"，避免切前后台/网络瞬断时状态栏闪烁。
    // 页面无任何内容（首次连接）才显示"重连中"。
    const hasContent = !!messages.querySelector('.msg') || (loadHistoryCache() || []).length > 0;
    if (!hasContent) setConn('connecting');
    const gen = ++wsGen;
    if (ws) {
      const oldWs = ws;
      ws = null; // 立即剥离引用，防止后续异步回调复用它
      try { oldWs.close(); } catch {}
    }
    let sock;
    try {
      // D-005：token 通过 Sec-WebSocket-Protocol（cuckoo.<token>）传递，不进 URL。
      sock = new WebSocket(wsUrl(), ['cuckoo.' + token]);
    } catch {
      setConn('off');
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (gen !== wsGen) { try { sock.close(); } catch {} return; }
      // 发送设备唯一 ID，通知服务端清理旧僵尸连接
      try { sock.send(JSON.stringify({ type: 'auth', clientId })); } catch {}
      connected = true;
      failStreak = 0;
      lastPong = Date.now();
      reconnectDelay = 1000;
      if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
      if (startupWatchdog) { clearTimeout(startupWatchdog); startupWatchdog = null; }
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
      // 延迟 3 秒降级：给瞬时断网/快速重连留缓冲，避免状态栏闪"已离线"。
      // 3 秒内没连回来才显示"已离线"（最多滞后 3 秒，不长期假在线）。
      // 执行态清理也放同一时机：否则"状态栏仍显示在线、执行中却被抹掉"会短暂不一致
      // （若 3 秒内重连成功，执行态应保持，等后续 tool 事件自然收尾）。
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        if (connected) return; // 已重连成功：保持执行态，不闪
        setConn('off');
        hideExec();
        setExecuting(false);
      }, 3000);
      // 清理未完成的探活定时器，避免它在断连后再次触发重连
      if (foregroundProbeTimer) {
        clearTimeout(foregroundProbeTimer);
        foregroundProbeTimer = null;
      }

      if (!token) {
        showLogin();
        return;
      }

      // 如果页面有消息或本地有缓存，绝不弹出恶心的“已断开”橙色横幅
      const hasCache = (loadHistoryCache() || []).length > 0;
      if (!messages.querySelector('.msg') && !hasCache) {
        showOffline('连接已断开，正在自动重连…');
      }
      // 失败 3 次以上时，在后台静默探测是否是令牌被电脑端重置（401）
      if (++failStreak >= 3 && failStreak % 3 === 0) {
        fetch(base() + '/api/ping', {
          cache: 'no-store',
          headers: { Authorization: 'Bearer ' + token },
        })
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

  // 切回前台：不只看"是否已断开"，还要识别"已连接但半开"（锁屏/切网后 TCP 已死，
  // ws.readyState 仍是 1，消息会静默丢失）。
  // 判据不能只看"lastPong 距今多久"：手机切后台时浏览器冻结定时器，pong 本来就会停，
  // 用时间阈值直接掐连接会把健康连接误杀（见下方 STALE_MS 注释的设计约束）。
  // 正确做法：回前台先主动发一个 ping，1.5s 内没等到 pong 才判定半开 → 立即重连。
  const FOREGROUND_PING_TIMEOUT = 1500;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !token) return;
    if (!connected) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectDelay = 1000;
      connect();
      return;
    }
    if (!ws || ws.readyState !== 1) {
      // 底层 socket 已不可用：立即重连（不依赖 onclose 是否已回调）
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectDelay = 1000;
      connect();
      return;
    }
    if (foregroundProbeTimer) return; // 已有探活在跑，避免重复
    const probeAt = Date.now();
    sendRaw({ type: 'ping' });
    foregroundProbeTimer = setTimeout(() => {
      foregroundProbeTimer = null;
      // 探活期间可能已收到 pong（lastPong 被刷新）→ 连接健康，不动它。
      // 用 >= 而非 >：probeAt 与 pong 的 Date.now() 可能落在同一毫秒，严格大于会误判半开。
      if (lastPong >= probeAt) return;
      console.warn('[Remote] 回到前台探活超时，判定连接半开，立即重连');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectDelay = 1000;
      try { ws.close(); } catch {}
      connect();
    }, FOREGROUND_PING_TIMEOUT);
  });

  // 心跳保活
  setInterval(() => {
    if (!connected) return;
    // 前台探活正在进行：让它先判定（1.5s 内必有结论），避免心跳与探活双双重连
    if (foregroundProbeTimer) return;
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
      reconnectDelay = Math.min(reconnectDelay * 1.3, 8000);
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
        profilesReady = true;
        updateProfiles(msg.profiles || [], msg.currentProfileId || '');
        break;
      case 'ai-start':
        if (!isMyProfile(msg.profileId)) break;
        // 防御性：异常顺序下可能残留旧流式气泡，先移除避免僵尸 DOM 累积
        if (streamingEl) { try { streamingEl.remove(); } catch {} }
        showExec('正在生成回复…');
        setExecuting(true);
        streamingText = '';
        STREAM_MD_INTERVAL = 120; // 新一轮对话，重置渲染节流间隔
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
      case 'ai-reply': {
        if (!isMyProfile(msg.profileId)) break;
        finishStreaming(msg.text || '');
        hideExec();
        setExecuting(false);
        // 更新本地缓存，确保刷新后能秒出最新记录
        const cache = loadHistoryCache(currentProfileId) || [];
        cache.push({ t: 'assistant', text: msg.text || '' });
        if (cache.length > 50) cache.shift();
        saveHistoryCache(cache);
        // 注意：这里**不**弹通知——ai-reply 每轮工具调用后都会到达，
        // 弹通知会变成"刷屏"。通知统一由 task-done（整个任务结束）触发。
        break;
      }
      case 'task-done': {
        if (!isMyProfile(msg.profileId)) break;
        // 整个任务结束（工具循环退出）才提醒一次
        if (document.visibilityState === 'hidden') {
          notifyReply(msg.text || '');
        }
        break;
      }
      case 'ai-stop':
        if (!isMyProfile(msg.profileId)) break;
        finishStreaming(streamingText);
        setExecuting(false);
        // reason === 'watchdog' 是电脑端的兜底收尾（网页已停、静默超阈值，
        // 常见于「最后一轮只调工具、没输出正文」的正常结束），并不是用户停止。
        // 这种收尾只做状态复位，不弹「已停止生成」，避免正常任务结束时的误报。
        // 注意：必须显式 hideExec()——该场景下 onToolEvent('end') 会把执行条
        // 置为「正在生成回复…」且 execVisible=true，不隐藏就会一直残留。
        if (msg.reason === 'watchdog') { hideExec(); break; }
        showExecBrief('已停止生成', 1500);
        showStopNotice();
        break;
      case 'history':
        if (!isMyProfile(msg.profileId)) break;
        renderHistory(msg.history || []);
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
      case 'pong':
        lastPong = Date.now();
        if (foregroundProbeTimer) {
          clearTimeout(foregroundProbeTimer);
          foregroundProbeTimer = null;
        }
        break;
    }
  }

  function isMyProfile(pid) {
    // 在收到服务端初始 profiles 之前，保守接受所有消息，避免误丢
    if (!profilesReady || !currentProfileId) return true;
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

  /** 渲染电脑端补发的对话历史（新客户端连入时）。
   *  若页面已有消息（说明正在实时收流），则跳过，避免覆盖实时内容。
   *  只渲染 user/assistant/system 三类文本消息；tool/plan 在手机端无对应卡片，跳过。 */
  function getHistoryKey() {
    const pid = currentProfileId || 'default';
    return 'cuckoo-history-' + pid;
  }
  function saveHistoryCache(entries) {
    const pid = currentProfileId || 'default';
    try {
      localStorage.setItem('cuckoo-history-' + pid, JSON.stringify(entries));
      localStorage.setItem('cuckoo-last-profile', pid);
    } catch {}
  }
  function loadHistoryCache() {
    const pid = localStorage.getItem('cuckoo-last-profile') || 'default';
    try {
      const s = localStorage.getItem('cuckoo-history-' + pid);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  }
  // 确保 currentProfileId 初始化时同步 last-profile，防止判断失准
  if (!currentProfileId) {
    currentProfileId = localStorage.getItem('cuckoo-last-profile') || '';
  }

  function renderHistory(entries, isCache = false) {
    setSyncing(false);
    if (!Array.isArray(entries) || !entries.length) {
      messages.innerHTML = '';
      checkEmptyState();
      return;
    }
    
    let prevTop = 0;
    let wasAtBottom = true;
    
    if (!isCache) {
      // 1. 判断缓存是否完全一致：如果本地已经渲染了消息，且服务端传来的与本地缓存完全一致，跳过重绘
      if (messages.querySelector('.msg')) {
        const cacheStr = JSON.stringify(entries.slice(-50));
        const localStr = localStorage.getItem(getHistoryKey());
        if (localStr === cacheStr) {
          console.log('[Remote] 历史一致，跳过重绘');
          return;
        }
      }

      // 2. 如果是真实网络回执，先重置流式状态并移除僵尸气泡
      if (streamingEl) { try { streamingEl.remove(); } catch {} }
      streamingEl = null;
      streamNode = null;
      streamingText = '';
      resetThink();
      cancelStreamMd();

      // 3. 记录滚动状态并清空容器
      prevTop = messages.scrollTop;
      wasAtBottom = stickToBottom || (messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 50);
      messages.innerHTML = '';
      saveHistoryCache(entries.slice(-50));
    } else {
      // 缓存渲染时，如果已经有消息了，就不重复渲染
      if (messages.querySelector('.msg')) return;
    }

    // 批量渲染：原实现逐条 addUser/addAi/addSystem，每条都触发
    // checkEmptyState + capMessages（各一次全量 querySelectorAll('.msg')）
    // 和 scroll(true)（强制 reflow），条数一多就是 O(n²)——实测 12 条要等 2 秒。
    // 改用 DocumentFragment 一次性插入，全量查询与滚动各只做一次。
    const frag = document.createDocumentFragment();
    let appended = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e !== 'object' || !e.text) continue;
      if (e.t === 'user') { frag.appendChild(buildUserEl(e.text)); appended++; }
      else if (e.t === 'assistant') { frag.appendChild(buildAiEl(e.text)); appended++; }
      else if (e.t === 'system') { frag.appendChild(buildSystemEl(e.text)); appended++; }
      // tool / plan：跳过（手机端无工具卡）
    }
    if (!appended) return;
    messages.appendChild(frag);
    checkEmptyState();
    capMessages();
    
    // 4. 重绘后恢复滚动位置
    if (isCache) {
      // 刚打开页面用缓存渲染：直接贴底，让用户看到最新消息
      stickToBottom = true;
      scroll(true);
    } else if (wasAtBottom) {
      // 网络重推历史且之前就在底部：保持贴底
      stickToBottom = true;
      scroll(true);
    } else {
      // 网络重推历史且用户正在上面看历史：保留位置，不强制拽底
      messages.scrollTop = prevTop;
      stickToBottom = false;
      updateScrollBtn();
    }
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
              const raw = attr.value || '';
              // 1. 去除所有控制字符（防止 java\tscript: 绕过）
              // eslint-disable-next-line no-control-regex
              const v = raw.replace(/[\x00-\x20\x7f]+/g, '').toLowerCase();
              // 2. 协议白名单校验，只允许 http/https/mailto
              const isSafe = v.startsWith('http:') || v.startsWith('https:') || v.startsWith('mailto:');
              if (isSafe) {
                child.setAttribute('target', '_blank');
                child.setAttribute('rel', 'noopener noreferrer');
              } else {
                child.removeAttribute(attr.name);
              }
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

  /** 只建元素、不插入 DOM、不做全量查询。供 renderHistory 批量渲染复用。 */
  function buildUserEl(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    // 文本包一层，防止复制按钮追加后破坏多行文本排版
    const content = document.createElement('div');
    content.textContent = text;
    el.appendChild(content);
    attachActions(el, text);
    return el;
  }

  function buildSystemEl(text) {
    const el = document.createElement('div');
    el.className = 'msg sys';
    el.textContent = text;
    return el;
  }

  function addUser(text) {
    messages.appendChild(buildUserEl(text));
    checkEmptyState();
    capMessages();
    scroll(true);
  }

  function addSystem(text) {
    messages.appendChild(buildSystemEl(text));
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
  // 用 ~80ms 节流控制性能（逐帧全量 renderMd 会累积 O(n²)；节流一次可控）。
  let streamMdTimer = null;
  let lastStreamMdAt = 0;
  // 节流间隔：动态调整。短文本 120ms 刷新保持手感，长文本 250ms 刷新防止手机 CPU 卡顿。
  let STREAM_MD_INTERVAL = 120;
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
    if (!streamingEl) {
      startStreaming();
      // 可能因重连漏掉了 ai-start 消息，补上 UI 状态
      showExec('正在生成回复…');
      setExecuting(true);
    }
    streamingText += delta;
    // 正文已出现：标记 sawText（后续 appendThink 不再自动展开，防 think/text 交替抖动）。
    // 但**不在此处折叠思考块**——否则正文一出思考就消失，用户来不及看。
    // 折叠统一推迟到收尾（finishThink），流式期间保持思考可见。
    sawText = true;
    // 动态调整渲染间隔：字数越多，解析 Markdown 越耗时，稍微拉长间隔防卡顿
    if (streamingText.length > 1500) {
      STREAM_MD_INTERVAL = 250;
    } else if (streamingText.length > 500) {
      STREAM_MD_INTERVAL = 180;
    }
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

  /** 只建 AI 消息元素，不插入 DOM、不做全量查询。供 renderHistory 批量渲染复用。
   *  decorateContent / attachActions 都是纯 DOM 操作（querySelectorAll('pre') /
   *  createElement / insertBefore / addEventListener），不依赖元素已插入文档。 */
  function buildAiEl(text) {
    const el = document.createElement('div');
    el.className = 'msg ai';
    el.innerHTML = renderMd(text);
    el.appendChild(createSigNode());
    decorateContent(el);
    attachActions(el, text);
    return el;
  }

  function addAi(text) {
    if (!text) return;
    messages.appendChild(buildAiEl(text));
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
    if (phase === 'start') {
      showExec('正在调用系统工具…');
      setExecuting(true);
    } else if (phase === 'end') {
      showExec('正在生成回复…');
    }
  }

  // ===== 执行状态条 / 发送停止按钮 =====
  let execVisible = false;
  let execBriefTimer = null;
  function showExec(text, isStopped = false) {
    if (!execStatus) return;
    if (execBriefTimer) { clearTimeout(execBriefTimer); execBriefTimer = null; }
    execText.textContent = text || '正在执行…';
    execStatus.classList.toggle('stopped', !!isStopped);
    if (!execVisible) { execStatus.classList.remove('hidden'); execVisible = true; }
  }
  function hideExec() {
    if (execBriefTimer) { clearTimeout(execBriefTimer); execBriefTimer = null; }
    if (!execStatus || !execVisible) return;
    execStatus.classList.add('hidden');
    execStatus.classList.remove('stopped');
    execVisible = false;
  }
  function showExecBrief(text, duration) {
    showExec(text, true);
    execBriefTimer = setTimeout(() => {
      execBriefTimer = null;
      hideExec();
    }, duration || 1500);
  }

  let lastStopNoticeTime = 0;
  function showStopNotice() {
    const now = Date.now();
    if (now - lastStopNoticeTime < 2500) return;
    lastStopNoticeTime = now;
    addSystem('已停止生成');
  }

  function setExecuting(on) {
    executing = on;
    stopBtn.classList.toggle('hidden', !on);
    sendBtn.classList.toggle('hidden', on);
    syncSendBtn();
  }

  // ===== 自动滚动与回到底部 FAB =====

  function isNearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= BOTTOM_THRESHOLD;
  }

  // 移动端：只要用户手指触碰聊天区，立刻认为用户要接管滚动，停止自动贴底
  messages.addEventListener('touchstart', () => {
    stickToBottom = false;
    if (scrollTimer) { cancelAnimationFrame(scrollTimer); scrollTimer = null; }
    updateScrollBtn();
  }, { passive: true });

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
      stickToBottom = true;
      if (scrollTimer) { cancelAnimationFrame(scrollTimer); scrollTimer = null; }
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
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    if (sendRaw({ type: 'send', text })) {
      showExec('正在生成回复…');
      setExecuting(true);
    } else {
      if (sendQueue.length >= MAX_QUEUE) sendQueue.shift();
      sendQueue.push(text);
      showOffline('离线中，消息将在重连后自动发送');
    }
  }

  sendBtn.addEventListener('click', doSend);
  stopBtn.addEventListener('click', () => {
    if (!sendRaw({ type: 'stop' })) {
      // 发送失败（连接半开/断开）：不能静默——用户以为停了，实际没停
      addSystem('连接已断开，停止指令未送达，正在重连…');
    } else {
      showStopNotice();
    }
    finishStreaming(streamingText);
    showExecBrief('已停止生成', 1500);
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
  let draftTimer = null;
  input.addEventListener('input', () => {
    autoGrow();
    syncSendBtn();
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      try {
        if (input.value) {
          localStorage.setItem(DRAFT_KEY, input.value);
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch {}
    }, 500);
  });
  syncSendBtn();

  reconnectBtn.addEventListener('click', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 1000;
    failStreak = 0;
    connect(true); // 强制重连，忽略当前可能处于 CONNECTING/OPEN 的假死状态
  });

  profileSelect.addEventListener('change', () => {
    currentProfileId = profileSelect.value;
    syncProfileLabel();
    resetView();
    // 显示"正在同步对话…"，避免用户看到"已就绪"空态以为没内容
    setSyncing(true);
    sendRaw({ type: 'select-profile', profileId: profileSelect.value });
  });

  // ===== 工具函数 =====
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  // ===== 本地通知（仅 APK 生效）=====
  let notifyChannelReady = false;
  async function notifyReply(text) {
    try {
      if (!isNativeShell()) return;
      const cap = window.Capacitor || {};
      let plugin = cap.Plugins && cap.Plugins.LocalNotifications;
      if (!plugin && typeof cap.registerPlugin === 'function') {
        try { plugin = cap.registerPlugin('LocalNotifications'); } catch {}
      }
      if (!plugin) return;
      
      const perm = await plugin.checkPermissions();
      if (perm.display !== 'granted') {
        const req = await plugin.requestPermissions();
        if (req.display !== 'granted') return;
      }
      // Android 8+ 必须显式创建通知渠道，否则通知无声/不弹；同 id 幂等，但仍省一次跨桥调用
      if (!notifyChannelReady) {
        try {
          await plugin.createChannel({
            id: 'cuckoo_notify',
            name: 'Cuckoo 任务通知',
            description: 'AI 任务完成时提醒',
            importance: 5,
            visibility: 1,
            sound: 'default',
            vibration: true,
          });
          notifyChannelReady = true;
        } catch { /* 建渠道失败不阻断通知 */ }
      }
      
      
      const title = 'Cuckoo 回复完成';
      // 按 Unicode 码点截断，避免切坏 emoji 代理对；正文是纯文本/markdown，不做 HTML 剥离
      const body = text ? (Array.from(String(text)).slice(0, 100).join('') || '任务已结束') : '任务已结束';
      
      // 不传 schedule = 立即显示。避免 Android 12+ 因缺少 SCHEDULE_EXACT_ALARM 导致精确闹钟调度失败。
      await plugin.schedule({
        notifications: [{
          id: Date.now() % 2147483647,
          title,
          body,
          smallIcon: 'ic_stat_cuckoo',
          channelId: 'cuckoo_notify',
        }]
      });
    } catch (e) {
      console.warn('[Notify] 弹出失败', e);
    }
  }

  // ===== 原生保活（仅 APK 生效）=====
  /** 电池优化白名单"已请求过"标记（localStorage），保证只弹一次系统页 */
  const BATTERY_REQ_KEY = 'cuckoo-battery-opt-req';
  function startNativeKeepAlive() {
    try {
      if (!isNativeShell()) return;
      const cap = window.Capacitor || {};
      // Capacitor 8：手动注册的原生插件需要用 registerPlugin 动态获取代理
      let plugin = null;
      if (cap.Plugins && cap.Plugins.KeepAlive) plugin = cap.Plugins.KeepAlive;
      if (!plugin && typeof cap.registerPlugin === 'function') {
        try { plugin = cap.registerPlugin('KeepAlive'); } catch {}
      }
      if (!plugin) {
        console.warn('[KeepAlive] 插件不可用，保活功能降级');
        return;
      }
      plugin.start()
        .then(() => console.log('[KeepAlive] 前台服务已启动'))
        .catch((e) => console.warn('[KeepAlive] start 失败:', e));
      plugin.checkBatteryOptimization()
        .then((res) => {
          console.log('[KeepAlive] 电池优化状态:', JSON.stringify(res));
          const isIgnoring = Boolean(res && (res.ignoring === true || res.isIgnoring === true));
          // 已加白名单：清掉"已请求"标记，便于用户日后移除白名单时能再次提示
          if (isIgnoring) {
            try { localStorage.removeItem(BATTERY_REQ_KEY); } catch {}
            return;
          }
          // 未加白名单（false / null / undefined 等任何非 true 状态）：只主动请求一次，避免每次进 App 都跳系统电量详情页
          let asked = false;
          try { asked = localStorage.getItem(BATTERY_REQ_KEY) === '1'; } catch {}
          if (asked) return;
          try { localStorage.setItem(BATTERY_REQ_KEY, '1'); } catch {}
          console.log('[KeepAlive] 电池优化未放行，请求白名单（仅首次）…');
          plugin.requestIgnoreBatteryOptimization().catch(() => {});
        })
        .catch(() => {});
    } catch (e) {
      console.warn('[KeepAlive] 调用异常:', e);
    }
  }


  // ===== 应用图标切换（仅 APK 生效）=====
  /** 图标 id → 展示名 + 预览地址（4 张图放 PWA 静态目录，随编译复制到 out） */
  const APP_ICON_META = [
    { id: 'default', label: '默认', src: '/app-icons/default.png' },
    { id: 'glass',   label: '玻璃鸟', src: '/app-icons/glass.png' },
    { id: 'sticker', label: '像素贴纸', src: '/app-icons/sticker.png' },
    { id: 'gold',    label: '深蓝金鸟', src: '/app-icons/gold.png' },
  ];

  /** 获取 AppIcon 插件代理；非 APK 环境返回 null */
  function getAppIconPlugin() {
    if (!isNativeShell()) return null;
    try {
      const cap = window.Capacitor || {};
      if (cap.Plugins && cap.Plugins.AppIcon) return cap.Plugins.AppIcon;
      if (typeof cap.registerPlugin === 'function') {
        try { return cap.registerPlugin('AppIcon'); } catch {}
      }
    } catch (e) {
      console.warn('[AppIcon] 插件获取异常:', e);
    }
    return null;
  }

  /** 极简本地 toast（仅图标切换用，避免引入全局 toast 依赖） */
  let iconToastEl = null;
  function showIconToast(msg, isError) {
    if (!iconToastEl) {
      iconToastEl = document.createElement('div');
      iconToastEl.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);' +
        'padding:10px 16px;border-radius:10px;font-size:13px;z-index:1000;' +
        'background:rgba(20,22,26,0.92);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.3);' +
        'opacity:0;transition:opacity 0.2s;pointer-events:none;max-width:80vw;text-align:center;';
      document.body.appendChild(iconToastEl);
    }
    iconToastEl.textContent = msg;
    if (isError) iconToastEl.style.background = 'rgba(190,40,40,0.95)';
    else iconToastEl.style.background = 'rgba(20,22,26,0.92)';
    iconToastEl.style.opacity = '1';
    clearTimeout(iconToastEl._t);
    iconToastEl._t = setTimeout(() => { iconToastEl.style.opacity = '0'; }, 2200);
  }

  /** 初始化图标切换 UI（仅原生壳） */
  function initAppIconSwitcher() {
    const plugin = getAppIconPlugin();
    if (!plugin) return;

    const btn = $('btn-app-icon');
    const sheet = $('icon-sheet');
    const grid = $('icon-sheet-grid');
    const backdrop = $('icon-sheet-backdrop');
    const closeBtn = $('icon-sheet-close');
    if (!btn || !sheet || !grid) return;

    btn.style.display = '';
    let currentId = '';

    function setActive(id) {
      currentId = id;
      grid.querySelectorAll('.icon-card').forEach((el) => {
        el.classList.toggle('active', el.dataset.id === id);
      });
    }

    let availableIds = null;   // 由后端 get() 返回；null 表示尚未知（先全渲染）
    function render() {
      grid.innerHTML = '';
      const list = availableIds
        ? APP_ICON_META.filter((m) => availableIds.includes(m.id))
        : APP_ICON_META;
      if (list.length === 0) {
        // 后端明确返回空白名单 —— 显式空态，避免渲染出可点击但必然失败的卡片
        const empty = document.createElement('div');
        empty.className = 'icon-sheet-empty';
        empty.textContent = '当前设备暂不支持更换图标';
        grid.appendChild(empty);
        return;
      }
      list.forEach((meta) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'icon-card';
        card.dataset.id = meta.id;
        card.innerHTML =
          '<img class="icon-card-img" src="' + meta.src + '" alt="' + meta.label + '" loading="lazy" />' +
          '<span class="icon-card-label">' + meta.label + '</span>';
        card.addEventListener('click', () => switchIcon(meta.id));
        grid.appendChild(card);
      });
    }

    let switching = false;
    /** 超时竞速：原生侧若挂起，避免 switching 单飞锁永久死锁 */
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('原生调用超时')), ms)),
      ]);
    }

    async function switchIcon(id) {
      if (switching) return;              // 并发防护：切换中忽略点击
      if (id === currentId) { closeSheet(); return; }
      switching = true;
      grid.classList.add('busy');
      try {
        const res = await withTimeout(plugin.set({ id }), 8000);
        const applied = (res && res.current) || id;
        setActive(applied);
        // toast 合并：只发一条，warning 优先显示，避免同 tick 覆盖
        if (res && res.warning) {
          showIconToast('已切换，但' + res.warning, true);
        } else if (res && res.changed) {
          showIconToast('图标已切换，桌面将在几秒内更新');
        }
        closeSheet();
      } catch (e) {
        console.warn('[AppIcon] 切换失败:', e);
        showIconToast('切换失败：' + (e && e.message ? e.message : e), true);
      } finally {
        switching = false;
        grid.classList.remove('busy');
      }
    }

    function openSheet() {
      if (sheet.classList.contains('hidden')) {
        sheet.classList.remove('hidden');
      }
    }
    function closeSheet() {
      sheet.classList.add('hidden');
    }

    btn.addEventListener('click', openSheet);
    if (backdrop) backdrop.addEventListener('click', closeSheet);
    if (closeBtn) closeBtn.addEventListener('click', closeSheet);

    // Esc 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !sheet.classList.contains('hidden')) closeSheet();
    });
    render();
    // 读取当前图标（失败不阻断，UI 仍可用）
    plugin.get()
      .then((res) => {
        if (!res) return;
        if (Array.isArray(res.available)) {
          availableIds = res.available;   // 空数组语义为"无可用"，render 会渲染空态
          render();
        }
        if (res.current) setActive(res.current);
      })
      .catch((e) => console.warn('[AppIcon] get 失败:', e));
  }

  // ===== 启动 =====
  // 恢复草稿（手机切后台被系统杀进程 reload 时，避免用户打字丢失）
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) {
      input.value = draft;
      autoGrow();
      syncSendBtn();
    }
  } catch {}

  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    token = urlToken;
    localStorage.setItem('cuckoo-token', token);
    try { history.replaceState(null, '', location.pathname); } catch {}
  }

  // 原生壳（APK）里必须有 serverBase 才能自动连接；否则回登录页让用户填地址
  const canAutoConnect = !!token && (!!serverBase || !isNativeShell());
  if (canAutoConnect) {
    showApp();
    // 启动时先不展示同步动画
    setSyncing(false);
    
    // 极速渲染本地缓存
    const cached = loadHistoryCache();
    const hasCache = cached && cached.length;
    if (hasCache) renderHistory(cached, true);
    // 乐观显示"已在线"仅限原生壳（APK 有前台保活托底，切回/冷启动无感），配 8 秒看门狗：
    // 8 秒内仍未真正连上则降级"已离线"，既无感又不长期假在线。
    // 浏览器场景诚实从"连接中"起步——无保活兜底，乐观显示会假在线。
    if (hasCache && isNativeShell()) {
      setConn('on');
      startupWatchdog = setTimeout(() => {
        startupWatchdog = null;
        if (!connected) setConn('off');
      }, 8000);
    } else {
      setConn('connecting');
    }
    
    // 原生壳：启动前台服务保活
    startNativeKeepAlive();
    // 原生壳：初始化图标切换 UI
    initAppIconSwitcher();

    // 后台发起真正连接
    connect();
    
    // 如果是从后台切回前台导致的 reload，稍微提示一下正在拉取最新
    setTimeout(() => {
      if (connected === false && hasCache) {
        console.log('[Remote] 正在后台重新建立连接...');
      }
    }, 500);
  } else {
    showLogin();
    if (token && isNativeShell() && !serverBase) {
      const err = $('login-err');
      if (err) err.textContent = '请先填写电脑端地址再连接';
    }
    // 回填 token，避免用户重复输入
    if (token) {
      const ti = $('token-input');
      if (ti) ti.value = token;
    }
  }
})();
