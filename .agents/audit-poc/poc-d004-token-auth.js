/**
 * PoC-D-004/005: 验证 remote HTTP 服务的 token 鉴权逻辑
 *
 * 静态推演 + 单元级调用 checkToken 逻辑：
 *   - 无 token → 401
 *   - 错误 token → 401
 *   - 正确 token（header）→ 200
 *   - 正确 token（query param）→ 200（但 token 出现在 URL 里）
 *   - 静态资源（/）不鉴权
 *   - token 比较用 ===（非常量时间）
 */

// 从 src/remote/server.ts 原样复制的 checkToken 逻辑
let currentToken = 'a'.repeat(32); // 模拟 genToken() 输出

function checkToken(req) {
  if (!currentToken) return false;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === 'Bearer ' + currentToken) return true;
  // 从 URL 取 query token
  const url = new URL(req.url, 'http://127.0.0.1');
  return !!(url && url.searchParams.get('token') === currentToken);
}

console.log('=== checkToken 逻辑验证 ===\n');

const cases = [
  ['无 token', { headers: {}, url: '/api/ping' }, false],
  ['错误 token (header)', { headers: { authorization: 'Bearer wrong' }, url: '/api/ping' }, false],
  ['正确 token (header)', { headers: { authorization: 'Bearer ' + currentToken }, url: '/api/ping' }, true],
  ['正确 token (query)', { headers: {}, url: '/api/ping?token=' + currentToken }, true],
  ['部分匹配 token', { headers: { authorization: 'Bearer ' + 'a'.repeat(31) }, url: '/api/ping' }, false],
  ['空 token', { headers: {}, url: '/api/ping?token=' }, false],
];

for (const [name, req, expected] of cases) {
  const actual = checkToken(req);
  console.log(`  ${actual === expected ? 'PASS' : 'FAIL'} | ${name} → ${actual} (期望 ${expected})`);
}

console.log('\n=== 鉴权覆盖范围（server.ts:111-128）===');
console.log('  /api/*       → 需 token');
console.log('  /ws          → 需 token（upgrade 时 checkToken）');
console.log('  /（静态资源）→ 不鉴权 ← 任意人可加载 PWA 页面，但页面本身不敏感');
console.log('  其他路径     → 不鉴权（静态文件）');

console.log('\n=== 风险点 ===');
console.log('1. token 通过 query ?token= 传递（server.ts:83）：');
console.log('   - WS 连接时 token 出现在 URL 里 → CF 隧道访问日志 / 浏览器历史 / Referer 泄漏');
console.log('   - 修复：WS 握手改用 Sec-WebSocket-Protocol 头或 cookie 传递 token');
console.log('');
console.log('2. token 比较用 ===（server.ts:81,83）：非常量时间比较');
console.log('   - 理论上 timing attack 可逐字节猜 token，但 32 位 hex（16 字节随机）通过网络 timing 不现实');
console.log('   - 修复：crypto.timingSafeEqual');
console.log('');
console.log('3. 无 Origin/CSRF 校验：');
console.log('   - 任意 evil.com 网页可向 http://127.0.0.1:7799 发 fetch');
console.log('   - 但 API 都需 token，且跨域 fetch 受 CORS 限制（无 Access-Control-Allow-Origin）');
console.log('   - WS 连接可跨域发起，但需 token');
console.log('   - 结论：token 是唯一防线，32 位随机 hex 足够');
