/**
 * 远程控制：HTTP + WebSocket 服务
 *
 * 绑 127.0.0.1，由 CF 隧道转发到公网。
 * - 静态托管 PWA（手机端页面）
 * - WebSocket 实时双向通信
 * - Token 鉴权（HTTP header 或 WS query param）
 *
 * 不依赖 electron（用注入回调与主进程交互），便于测试。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer } = require('ws');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PWA_DIR = (() => {
  const outDir = path.join(__dirname, 'pwa');
  if (fs.existsSync(outDir)) return outDir;
  // 兜底：开发环境冷启动未编译时，回退查找源码目录
  const srcDir = path.resolve(__dirname, '../../../src/remote/pwa');
  if (fs.existsSync(srcDir)) return srcDir;
  return outDir;
})();

/** 注入依赖（与主进程交互，避免 remote 直接依赖 electron） */
interface ServerDeps {
  /** 收到手机用户消息（主进程实现：转发给目标 AI 页面） */
  onUserMessage: (text: string) => void;
  /** 收到手机"停止生成"请求 */
  onStop?: () => void;
  /** 取窗口列表（供手机端选择器） */
  onListProfiles?: () => any[];
  /** 取当前目标窗口 id */
  onGetCurrentProfile?: () => string;
  /** 切换目标窗口 */
  onSelectProfile?: (profileId: string, ws?: any) => void;
  /** 新客户端连入（供主进程补发当前流式状态 + 历史，避免重连后丢消息） */
  onNewClient?: (ws: any) => void;
}

let httpServer: http.Server | null = null;
let wss: any = null;
let currentPort = 0;
let currentToken = '';
let heartbeatTimer: any = null;
let deps: ServerDeps = { onUserMessage: () => {} };
interface ClientInfo {
  ip: string;
  ua: string;
  connectedAt: number;
  clientId?: string;
}
const clients = new Map<any, ClientInfo>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function guessMime(p: string): string {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/** 解析请求 URL（失败返回 null） */
function parseUrl(req: http.IncomingMessage): URL | null {
  try { return new URL(req.url || '/', 'http://127.0.0.1'); } catch (_) { return null; }
}

/** 校验 token：header 优先，其次 query */
/**
 * D-006：常量时间比较 token，防计时侧信道。
 * 长度不一致直接失败（timingSafeEqual 对异长 buffer 会抛错，前置判断）。
 */
function safeTokenEqual(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate || !currentToken) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(currentToken);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/** D-005：从 Sec-WebSocket-Protocol 提取 token（形如 `cuckoo.<token>`，不进 URL 日志）。 */
function tokenFromSubprotocol(req: http.IncomingMessage): string | null {
  const sub = req.headers['sec-websocket-protocol'];
  if (typeof sub !== 'string' || !sub) return null;
  for (const part of sub.split(',')) {
    const v = part.trim();
    if (v.startsWith('cuckoo.')) return v.slice('cuckoo.'.length);
  }
  return null;
}

function checkToken(req: http.IncomingMessage): boolean {
  if (!currentToken) return false;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && safeTokenEqual(auth.slice('Bearer '.length))) {
    return true;
  }
  // D-005：WS 握手首选 Sec-WebSocket-Protocol（不进访问日志/代理日志）。
  const subToken = tokenFromSubprotocol(req);
  if (subToken !== null && safeTokenEqual(subToken)) return true;
  // 过渡兼容：URL query token（旧客户端/测试仍可用）。
  const url = parseUrl(req);
  return !!(url && safeTokenEqual(url.searchParams.get('token')));
}

/**
 * 静态资源缓存策略：
 *  - index.html：no-cache（每次都验证，但命中 ETag 返回 304，不传 body）
 *  - 其它资源：public, max-age=31536000, immutable（一年强缓存，二次打开零网络）
 * ETag 用 `W/"<mtimeMs 保留小数>-<size>"`：**必须保留毫秒精度**。
 * 曾用 Math.floor(mtimeMs) 截断到秒，导致"同一秒内两次编译 + 文件大小不变"时
 * ETag 不变，浏览器会把旧内容当成新内容（内测高频编译会踩）。
 */
function etagFor(st: fs.Stats): string {
  return 'W/"' + st.mtimeMs + '-' + st.size + '"';
}

function cacheControlFor(rel: string): string {
  return rel === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
}

/** 需要 URL 版本化（`?v=<mtime>`）的静态资源：文件变了 URL 就变，
 *  Cloudflare 等边缘 CDN 自然缓存不到旧内容。
 *  背景：CF 会把 `immutable` 的响应缓存一年，即使源站后来改了内容，
 *  边缘仍返回旧缓存（`cf-cache-status: HIT` + `age` 数万秒）——实测踩过：
 *  发版后手机端一直跑旧 app.js，因为 CF 边缘命中了几天前的缓存。 */
const VERSIONED_ASSETS = ['app.js', 'style.css', 'marked.umd.js'];

/** 资源名 → mtime 版本号缓存（避免每次请求都 stat 三个文件） */
const assetVersionCache = new Map<string, { mtime: number; size: number; v: number }>();

/** 取某资源的版本号（= mtimeMs 取整）。文件变了版本号就变。 */
async function assetVersion(name: string): Promise<number> {
  const abs = path.join(PWA_DIR, name);
  let st: fs.Stats | null = null;
  try { st = await fs.promises.stat(abs); } catch (_) { return 0; }
  const cached = assetVersionCache.get(name);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.v;
  const v = Math.floor(st.mtimeMs);
  assetVersionCache.set(name, { mtime: st.mtimeMs, size: st.size, v });
  return v;
}

/** 把 index.html 里的静态资源引用改成带 `?v=<mtime>` 的版本化 URL。
 *  正则允许单/双引号 + 可选前导斜杠，避免 HTML 改用单引号后静默失效。 */
async function versionizeHtml(html: string): Promise<string> {
  const versions = await Promise.all(VERSIONED_ASSETS.map((n) => assetVersion(n)));
  const map = new Map(VERSIONED_ASSETS.map((n, i) => [n, versions[i]]));
  const names = VERSIONED_ASSETS.map((n) => n.replace(/\./g, '\\.')).join('|');
  const re = new RegExp('(src|href)=([\'"])\\/?(' + names + ')\\2', 'g');
  return html.replace(re, (_m, attr: string, q: string, file: string) => {
    return attr + '=' + q + '/' + file + '?v=' + (map.get(file) || 0) + q;
  });
}

/** index.html 的 ETag：必须**纳入内嵌资源版本**，否则只更新 app.js 时
 *   index.html 的 mtime/size 不变 → ETag 不变 → 浏览器 304 → 继续用旧 ?v=
 *   → 版本化形同虚设。
 *   实测确认 `npm run compile` 用 fs.cpSync 保留源文件 mtime，index.html 确实不变。 */
async function etagForIndex(st: fs.Stats): Promise<string> {
  const versions = await Promise.all(VERSIONED_ASSETS.map((n) => assetVersion(n)));
  return 'W/"' + st.mtimeMs + '-' + st.size + '-' + versions.join('-') + '"';
}

/** 静态文件响应（PWA 资源；防路径穿越）。异步读盘，避免阻塞主进程事件循环 */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: URLSearchParams): Promise<void> {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch (_) {}
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '');
  const abs = path.resolve(PWA_DIR, rel);
  const prefix = PWA_DIR.endsWith(path.sep) ? PWA_DIR : PWA_DIR + path.sep;
  if (abs !== PWA_DIR && !abs.startsWith(prefix)) { res.writeHead(403); res.end('forbidden'); return; }
  let st: fs.Stats | null = null;
  try { st = await fs.promises.stat(abs); } catch (_) { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }

  // index.html 的 ETag 必须纳入内嵌资源版本（见 etagForIndex 注释）；
  // 其它资源用自身 stat 即可。
  const etag = rel === 'index.html' ? await etagForIndex(st) : etagFor(st);
  // 带 `?v=` 的资源：URL 已按内容版本化，可放心长期强缓存（CF/浏览器都不会拿错）。
  // 不带 `?v=` 的：沿用原策略（index.html no-cache，其余 immutable）。
  const hasVersion = search.has('v');
  const cacheControl = hasVersion
    ? 'public, max-age=31536000, immutable'
    : cacheControlFor(rel);
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }

  try {
    let buf = await fs.promises.readFile(abs);
    // index.html 动态注入资源版本号，让后续发版能绕过 CDN 缓存
    if (rel === 'index.html') {
      try { buf = Buffer.from(await versionizeHtml(buf.toString('utf8'))); } catch (_) { /* 失败就用原内容 */ }
    }
    res.writeHead(200, {
      'Content-Type': guessMime(abs),
      'Cache-Control': cacheControl,
      'ETag': etag,
    });
    res.end(buf);
  } catch (err: any) {
    // 客户端可能已断开/已发头，避免 ERR_HTTP_HEADERS_SENT
    if (!res.headersSent) {
      try { res.writeHead(500); } catch (_) {}
    }
    try { res.end(String(err && err.message ? err.message : err)); } catch (_) {}
  }
}

/** HTTP 请求处理 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = parseUrl(req);
  if (!url) { res.writeHead(400); res.end('bad request'); return; }
  // API / WS 路径需鉴权
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    if (!checkToken(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404); res.end('not found');
    return;
  }
  // 静态资源（页面本身不敏感；连 WS 时才鉴权）
  // serveStatic 为异步（非阻塞主进程），内部已兜底所有异常，此处防御性 catch
  void serveStatic(req, res, url.pathname, url.searchParams).catch(() => {});
}

/** WS 单条消息上限（防超大文本放大 JSON/IPC/渲染成本） */
const MAX_WS_MSG = 2 * 1024 * 1024; // 2MB（手机端传图已移除，仅文本消息）
const MAX_TEXT_LEN = 100000; // 文本消息上限 10 万字符

/** WS 消息处理 */
function handleWsMessage(ws: any, raw: any): void {
  const rawStr = String(raw);
  if (rawStr.length > MAX_WS_MSG) {
    try { ws.send(JSON.stringify({ type: 'sys', text: '消息过大，已忽略' })); } catch (_) {}
    return;
  }
  let msg: any;
  try { msg = JSON.parse(rawStr); } catch (_) { return; }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'auth') {
    const cid = typeof msg.clientId === 'string' ? msg.clientId : '';
    if (cid && /^[A-Za-z0-9_-]{1,64}$/.test(cid)) {
      const info = clients.get(ws);
      if (info) info.clientId = cid;
      for (const [oldWs, oldInfo] of clients.entries()) {
        if (oldWs !== ws && oldInfo.clientId === cid) {
          try { oldWs.terminate(); } catch (_) {}
          clients.delete(oldWs);
        }
      }
    }
    return;
  }

  if (msg.type === 'ping') {
    try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
    return;
  }
  if (msg.type === 'send') {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) return;
    if (text.length > MAX_TEXT_LEN) {
      try { ws.send(JSON.stringify({ type: 'sys', text: '消息过长（上限 10 万字符）' })); } catch (_) {}
      return;
    }
    try { deps.onUserMessage(text); } catch (_) {}
    return;
  }
  if (msg.type === 'select-profile' && typeof msg.profileId === 'string') {
    // 传入 ws：切换窗口后需要给该客户端补发新窗口的历史
    try { deps.onSelectProfile && deps.onSelectProfile(msg.profileId, ws); } catch (_) {}
    return;
  }
  if (msg.type === 'stop') {
    try { deps.onStop && deps.onStop(); } catch (_) {}
    return;
  }
}

/** 建立 WS 连接后的初始化握手 */
function onWsConnection(ws: any, req: any): void {
  let ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (Array.isArray(ip)) ip = ip[0];
  if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) ip = ip.substring(7);
  if (typeof ip !== 'string' || !ip) ip = 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  clients.set(ws, { ip, ua, connectedAt: Date.now() });
  ws.isAlive = true;
  ws.missedPongs = 0;
  try {
    ws.send(JSON.stringify({
      type: 'ready',
      profiles: deps.onListProfiles ? deps.onListProfiles() : [],
      currentProfileId: deps.onGetCurrentProfile ? deps.onGetCurrentProfile() : '',
    }));
  } catch (_) {}
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw: any) => handleWsMessage(ws, raw));
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => { clients.delete(ws); });
  // 新客户端连入：通知主进程补发当前流式状态 + 历史（重连后不丢消息）
  try { deps.onNewClient && deps.onNewClient(ws); } catch (_) {}
}

/** 服务端心跳：每 30s ping 一次，连续 3 次无 pong（约 120s，含首次）视为死连接并断开。
 *  放宽原因：手机端切后台时浏览器会冻结 JS 定时器，其应用层 pong 可能短暂停止；
 *  给足恢复时间，避免"熄屏几分钟回来必断"。真正的半开连接由约 120s 兜底清理。 */
function startHeartbeat(): any {
  return setInterval(() => {
    for (const ws of clients.keys()) {
      if (ws.isAlive === false) {
        ws.missedPongs = (ws.missedPongs || 0) + 1;
        if (ws.missedPongs >= 3) { try { ws.terminate(); } catch (_) {} clients.delete(ws); continue; }
      } else {
        ws.missedPongs = 0;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);
}

/** 启动服务（幂等） */
function startServer(d: ServerDeps, port: number, token: string): Promise<{ ok: boolean; port?: number; error?: string }> {
  return new Promise((resolve) => {
    if (httpServer) return resolve({ ok: true, port: currentPort });
    deps = d;
    currentToken = token;
    httpServer = http.createServer(handleRequest);
    wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      if (!checkToken(req)) {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (_) {}
        socket.destroy();
        return;
      }
      const url = parseUrl(req);
      if (!url || url.pathname !== '/ws') {
        try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch (_) {}
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: any) => { wss.emit('connection', ws, req); });
    });
    wss.on('connection', (ws: any, req: any) => onWsConnection(ws, req));
    httpServer.on('error', (err: any) => {
      httpServer = null; wss = null; currentPort = 0;
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      clients.clear();
      resolve({ ok: false, error: err.message });
    });
    httpServer.listen(port, '127.0.0.1', () => {
      const addr = httpServer && httpServer.address();
      currentPort = typeof addr === 'object' && addr ? addr.port : port;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = startHeartbeat();
      console.log('[Remote] 服务已启动: http://127.0.0.1:' + currentPort);
      resolve({ ok: true, port: currentPort });
    });
  });
}

/** 停止服务 */
function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    for (const ws of clients.keys()) { try { ws.terminate(); } catch (_) {} }
    clients.clear();

    const oldWss = wss;
    const oldHttp = httpServer;
    wss = null;
    httpServer = null;
    currentPort = 0;

    let pending = 0;
    const done = () => {
      pending--;
      if (pending <= 0) {
        console.log('[Remote] 服务已停止');
        resolve();
      }
    };

    if (oldWss) {
      pending++;
      try { oldWss.close(() => done()); } catch (_) { done(); }
    }
    if (oldHttp) {
      pending++;
      try { (oldHttp as any).closeAllConnections?.(); } catch (_) {}
      try { oldHttp.close(() => done()); } catch (_) { done(); }
    }
    if (pending === 0) {
      console.log('[Remote] 服务已停止');
      resolve();
    }
  });
}

/** 广播消息给所有已连接客户端 */
function broadcast(payload: any): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of clients.keys()) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (_) {}
  }
}

/** 只发给单个客户端（用于新连入时补发历史，避免打扰其它已连客户端） */
function sendToClient(ws: any, payload: any): void {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload)); } catch (_) { /* ignore */ }
}

function getPort(): number { return currentPort; }
function isRunning(): boolean { return !!httpServer; }
function getClientCount(): number { return clients.size; }

function getClientList() {
  const list: any[] = [];
  for (const [ws, info] of clients.entries()) {
    list.push({ ip: info.ip, ua: info.ua, connectedAt: info.connectedAt });
  }
  return list;
}

export { startServer, stopServer, broadcast, sendToClient, getPort, isRunning, getClientCount, getClientList };
export type { ServerDeps };
