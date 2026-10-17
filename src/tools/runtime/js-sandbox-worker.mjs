/**
 * js-sandbox-worker.mjs — JsRunner 的独立沙箱进程（A-005）
 *
 * 本进程只做一件事：在自己的 vm 上下文里跑 AI 脚本。
 * - 工具调用不在这里执行：__hostBridge 通过 IPC 发回主进程，主进程执行完回结果。
 * - sleep/setTimeout 用本进程自己的 timer：主进程杀本进程时一并回收。
 * - 同步死循环由 vm timeout 抛出；异步死循环由主进程 watchdog 杀 OS 进程（本进程退出即一切终止）。
 *
 * 纯 ESM、零 src/TS 依赖——vitest 可直接 child_process.fork 跑，无需先编译。
 */
import vm from 'node:vm';

/** 进行中的工具调用：seq → { resolve, reject } */
let pending = new Map();
let callSeq = 0;
/** 本进程内的沙箱 timer 句柄（跑完清理） */
const sandboxTimers = new Set();

function hostSetTimeout(fn, ms) {
  const h = setTimeout(() => { try { fn(); } catch (_) { /* 回调异常忽略 */ } }, ms);
  sandboxTimers.add(h);
  return h;
}
function hostClearTimeout(h) {
  if (h) { try { clearTimeout(h); } catch (_) { /* ignore */ } sandboxTimers.delete(h); }
}

function send(obj) {
  try { process.send(obj); } catch (_) { /* 主进程已死，静默退出 */ process.exit(0); }
}

async function handleRun(msg) {
  const sandbox = {};
  sandbox.__hostBridge = async (name, argsJson) => {
    const seq = ++callSeq;
    return await new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject });
      send({ type: 'tool-call', runId: msg.runId, seq: seq, op: name, argsJson: argsJson == null ? '{}' : String(argsJson) });
    });
  };
  sandbox.__projectDir = msg.projectDir || null;
  sandbox.__hostSetTimeout = hostSetTimeout;
  sandbox.__hostClearTimeout = hostClearTimeout;
  // 截断原型链，防 constructor/__proto__ 逃逸
  try { Object.setPrototypeOf(sandbox, null); } catch (_) { /* 尽力 */ }
  try { Object.setPrototypeOf(sandbox.__hostBridge, null); } catch (_) { /* 尽力 */ }

  let context;
  try {
    context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, name: 'cuckoo-js-sandbox' });
  } catch (err) {
    send({ type: 'error', runId: msg.runId, message: '沙箱初始化失败: ' + (err && err.message || String(err)) });
    return;
  }

  try {
    vm.runInContext(msg.bootstrapScript, context, { filename: 'cuckoo-js-api.js' });
    if (msg.dynamicToolsScript) {
      vm.runInContext(msg.dynamicToolsScript, context, { filename: 'cuckoo-plugin-tools.js' });
    }
  } catch (err) {
    send({ type: 'error', runId: msg.runId, message: '沙箱初始化失败: ' + ((err && err.message) || String(err)) });
    return;
  }

  let ret;
  try {
    const script = new vm.Script('(async () => {\n' + msg.code + '\n})()', { filename: 'cuckoo-js-tool-script.js' });
    ret = await script.runInContext(context, { timeout: msg.syncTimeoutMs || 30000 });
  } catch (err) {
    send({ type: 'error', runId: msg.runId, message: ((err && err.message) || String(err)) });
    return;
  }

  let logs = [];
  try {
    const logsJson = vm.runInContext('JSON.stringify(globalThis.__logs || [])', context);
    logs = JSON.parse(logsJson);
  } catch (_) { /* 忽略日志收集失败 */ }

  let returnValue = null;
  try {
    returnValue = ret === undefined ? null : JSON.parse(JSON.stringify(ret));
  } catch (_) {
    returnValue = String(ret);
  }

  send({ type: 'done', runId: msg.runId, logs: Array.isArray(logs) ? logs : [], returnValue: returnValue });
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'run') {
    handleRun(msg).catch((err) => {
      send({ type: 'error', runId: msg.runId, message: (err && err.message) || String(err) });
    });
  } else if (msg.type === 'tool-result') {
    const p = pending.get(msg.seq);
    if (p) {
      pending.delete(msg.seq);
      p.resolve(msg.resultJson);
    }
  }
});

// 未捕获异常也汇报，主进程据此干净失败而不是挂起
process.on('uncaughtException', (err) => {
  send({ type: 'error', runId: null, message: 'worker 崩溃: ' + (err && err.message || String(err)) });
});
