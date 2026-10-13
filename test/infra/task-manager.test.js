'use strict';
import { test, afterEach } from 'vitest';
import assert from 'node:assert';
import * as taskManager from '../../src/infra/task-manager.js';

afterEach(() => {
  try { taskManager._resetForTest(); } catch (_) {}
});

/** 轮询等待任务退出（真实进程，异步 flush 输出） */
function waitExit(id, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const info = taskManager.get(id);
      if (!info) return reject(new Error('任务已不存在: ' + id));
      if (info.status === 'exited') return resolve(info);
      if (Date.now() - start > timeoutMs) return reject(new Error('等待任务退出超时'));
      setTimeout(tick, 30);
    };
    tick();
  });
}

/** 检测字符串是否含"孤立代理"（半个 UTF-16 代理，说明裁剪切坏了字符） */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true; // 高位代理后无低位
      i++; // 跳过配对的低位
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = s.charCodeAt(i - 1);
      if (!(p >= 0xd800 && p <= 0xdbff)) return true; // 低位代理前无高位
    }
  }
  return false;
}

test('超长输出被环形裁剪，保留尾部并加截断提示', async () => {
  // 输出约 300KB ASCII，超过 256KB 上限
  const info = taskManager.start({
    command: 'node -e "process.stdout.write(\'a\'.repeat(300000))"',
    cwd: process.cwd(),
    source: 'manual',
  });
  await waitExit(info.id);
  const out = taskManager.getOutput(info.id);
  assert.ok(out.startsWith('[输出已截断]'), '应以截断提示开头');
  assert.ok(Buffer.byteLength(out, 'utf-8') <= 300 * 1024, '裁剪后应受限');
  assert.ok(out.length > 1000, '应保留尾部内容');
  assert.strictEqual(hasLoneSurrogate(out), false, '不应含孤立代理');
});

test('裁剪落在多字节字符流时，不切出半个字符（代理对安全）', async () => {
  // 输出约 300KB 的 4 字节 emoji（😀 = U+1F600，UTF-16 为代理对）
  const info = taskManager.start({
    command: 'node -e "process.stdout.write(\'\\u{1F600}\'.repeat(75000))"',
    cwd: process.cwd(),
    source: 'manual',
  });
  await waitExit(info.id);
  const out = taskManager.getOutput(info.id);
  assert.ok(out.startsWith('[输出已截断]'), '应以截断提示开头');
  assert.strictEqual(hasLoneSurrogate(out), false, '裁剪边界不得切坏代理对');
});

test('getOutput: 未知任务返回空串', () => {
  assert.strictEqual(taskManager.getOutput('no-such-task'), '');
});

test('remove: 运行中任务不可移除，已退出可移除', async () => {
  const info = taskManager.start({
    command: 'node -e "process.stdout.write(\'x\')"',
    cwd: process.cwd(),
    source: 'manual',
  });
  // 未退出前不允许移除（可能已瞬间退出，两种结果都合法，只校验不抛错）
  taskManager.remove(info.id);
  await waitExit(info.id);
  assert.strictEqual(taskManager.remove(info.id), true, '已退出任务应可移除');
  assert.strictEqual(taskManager.get(info.id), null);
});
