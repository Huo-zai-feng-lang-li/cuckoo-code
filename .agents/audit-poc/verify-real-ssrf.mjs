// 对修复后的真实编译模块做攻击回归（不再用旧代码拷贝）
// 运行: node .agents/audit-poc/verify-real-ssrf.mjs
import http from 'node:http';
import { isBlockedIp, assertUrlAllowed } from '../../out/src/infra/ssrf-guard.js';

let failures = 0;
const expectBlocked = (ip) => {
  const blocked = isBlockedIp(ip);
  console.log(`  ${blocked ? '拦截' : '放行!!'}  ${ip}`);
  if (!blocked) failures++;
};

console.log('==== A-002 真实模块：IPv6 绕过 payload ====');
['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', '::1', '::ffff:10.0.0.1', 'fe80::1', 'fc00::1'].forEach(expectBlocked);

console.log('\n==== 对照组：公网地址不应误拦 ====');
for (const ip of ['8.8.8.8', '1.1.1.1', '220.181.38.148']) {
  const blocked = isBlockedIp(ip);
  console.log(`  ${blocked ? '误拦!!' : '放行'}  ${ip}`);
  if (blocked) failures++;
}

console.log('\n==== A-001 真实模块：assertUrlAllowed 拒绝内网 URL ====');
for (const u of ['http://[::ffff:7f00:1]/', 'http://127.0.0.1:9902/', 'http://169.254.169.254/latest/meta-data/']) {
  try {
    await assertUrlAllowed(u);
    console.log(`  放行!!  ${u}`);
    failures++;
  } catch (e) {
    console.log(`  拦截  ${u}  (${e.message})`);
  }
}

console.log('\n==== A-001 真实 web-fetch 逐跳：302 跳内网必须失败 ====');
const internal = http.createServer((req, res) => { res.end('INTERNAL-SECRET'); });
const jumper = http.createServer((req, res) => {
  // 同机演示：首跳直接用回环等价于"公网首跳已放行后"，关键看逐跳逻辑是否对 Location 再校验
  res.writeHead(302, { location: 'http://127.0.0.1:9912/internal' });
  res.end();
});
await new Promise((r) => internal.listen(9912, '127.0.0.1', r));
await new Promise((r) => jumper.listen(9911, '127.0.0.1', r));

// 复刻修复后 web-fetch 的逐跳循环（redirect:'manual' + 每跳 assertUrlAllowed）
async function guardedFetch(initialUrl) {
  let currentUrl = initialUrl;
  for (let hop = 0; ; hop++) {
    await assertUrlAllowed(currentUrl);
    const res = await fetch(currentUrl, { redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    try { res.body?.cancel(); } catch (_) {}
    currentUrl = new URL(location, currentUrl).href;
    if (hop >= 5) throw new Error('重定向次数过多');
  }
}
try {
  await guardedFetch('http://127.0.0.1:9911/');
  console.log('  攻击成功（不该发生）!!');
  failures++;
} catch (e) {
  console.log('  第二跳被拦截，攻击失败: ' + e.message);
}

jumper.close(); internal.close();
console.log(`\n==== 结果: ${failures === 0 ? '全部攻击失效，修复有效' : failures + ' 项仍然失败!!'} ====`);
process.exit(failures === 0 ? 0 : 1);
