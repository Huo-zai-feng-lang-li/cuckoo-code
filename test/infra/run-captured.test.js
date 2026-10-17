'use strict';
// A-006 回归：前台命令超时后，子孙进程必须被连带回收（不允许孤儿）。
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCaptured } from '../../src/infra/run-captured.js';
import { killProcessTree } from '../../src/infra/task-manager.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-run-'));
const GRANDCHILD = path.join(TMP, 'grandchild.js');

beforeAll(() => {
  // 孙进程：打印自己的 pid 后睡 60s（不退出）
  fs.writeFileSync(GRANDCHILD, "console.log(process.pid); setTimeout(function(){}, 60000);\n", 'utf-8');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('正常命令：返回 stdout 与退出码', async () => {
  const r = await runCaptured('node -e "console.log(1+1)"', null, { cwd: TMP, timeout: 5000, shell: true });
  expect(r.timedOut).toBe(false);
  expect(r.stdout.toString().trim()).toBe('2');
});

test('超时后孙进程被连带杀死（A-006）', async () => {
  const r = await runCaptured('node "' + GRANDCHILD + '"', null, { cwd: TMP, timeout: 1200, shell: true });
  expect(r.timedOut).toBe(true);
  const pid = Number(r.stdout.toString().trim());
  expect(pid).toBeGreaterThan(0);
  // 给 taskkill /T 一点落地时间，再探活
  await new Promise((res) => setTimeout(res, 300));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});

test('killProcessTree：已退出的 pid 不再发信号（A-016 探活）', () => {
  // 用一个必然已退出的 pid（0/负数/极大值）调用不应抛
  expect(() => killProcessTree(99999999)).not.toThrow();
  expect(() => killProcessTree(0)).not.toThrow();
});
