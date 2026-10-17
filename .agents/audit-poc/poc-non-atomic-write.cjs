/**
 * PoC: session/store.ts 非原子写 → 崩溃中途写 → 下一次启动静默丢数据
 *
 * 复现链路：
 *   1. writeSessionStore 直接 fs.writeFileSync(STORE_FILE, JSON.stringify(...))
 *      没有 tmp+rename 原子写。
 *   2. 应用在写入过程中崩溃（断电/杀进程），文件被截断为半段 JSON。
 *   3. 下次启动 readSessionStore 执行 JSON.parse(fs.readFileSync(...))，
 *      抛 SyntaxError，被 catch (e: any) {} 吞掉，返回 {}。
 *   4. 结果：全部 session→projectDir 映射静默丢失，用户看到"项目未初始化"。
 *
 * 运行：node .agents/audit-poc/poc-non-atomic-write.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-poc-'));
const storeFile = path.join(tmpDir, 'session-dir-map.json');

// ---- 模拟正常写入（与 store.ts writeSessionStore 一致）----
function writeSessionStoreNormal(data) {
  // 原代码：fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf-8');
}

// ---- 模拟原子写（修复建议）----
function writeSessionStoreAtomic(data) {
  const tmp = storeFile + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, storeFile);
}

// ---- 模拟读取（与 store.ts readSessionStore 一致）----
function readSessionStore() {
  try {
    const raw = fs.readFileSync(storeFile, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    // 原代码：catch (e: any) { return {}; } — 静默丢数据
    return {};
  }
}

console.log('=== PoC: 非原子写导致 session 映射静默丢失 ===\n');

// 1. 写入正常数据
const originalData = {
  'session-abc-123': { projectDir: 'D:\\Projects\\my-app', title: '重构登录模块' },
  'session-def-456': { projectDir: 'D:\\Projects\\other', title: '修 bug' },
};
writeSessionStoreNormal(originalData);
console.log('[1] 正常写入后读取到', Object.keys(readSessionStore()).length, '条映射');

// 2. 模拟崩溃中途写：截断文件为半段 JSON
const fullContent = fs.readFileSync(storeFile, 'utf-8');
const halfPoint = Math.floor(fullContent.length / 2);
fs.writeFileSync(storeFile, fullContent.slice(0, halfPoint), 'utf-8'); // 半段
console.log('[2] 模拟崩溃：文件被截断为', halfPoint, '字节（半段 JSON）');

// 3. 下次启动读取
const recovered = readSessionStore();
console.log('[3] 下次启动读取到', Object.keys(recovered).length, '条映射');
console.log('    → 期望 2 条，实际', Object.keys(recovered).length, '条');
if (Object.keys(recovered).length === 0) {
  console.log('    → 确认 BUG：全部映射静默丢失，用户无任何提示\n');
}

// 4. 对比：原子写不会丢
writeSessionStoreAtomic(originalData);
// 模拟崩溃：原子写的 tmp 文件可能残留，但正式文件不受影响
fs.writeFileSync(storeFile + '.tmp-crash', fullContent.slice(0, halfPoint), 'utf-8');
const recoveredAtomic = readSessionStore();
console.log('[4] 原子写场景：正式文件完好，读取到', Object.keys(recoveredAtomic).length, '条映射');
console.log('    → 原子写 + rename 可避免此问题');

// 清理
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n=== 结论：store.ts / profile.ts / window-groups.ts 等 6 处直接 writeFileSync 均有此风险 ===');
