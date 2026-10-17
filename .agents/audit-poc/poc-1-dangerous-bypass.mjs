// PoC-1: dangerous-commands.ts 黑名单绕过矩阵
// 说明：逐字复刻 src/infra/dangerous-commands.ts 的 DANGEROUS_CMDS / CMD_WRAPPERS /
//       splitShellSegments / stripWrappers / isDangerous（83 行全文复制，未改动）。
// 运行: node .agents/audit-poc/poc-1-dangerous-bypass.mjs

// ===== 以下逐字复制自 src/infra/dangerous-commands.ts =====
const DANGEROUS_CMDS = [
  /^rm\s+(?:-[a-z-]+\s+)*(?:\/(?:\s|$|\*)|~(?:$|\s|\/(?:\s|$|\*)))/i,
  /^mkfs(?:\.\w+)?\b/i,
  /^dd\s+[^|]*\bof=\/dev\//i,
  /^format\s+/i,
  /^del\s+\/[a-z]*[fsq]/i,
  /^(?:rd|rmdir)\s+\/[a-z]*s/i,
  /^shutdown\s+/i,
  /^taskkill\s+/i,
  /^diskpart\b/i,
  /^reg\s+delete\b/i,
  /^cipher\s+\/w/i,
  /^vssadmin\s+delete\b/i,
  /^bcdedit\b/i,
  /^stop-computer\b/i,
  /^restart-computer\b/i,
  /^clear-disk\b/i,
  /^format-volume\b/i,
  /^remove-item\s+.*-recurse\b.*-force\b/i,
];
const CMD_WRAPPERS = /^(?:sudo|doas|env|nohup|command|time|nice|setsid|stdbuf)(?:\s+-[ugpC]\s+\S+|\s+-\S+|\s+[A-Za-z_]\w*=\S+)*\s+/i;
function splitShellSegments(cmd) {
  return cmd.split(/\r?\n|&&|\|\||[;|&]/).map((s) => s.trim()).filter((s) => s.length > 0);
}
function stripWrappers(segment) {
  let s = segment;
  while (CMD_WRAPPERS.test(s)) { s = s.replace(CMD_WRAPPERS, ''); }
  return s;
}
function isDangerous(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const segments = splitShellSegments(cmd);
  for (const seg of segments) {
    const inner = stripWrappers(seg);
    if (DANGEROUS_CMDS.some((pattern) => pattern.test(inner))) return true;
  }
  return false;
}
// ===== 复刻结束 =====

const cases = [
  // [命令, 预期(是否危险=黑名单应拦), 场景说明]
  ['rm -rf /', true, '基准：Unix 删根（应拦住）'],
  ['sudo rm -rf /', true, '基准：sudo 包装（应拦住）'],
  ['echo hi && rm -rf /', true, '基准：复合命令（应拦住）'],
  ['powershell -Command "rm -r -fo C:\\Users\\victim\\important"', false, 'PowerShell rm=Remove-Item 别名 + -fo(=-Force) 连写，字面 remove-item 匹配不到'],
  ['Remove-Item C:\\important -Recurse', false, 'Remove-Item 缺 -Force 不匹配（只删只读文件时 -Force 非必需）'],
  ['cmd /c "rmdir /s C:\\Windows\\System32"', false, 'cmd /c 嵌套（注释里承认的已知局限）'],
  ['iex "Remove-Item -Recurse -Force C:\\victim"', false, 'PowerShell Invoke-Expression 字符串内执行'],
  ['rm --interactive=never -rf /', false, '带值选项 --interactive=never 打断 (?:-[a-z-]+\\s+)* 选项循环'],
  ['rm -r -fo C:\\Users', false, 'PowerShell 风格 rm（-fo 连写选项），/ 判定不到 Windows 路径'],
  ['Get-ChildItem C:\\; Remove-Item C:\\victim -Recurse -Force', true, '分段应拦住：PS 分号分段后 remove-item 字面命中'],
];

console.log('命令'.padEnd(72), '黑名单判定', '预期拦截', '结论');
for (const [cmd, expect, note] of cases) {
  const hit = isDangerous(cmd);
  const ok = hit === expect;
  console.log(
    (hit ? '拦截' : '放行').padEnd(8),
    (expect ? '应拦' : '不应拦').padEnd(8),
    (ok ? 'OK ' : '**偏差**').padEnd(6),
    cmd.length > 60 ? cmd.slice(0, 59) + '…' : cmd
  );
  if (!ok) console.log('      ↑ 场景:', note);
}

console.log('\n=== 绕过结论 ===');
const bypasses = cases.filter(([cmd, expect]) => expect === false && isDangerous(cmd) === false);
console.log('黑名单放行的危险命令条数（可被 AI/注入指令利用）:', bypasses.length);
