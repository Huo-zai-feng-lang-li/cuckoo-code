/**
 * API transport 的原生 tool_calls 适配层。
 *
 * 只做三件事：
 * 1. 把 Cuckoo 工具注册表转换成 OpenAI `tools` schema；
 * 2. 解析模型返回的 function call；
 * 3. 复用现有主进程 IPC 安全闸 + ToolRegistry 执行，绝不自己开一条绕过权限的通道。
 */
import { registry } from '../tools/index.js';
import { guardExecutionCall } from '../app/ipc-guard.js';
import { pushPlanEvent } from '../app/ipc/tool.js';
import type { ApiToolCall, OpenAiTool } from './client.js';

/** 单次工具输出最多回传给模型的字符数，防止 read 大文件把上下文撑爆 */
const MAX_TOOL_OUTPUT_CHARS = 50000;

/** API 模式没有网页附件通道，也没有可驱动网页的子代理链路：不暴露这些工具 */
const API_UNSUPPORTED_TOOLS = new Set(['attachFile', 'runAgent', 'runAgents']);

/**
 * 把已注册工具转成 OpenAI function calling 的 tools 数组。
 * 工具名、描述、JSON Schema 都直接复用 ToolRegistry，避免两套定义漂移。
 */
export function buildOpenAiTools(): OpenAiTool[] {
  const out: OpenAiTool[] = [];
  for (const d of registry.getDescriptions()) {
    if (!d || typeof d.name !== 'string' || !d.name) continue;
    if (API_UNSUPPORTED_TOOLS.has(d.name)) continue;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(d.name)) continue;
    out.push({
      type: 'function',
      function: {
        name: d.name,
        description: typeof d.description === 'string' ? d.description : '',
        parameters: d.parameters && typeof d.parameters === 'object' ? d.parameters : { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

/** 工具卡片一行摘要（只用于 UI，不参与模型上下文） */
export function formatToolCall(call: ApiToolCall): string {
  const name = (call && call.function && call.function.name) || 'unknown';
  const raw = (call && call.function && call.function.arguments) || '';
  const compact = raw.length > 1200 ? raw.slice(0, 1200) + '…' : raw;
  return name + '(' + compact + ')';
}

function parseArguments(raw: any): { ok: true; value: any } | { ok: false; error: string } {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    return { ok: true, value: value && typeof value === 'object' ? value : {} };
  } catch (err: any) {
    return { ok: false, error: '工具参数不是合法 JSON：' + (err && err.message ? err.message : String(err)) };
  }
}

function stringifyResult(result: any): string {
  try {
    if (!result) return 'ok';
    if (!result.success) {
      const err = result.error;
      return 'ERROR: ' + (typeof err === 'string' ? err : JSON.stringify(err));
    }
    const data = result.data;
    if (typeof data === 'string') return data;
    if (data === undefined || data === null) return 'ok';
    return JSON.stringify(data, null, 2);
  } catch (_) {
    return String(result && result.data !== undefined ? result.data : result);
  }
}

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n…（输出过长，已截断 ' + (text.length - MAX_TOOL_OUTPUT_CHARS) + ' 字符）';
}

export interface ApiToolExecution {
  success: boolean;
  /** 回传给模型的 tool message content */
  output: string;
  error?: string;
}

/**
 * 执行一个模型发起的工具调用。
 *
 * 安全：构造一个只指向当前 harness 视图的内部 IPC event，走与网页模式完全相同的
 * `guardExecutionCall` 策略闸（来源校验 / workspace 信任 / 弹窗确认），然后才执行。
 * 严禁直接 `registry.execute` 绕过闸门。
 */
export async function executeApiToolCall(
  ctx: any,
  call: ApiToolCall,
  signal?: AbortSignal,
): Promise<ApiToolExecution> {
  const name = (call && call.function && call.function.name) || '';
  if (!name) return { success: false, output: 'ERROR: 工具名为空', error: '工具名为空' };
  if (API_UNSUPPORTED_TOOLS.has(name)) {
    return { success: false, output: 'ERROR: API 模式不支持该工具：' + name, error: 'API 模式不支持该工具：' + name };
  }
  if (signal && signal.aborted) return { success: false, output: 'ERROR: 已停止', error: '已停止' };

  const parsed = parseArguments(call.function.arguments);
  if (!parsed.ok) {
    return { success: false, output: 'ERROR: ' + parsed.error, error: parsed.error };
  }

  const wc = ctx && ctx.harnessView && ctx.harnessView.webContents;
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
    return { success: false, output: 'ERROR: API 窗口已关闭', error: 'API 窗口已关闭' };
  }

  // 只指向当前 harness 视图；guard 会用 windowState 反查 ctx，并校验 URL 是自有窗口。
  const internalEvent = {
    sender: wc,
    senderFrame: { url: (typeof wc.getURL === 'function' && wc.getURL()) || 'about:blank' },
    channel: 'api-transport-tool',
  };
  const guard = await guardExecutionCall(internalEvent, 'tool', { toolName: name, params: parsed.value });
  if (!guard.pass) {
    const msg = (guard.error && guard.error.error) || '已拒绝执行';
    return { success: false, output: 'ERROR: ' + msg, error: msg };
  }
  if (signal && signal.aborted) return { success: false, output: 'ERROR: 已停止', error: '已停止' };

  const store = ctx.sessionStore;
  const projectDir = store && store.state ? store.state.selectedProjectDir : null;
  const win = ctx.win;
  const windowId = win && !win.isDestroyed() ? win.id : null;

  try {
    const result = await registry.execute(name, {
      ...parsed.value,
      projectDir,
      currentWindowId: windowId,
    });
    if (signal && signal.aborted) {
      return { success: false, output: 'ERROR: 已停止', error: '已停止' };
    }
    // API 模式没有 JS 沙箱，todoWrite 的执行后收尾（读真相源→推计划条）在此补齐，
    // 与网页模式 execute-js 共用同一推送逻辑（内部按内容去重，非 todoWrite 调用不影响）。
    pushPlanEvent(ctx, projectDir);
    const output = capOutput(stringifyResult(result));
    return {
      success: !!result.success,
      output,
      error: result.success ? undefined : (typeof result.error === 'string' ? result.error : output),
    };
  } catch (err: any) {
    const msg = (err && err.message) || String(err);
    return { success: false, output: 'ERROR: ' + msg, error: msg };
  }
}
