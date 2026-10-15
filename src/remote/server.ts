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
  /** 收到手机上传附件（base64）；返回是否成功 */
  onAttach?: (file: { name: string; data: string; mime: string }) => Promise<{ success: boolean; error?: string }>;
  /** 取窗口列表（供手机端选择器） */
  onListProfiles?: () => any[];
  /** 取当前目标窗口 id */
  onGetCurrentProfile?: () => string;
  /** 切换目标窗口 */
  onSelectProfile?: (profileId: string) => void;
  /** 新客户端连入（供主进程补发当前流式状态，避免重连后丢消息） */
  onNewClient?: () => void;
}

let httpServer: http.Server | null = null;
let wss: any = null;
let currentPort = 0;
let currentToken = '';
let heartbeatTimer: any = null;
let deps: ServerDeps = { onUserMessage: () => {} };
const clients = new Set<any>();

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
function checkToken(req: http.IncomingMessage): boolean {
  if (!currentToken) return false;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === 'Bearer ' + currentToken) return true;
  const url = parseUrl(req);
  return !!(url && url.searchParams.get('token') === currentToken);
}

/** 静态文件响应（PWA 资源；防路径穿越）。异步读盘，避免阻塞主进程事件循环 */
async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch (_) {}
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '');
  const abs = path.resolve(PWA_DIR, rel);
  const prefix = PWA_DIR.endsWith(path.sep) ? PWA_DIR : PWA_DIR + path.sep;
  if (abs !== PWA_DIR && !abs.startsWith(prefix)) { res.writeHead(403); res.end('forbidden'); return; }
  let isFile = false;
  try { isFile = (await fs.promises.stat(abs)).isFile(); } catch (_) { isFile = false; }
  if (!isFile) { res.writeHead(404); res.end('not found'); return; }
  try {
    const buf = await fs.promises.readFile(abs);
    res.writeHead(200, { 'Content-Type': guessMime(abs), 'Cache-Control': 'no-cache' });
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
  void serveStatic(res, url.pathname).catch(() => {});
}

/** WS 单条消息上限（防超大文本放大 JSON/IPC/渲染成本） */
const MAX_WS_MSG = 12 * 1024 * 1024; // 12MB（含 base64 图片，编码后约 1.33x）
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
    try { deps.onSelectProfile && deps.onSelectProfile(msg.profileId); } catch (_) {}
    return;
  }
  if (msg.type === 'stop') {
    try { deps.onStop && deps.onStop(); } catch (_) {}
    return;
  }
  if (msg.type === 'attach') {
    const name = typeof msg.name === 'string' ? msg.name : 'image.png';
    const data = typeof msg.data === 'string' ? msg.data : '';
    const mime = typeof msg.mime === 'string' ? msg.mime : 'application/octet-stream';
    if (!data) return;
    const reply = (r: any) => { try { ws.send(JSON.stringify({ type: 'attach-result', name, ...r })); } catch (_) {} };
    if (!deps.onAttach) { reply({ success: false, error: 'unsupported' }); return; }
    Promise.resolve(deps.onAttach({ name, data, mime }))
      .then((r) => reply(r || { success: false }))
      .catch((err) => reply({ success: false, error: (err && err.message) || 'attach-failed' }));
  }
}

/** 建立 WS 连接后的初始化握手 */
function onWsConnection(ws: any): void {
  clients.add(ws);
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
  // 新客户端连入：通知主进程补发当前流式状态（重连后不丢消息）
  try { deps.onNewClient && deps.onNewClient(); } catch (_) {}
}

/** 服务端心跳：每 30s ping 一次，连续 3 次无 pong（约 120s，含首次）视为死连接并断开。
 *  放宽原因：手机端切后台时浏览器会冻结 JS 定时器，其应用层 pong 可能短暂停止；
 *  给足恢复时间，避免"熄屏几分钟回来必断"。真正的半开连接由约 120s 兜底清理。 */
function startHeartbeat(): any {
  return setInterval(() => {
    for (const c of clients) {
      if (c.isAlive === false) {
        c.missedPongs = (c.missedPongs || 0) + 1;
        if (c.missedPongs >= 3) { try { c.terminate(); } catch (_) {} clients.delete(c); continue; }
      } else {
        c.missedPongs = 0;
      }
      c.isAlive = false;
      try { c.ping(); } catch (_) {}
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
    wss.on('connection', onWsConnection);
    httpServer.on('error', (err: any) => {
      httpServer = null; wss = null; currentPort = 0;
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
    for (const c of clients) { try { c.terminate(); } catch (_) {} }
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
  for (const c of clients) {
    try { if (c.readyState === 1) c.send(msg); } catch (_) {}
  }
}

function getPort(): number { return currentPort; }
function isRunning(): boolean { return !!httpServer; }
function getClientCount(): number { return clients.size; }

export { startServer, stopServer, broadcast, getPort, isRunning, getClientCount };
export type { ServerDeps };
