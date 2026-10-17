// PoC-4: bash.ts exec() 超时杀 cmd 后，孙进程（start /b 起的长驻进程）是否孤儿化
// 运行: node .agents/audit-poc/poc-4-orphan-child.cjs
// 对照 bash.ts:171  exec(trimmed, { cwd, timeout, maxBuffer: 1048576, windowsHide: true, encoding: 'buffer' })
// 实测后自动清理 ping 进程。

const { exec } = require('node:child_process');

const tag = 'CUCKOO_AUDIT_PING';
// 用 PowerShell 起一个 30s 的替身进程（延迟退出），便于事后核对是否存活
const cmd = `cmd /c start /b ${process.env.SystemRoot}\\System32\\PING.EXE -n 30 127.0.0.1`;

console.log('启动命令（模拟 bash 工具执行）:', cmd);
exec(cmd, { timeout: 1500, windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
  console.log('\n=== exec 回调 ===');
  console.log('error.killed =', error && error.killed, '（true=超时已杀 shell）');
  setTimeout(checkOrphan, 500);
});

function listPing() {
  const { execSync } = require('node:child_process');
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='PING.EXE'\\" | Select-Object ProcessId,CommandLine | Format-List"`,
      { encoding: 'utf8' }
    );
    return out;
  } catch (e) {
    return '(无 ping 进程或查询失败: ' + e.message + ')';
  }
}

function checkOrphan() {
  console.log('\n=== 超时杀 shell 后 0.5s，系统里残留的 PING.EXE ===');
  const out = listPing();
  console.log(out);
  const alive = /ProcessId\s*:\s*\d+/.test(out);
  console.log(alive ? '=> 孙进程仍然存活：孤儿化确认（bash 工具超时只杀 cmd.exe，不杀孙进程）' : '=> 未发现残留 ping');
  // 清理
  try {
    execSync('taskkill /F /IM PING.EXE', { windowsHide: true });
    console.log('已清理 PING.EXE');
  } catch (_) {}
}
