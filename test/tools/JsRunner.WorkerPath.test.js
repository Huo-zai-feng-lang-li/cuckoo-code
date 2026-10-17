/**
 * resolveWorkerPath 回归测试
 *
 * 打包版阻塞 bug：worker 在 app.asar 内时，child_process.fork 无法执行
 * （OS 不认 asar 虚拟路径）→ AI 执行 JS 代码块 100% ENOENT 失败。
 * 修复：asarUnpack 解出 worker + 运行时把路径映射到 app.asar.unpacked。
 */
import { describe, it, expect } from 'vitest';
import { resolveWorkerPath } from '../../out/src/tools/runtime/JsRunner.js';

describe('resolveWorkerPath（打包后 worker 路径映射）', () => {
  it('Windows asar 路径映射到 asar.unpacked', () => {
    const p = 'C:\\app\\resources\\app.asar\\out\\src\\tools\\runtime\\js-sandbox-worker.mjs';
    expect(resolveWorkerPath(p)).toBe(
      'C:\\app\\resources\\app.asar.unpacked\\out\\src\\tools\\runtime\\js-sandbox-worker.mjs'
    );
  });

  it('POSIX asar 路径映射到 asar.unpacked', () => {
    const p = '/Applications/App.app/Contents/Resources/app.asar/out/src/tools/runtime/js-sandbox-worker.mjs';
    expect(resolveWorkerPath(p)).toBe(
      '/Applications/App.app/Contents/Resources/app.asar.unpacked/out/src/tools/runtime/js-sandbox-worker.mjs'
    );
  });

  it('开发态路径（无 asar）原样返回', () => {
    const p = 'D:\\dev\\cuckoo-code\\out\\src\\tools\\runtime\\js-sandbox-worker.mjs';
    expect(resolveWorkerPath(p)).toBe(p);
  });

  it('已映射过的路径不重复映射（幂等）', () => {
    const p = 'C:\\app\\resources\\app.asar.unpacked\\out\\src\\tools\\runtime\\js-sandbox-worker.mjs';
    expect(resolveWorkerPath(p)).toBe(p);
  });

  it('空/非法输入原样返回，不抛异常', () => {
    expect(resolveWorkerPath('')).toBe('');
    expect(resolveWorkerPath(null)).toBe(null);
    expect(resolveWorkerPath(undefined)).toBe(undefined);
  });

  it('路径含 app.asar 但无分隔符时不被误伤', () => {
    // 例如文件名里恰好含 app.asar 字样（非目录段）
    const p = 'C:\\x\\my-app.asar-backup\\worker.mjs';
    expect(resolveWorkerPath(p)).toBe(p);
  });
});
