/**
 * JsRunner - 在独立 OS 进程的 Node vm 沙箱中执行 AI 生成的 JavaScript 工具代码（A-005）
 *
 * 与旧版的本质区别：AI 代码不再跑在主进程事件循环里。
 * - 每次 run 用 child_process.fork 启动一个独立 worker（js-sandbox-worker.mjs），
 *   worker 内用 vm.createContext 跑脚本；run 结束（done/error/超时/进程崩溃）即 kill 该 OS 进程。
 * - 异步微任务死循环（while(true){ await Promise.resolve() }）不再饿死主进程事件循环：
 *   主进程看门狗到点直接 SIGKILL worker 进程，主进程窗口/IPC 全程可响应。
 * - 工具仍在主进程执行：worker 的 __hostBridge 把 {op,argsJson} 通过 IPC 发回主进程，
 *   主进程 registry.get(op).execute(...) 跑完把结果 JSON 回送。
 * - worker 不 import 任何 src/TS；bootstrap 脚本由主进程拼好随 run 消息下发。
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildBootstrapScript, buildDynamicToolsBootstrap } from './bootstrap-build.js';
import { logRun, ToolFailure } from '../../infra/tool-error-log.js';
import { scanRules, getScopedRules, getInjectedSet, markInjected } from '../../rules/index.js';
import { getPluginScanRoots } from '../../plugins/roots.js';
import { matchRulesForPath } from '../../rules/matcher.js';
import { renderRuleFull, renderRulePointer } from '../../rules/prompt.js';

// 同步执行超时（worker 内 vm timeout，覆盖无 await 的死循环）
const SYNC_TIMEOUT = 30 * 1000;
// "无活动"截止时间：距最后一次工具调用超过这么久才判超时。
// 每次工具调用都续命，故合法长任务（多次调用）不会误杀；
// 异步死循环不经过工具桥接 → 无续命 → 主进程看门狗兜底杀进程。
const RUN_DEADLINE = 60 * 1000;
// 固定长任务工具：自身有独立等待/超时兜底（子代理默认 10 分钟）
const LONG_TASK_TOOLS = new Set(['runAgent', 'runAgents']);
// 命令执行工具：仅当调用方显式声明 > 脚本 deadline 的 timeoutMs 时，自身超时才成为权威
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

/**
 * 判断某次工具调用是否属于"长任务"——执行期间暂停脚本的无活动看门狗，
 * 避免脚本 deadline 误杀自身有更长超时的工具。
 * @param op 工具名
 * @param args 工具参数
 * @param deadlineMs 脚本无活动 deadline（RUN_DEADLINE）
 */
function isLongRunningTool(op: string, args: any, deadlineMs: number): boolean {
  if (LONG_TASK_TOOLS.has(op)) return true;
  if (SHELL_TOOLS.has(op)) {
    const t = args && typeof args.timeoutMs === 'number' ? args.timeoutMs : 0;
    return t > deadlineMs;
  }
  return false;
}
// 输出长度上限
const OUTPUT_LIMIT = 20000;

/**
 * 把 read 的文件路径转成"项目内相对路径（正斜杠）"。
 * 绝对路径 → 相对 projectDir；相对路径 → 原样（去盘符/前导 ./）。
 */
function toProjectRelPath(filePath: any, projectDir: any): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  let p = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) {
    if (!projectDir) return null;
    const abs = path.resolve(filePath);
    const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
    return rel.startsWith('..') ? null : rel; // 项目外的不算
  }
  // 相对路径
  return p.replace(/^\.\//, '');
}

/**
 * 安全的 JSON 序列化（处理循环引用等异常）
 */
function safeStringify(value: any): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    try {
      return String(value);
    } catch (e2) {
      return '[无法序列化的返回值]';
    }
  }
}

/**
 * 把 worker 的 asar 内路径映射到 asar.unpacked 真实文件系统路径。
 *
 * 打包后代码位于 app.asar 内（虚拟路径），但 `child_process.fork` 启动的是
 * 原生 OS 进程，操作系统不认识 asar 格式（透明映射仅 Electron 内建模块享有）。
 * 故 `build.asarUnpack` 把 worker 解到 `app.asar.unpacked/`，运行时需把路径同步映射，
 * 否则打包版 AI 执行 JS 代码块会 100% 失败（ENOENT）。
 *
 * @param workerPath 原始 worker 路径（可能是 asar 内路径）
 * @returns 映射后的真实文件系统路径（非 asar 路径原样返回）
 */
export function resolveWorkerPath(workerPath: string): string {
  if (!workerPath || typeof workerPath !== 'string') return workerPath;
  if (!workerPath.includes('app.asar')) return workerPath;
  return workerPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

export interface JsRunnerOptions {
  /** 同步 vm 超时（默认 30s；测试可注入小值） */
  syncTimeoutMs?: number;
  /** 无活动 deadline（默认 60s；测试可注入小值） */
  deadlineMs?: number;
  /** 测试用：覆盖 worker 脚本路径（验证 worker 崩溃路径） */
  workerPath?: string;
}

class JsRunner {
  registry: any;
  syncTimeoutMs: number;
  deadlineMs: number;
  workerPath?: string;
  /** 当前/最近一次 run 的 worker pid（测试探活用） */
  activeWorkerPid: number | null = null;

  /**
   * @param registry 工具注册表
   * @param options 可选；测试注入短超时用（syncTimeoutMs/deadlineMs）
   */
  constructor(registry: any, options: JsRunnerOptions = {}) {
    this.registry = registry;
    this.syncTimeoutMs = typeof options.syncTimeoutMs === 'number' ? options.syncTimeoutMs : SYNC_TIMEOUT;
    this.deadlineMs = typeof options.deadlineMs === 'number' ? options.deadlineMs : RUN_DEADLINE;
    this.workerPath = options.workerPath;
  }

  /**
   * 执行 AI 生成的 JS 工具代码（在独立 worker 进程中）
   * @param code AI 生成的 JavaScript（支持顶层 await）
   * @param projectDir 当前项目目录（相对路径基准）
   * @param windowId 当前对话窗口 id（attachFile 等需要窗口上下文的工具使用）
   * @param settings 附加设置（attachDelayMin/sessionId 等），透传给工具
   * @returns {Promise<{success, output?, error?}>}
   */
  async run(code: any, projectDir: any, windowId: any, settings: any): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!code || typeof code !== 'string' || !code.trim()) {
      return { success: false, error: '无效的 JS 代码' };
    }

    const startTime = Date.now();
    const deadlineMs = this.deadlineMs;
    let lastActivity = Date.now();
    let longTaskRunning = 0;
    const toolFailures: ToolFailure[] = [];
    const readFiles: string[] = [];

    // ========== 启动独立 worker 进程 ==========
    // 打包后 worker 位于 app.asar 内，但 child_process.fork 启动的是原生 OS 进程，
    // 操作系统不认识 asar 虚拟路径（不透明映射仅 Electron 内建模块享有）。
    // 故 asarUnpack 把 worker 解到 app.asar.unpacked，此处把路径同步映射过去。
    const workerPath = resolveWorkerPath(
      this.workerPath || fileURLToPath(new URL('./js-sandbox-worker.mjs', import.meta.url))
    );
    let child;
    try {
      child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      this.activeWorkerPid = child.pid || null;
    } catch (err: any) {
      return { success: false, error: '无法启动沙箱进程: ' + (err.message || String(err)) };
    }

    let settled = false;
    let resolveOuter: (r: { success: boolean; output?: string; error?: string }) => void;
    const promise = new Promise<{ success: boolean; output?: string; error?: string }>((res) => { resolveOuter = res; });

    const killWorker = () => {
      try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
    };

    const watchdog = setInterval(() => {
      if (!settled && longTaskRunning === 0 && Date.now() - lastActivity > deadlineMs) {
        killWorker();
        finish({ success: false, error: 'JS 脚本执行超时（' + Math.round(deadlineMs / 1000) + ' 秒无活动）' }, 'timeout');
      }
    }, 500);
    if (typeof (watchdog as any).unref === 'function') (watchdog as any).unref();

    function finish(result: { success: boolean; output?: string; error?: string }, _reason: string, _logs?: any[]) {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      killWorker();
      resolveOuter(result);
    }

    child.on('message', async (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      try {
        if (msg.type === 'tool-call') {
          lastActivity = Date.now(); // 工具调用续命
          let args: any = {};
          try { args = JSON.parse(msg.argsJson || '{}'); } catch (_) { args = {}; }
          const isLongTask = isLongRunningTool(msg.op, args, deadlineMs);
          if (isLongTask) longTaskRunning++;

          let result;
          const tool = this.registry.get(msg.op);
          if (!tool) {
            result = { success: false, error: '未知工具: ' + msg.op };
            toolFailures.push({ tool: msg.op || 'unknown', args: args, error: result.error });
          } else {
            try {
              result = await tool.execute(Object.assign({}, settings || {}, args, { projectDir, currentWindowId: windowId }));
              if (result && result.success === false) {
                toolFailures.push({ tool: msg.op, args: args, error: result.error || '未知错误' });
              } else if (msg.op === 'read' && result && result.success !== false) {
                const rel = toProjectRelPath(args.filePath, projectDir);
                if (rel) readFiles.push(rel);
              }
            } catch (err: any) {
              result = { success: false, error: '工具 ' + msg.op + ' 执行异常: ' + (err.message || String(err)) };
              toolFailures.push({ tool: msg.op, args: args, error: result.error });
            }
          }
          if (isLongTask) longTaskRunning = Math.max(0, longTaskRunning - 1);
          lastActivity = Date.now(); // 工具返回也续命
          try {
            child.send({ type: 'tool-result', runId: msg.runId, seq: msg.seq, resultJson: JSON.stringify(result) });
          } catch (_) { /* worker 已死 */ }
        } else if (msg.type === 'done') {
          const logs = Array.isArray(msg.logs) ? msg.logs : [];
          const parts: string[] = [];
          if (logs.length > 0) parts.push(logs.join('\n'));
          const ret = msg.returnValue;
          if (ret !== undefined && ret !== null) {
            parts.push(typeof ret === 'string' ? ret : safeStringify(ret));
          }
          let output = parts.filter(Boolean).join('\n\n');

          // 规则注入（有 paths 的规则，read 命中时）
          const rulesInjection = buildRulesInjection(readFiles, projectDir, settings);
          if (rulesInjection) output = rulesInjection + '\n\n' + output;
          if (output.length > OUTPUT_LIMIT) {
            output = output.slice(0, OUTPUT_LIMIT) + '\n...[输出过长已截断]...';
          }
          logRun(code, toolFailures, null, { projectDir: projectDir || '(未设置)', windowId: windowId, 耗时ms: Date.now() - startTime });
          finish({ success: true, output: output || '(脚本执行完成，无输出)\n如需输出请使用 log() 方法' }, 'done', logs);
        } else if (msg.type === 'error') {
          const errMsg = msg.message || '未知错误';
          const fromTool = toolFailures.length > 0 && toolFailures.some((f) => errMsg.indexOf(f.error) !== -1);
          logRun(code, toolFailures, fromTool ? null : errMsg, { projectDir: projectDir || '(未设置)', windowId: windowId, 耗时ms: Date.now() - startTime });
          finish({ success: false, error: errMsg }, 'error', []);
        }
      } catch (err: any) {
        finish({ success: false, error: 'worker 消息处理异常: ' + (err.message || String(err)) }, 'error', []);
      }
    });

    child.on('exit', (code: number | null) => {
      if (!settled) {
        finish({ success: false, error: '沙箱进程意外退出 (code=' + code + ')' }, 'exit', []);
      }
    });
    child.on('error', (err: any) => {
      if (!settled) {
        finish({ success: false, error: '沙箱进程错误: ' + (err.message || String(err)) }, 'error', []);
      }
    });

    // 下发 run 消息
    try {
      child.send({
        type: 'run',
        runId: 1,
        code: code,
        projectDir: projectDir || null,
        bootstrapScript: buildBootstrapScript(),
        dynamicToolsScript: buildDynamicToolsBootstrap(this.registry),
        syncTimeoutMs: this.syncTimeoutMs,
      });
    } catch (err: any) {
      finish({ success: false, error: '无法下发脚本: ' + (err.message || String(err)) }, 'error', []);
    }

    return promise;
  }
}

/**
 * 生成本次脚本的"规则注入文本"。
 *  - 首次命中某规则 → 规则全文 + 路径
 *  - 之后命中 → 规则名 + 路径（提示 AI 自己 read）
 * 去重按"会话 + 规则文件路径"。
 * @returns 注入文本（无命中返回空串）
 */
function buildRulesInjection(readFiles: string[], projectDir: any, settings: any): string {
  if (!readFiles || readFiles.length === 0 || !projectDir) return '';
  try {
    // 插件贡献的规则同样参与"按路径注入"
    const scoped = getScopedRules(scanRules(projectDir, getPluginScanRoots().ruleDirs));
    if (scoped.length === 0) return '';
    const sessionId = (settings && settings.sessionId) || '(default)';
    const injected = getInjectedSet(sessionId);
    const parts: string[] = [];
    for (const file of readFiles) {
      const matched = matchRulesForPath(scoped, file);
      for (const rule of matched) {
        if (injected.has(rule.rulePath)) {
          parts.push(renderRulePointer(rule, file));
        } else {
          parts.push(renderRuleFull(rule));
          markInjected(sessionId, rule.rulePath);
        }
      }
    }
    return parts.join('\n\n');
  } catch (err: any) {
    console.error('[JsRunner] 规则注入失败:', err && err.message);
    return '';
  }
}

export { JsRunner, isLongRunningTool };
