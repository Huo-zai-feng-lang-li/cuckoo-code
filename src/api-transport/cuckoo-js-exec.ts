/**
 * cuckoo-js 本地执行桥。
 *
 * 网页模型只写代码，不直接碰工具；这里复用网页模式同一条安全闸与 JsRunner，
 * 绝不绕过 ipc-guard，也不把 allowedTools 之外的任何工具暴露给脚本。
 */
import { jsRunner } from '../tools/index.js';
import { guardExecutionCall } from '../app/ipc-guard.js';
import { pushPlanEvent } from '../app/ipc/tool.js';

/** cuckoo-js 开放这些本地工具；子代理/附件/网页工具不在 API 模式下暴露 */
export const ALLOWED_TOOLS = [
  'bash',
  'pwsh',
  'read',
  'readLines',
  'write',
  'edit',
  'glob',
  'grep',
  'todoWrite',
  'mcpListServers',
  'mcpGetTools',
  'mcpCall',
];

export interface CuckooExecResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * 执行一个 cuckoo 代码块。
 * @param ctx 当前窗口上下文（用于 guard 反查与 windowId）
 * @param code 模型写出的 JS（async 函数体）
 * @param projectDir 当前会话绑定的项目目录
 * @param sessionId 当前 API 会话 ID（工具设置透传）
 * @param signal 停止信号；执行前后都检查
 */
export async function executeCuckooJs(
  ctx: any,
  code: string,
  projectDir: string | null,
  sessionId: string,
  signal?: AbortSignal,
): Promise<CuckooExecResult> {
  if (signal && signal.aborted) return { success: false, output: 'ERROR: 已停止', error: '已停止' };
  if (!code || !String(code).trim()) {
    return { success: false, output: 'ERROR: 无效的 JS 代码', error: '无效的 JS 代码' };
  }

  const wc = ctx && ctx.harnessView && ctx.harnessView.webContents;
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
    return { success: false, output: 'ERROR: API 窗口已关闭', error: 'API 窗口已关闭' };
  }

  // 只指向当前 harness 视图；guard 会校验来源、workspace 信任并按策略弹窗。
  const internalEvent = {
    sender: wc,
    senderFrame: { url: (typeof wc.getURL === 'function' && wc.getURL()) || 'about:blank' },
    channel: 'api-transport-cuckoo-js',
  };
  const guard = await guardExecutionCall(internalEvent, 'js', { code });
  if (!guard.pass) {
    const msg = (guard.error && guard.error.error) || '已拒绝执行';
    return { success: false, output: 'ERROR: ' + msg, error: msg };
  }
  if (signal && signal.aborted) return { success: false, output: 'ERROR: 已停止', error: '已停止' };

  const win = ctx && ctx.win;
  const windowId = win && typeof win.isDestroyed === 'function' && !win.isDestroyed() ? win.id : null;
  try {
    const result = await jsRunner.run(code, projectDir, windowId, {
      sessionId,
      ssrfGuard: false,
      allowedTools: ALLOWED_TOOLS,
    });
    if (signal && signal.aborted) {
      return { success: false, output: 'ERROR: 已停止', error: '已停止' };
    }
    // 与网页 execute-js 共用 todoWrite 的收尾推送；内部按内容去重。
    // 计划推送失败不能反判工具失败，否则模型会误以为命令没执行而重复执行。
    try { pushPlanEvent(ctx, projectDir); } catch (_) { /* ignore */ }
    if (result.success) {
      return { success: true, output: result.output || '(无输出)' };
    }
    return { success: false, output: 'ERROR: ' + (result.error || '工具执行失败'), error: result.error || '工具执行失败' };
  } catch (err: any) {
    const msg = (err && err.message) || String(err);
    return { success: false, output: 'ERROR: ' + msg, error: msg };
  }
}
