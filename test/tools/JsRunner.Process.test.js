'use strict';
// A-005 硬验收：JS 死循环必须被"真杀 OS 进程"，主进程事件循环不被饿死。
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsRunner } from '../../src/tools/runtime/JsRunner.js';
import { registry } from '../../src/tools/index.js';

function assertPidDead(pid) {
  let alive = true;
  try { process.kill(pid, 0); } catch (_) { alive = false; }
  expect(alive).toBe(false);
}

test('异步微任务死循环：deadline 后杀进程，主循环仍响应', async () => {
  const runner = new JsRunner(registry, { deadlineMs: 2000 });
  let mainLoopTickled = false;
  const t0 = Date.now();
  // 在 run 挂起期间，主进程的 timer 必须能照常触发（证明主事件循环没被饿死）
  const tickler = setTimeout(() => { mainLoopTickled = true; }, 800);
  const r = await runner.run('while(true){ await Promise.resolve(); }', process.cwd());
  clearTimeout(tickler);
  const elapsed = Date.now() - t0;

  expect(r.success).toBe(false);
  expect(String(r.error)).toMatch(/超时/);
  expect(elapsed).toBeGreaterThan(1500);
  expect(elapsed).toBeLessThan(9000);
  expect(mainLoopTickled).toBe(true);
  // worker 进程必须真死
  await new Promise((res) => setTimeout(res, 300));
  expect(runner.activeWorkerPid).toBeGreaterThan(0);
  assertPidDead(runner.activeWorkerPid);
});

test('同步死循环：vm timeout 后 worker 进程被回收', async () => {
  const runner = new JsRunner(registry, { syncTimeoutMs: 500, deadlineMs: 15000 });
  const t0 = Date.now();
  const r = await runner.run('while(true){}', process.cwd());
  const elapsed = Date.now() - t0;
  expect(r.success).toBe(false);
  expect(String(r.error)).toMatch(/timed out|中断|超时/i);
  expect(elapsed).toBeLessThan(12000);
  await new Promise((res) => setTimeout(res, 300));
  assertPidDead(runner.activeWorkerPid);
});

test('worker 进程异常退出：run 干净失败不挂起', async () => {
  // 假 worker：启动后立刻 exit(1)，不响应任何消息
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-badworker-')), 'bad.mjs');
  fs.writeFileSync(fake, 'process.exit(1);\n', 'utf-8');
  const runner = new JsRunner(registry, { workerPath: fake, deadlineMs: 5000 });
  const t0 = Date.now();
  const r = await runner.run('log(1);', process.cwd());
  expect(r.success).toBe(false);
  expect(Date.now() - t0).toBeLessThan(4500);
  fs.rmSync(path.dirname(fake), { recursive: true, force: true });
});
