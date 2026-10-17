/**
 * 主进程统一安全闸（X-001 第一/三层落地）
 *
 * 第一层（host 硬校验）：classifySender 判定 event.sender 的归属——
 *   - ctx.view.webContents（AI 远程页）：senderFrame URL 必须命中已注册 provider 域；
 *   - ctx.win / harnessView / overlayView（自有窗口）：URL 必须 file:/data:/about:blank；
 *   - 找不到 ctx 或不匹配 → unknown 拒绝（无感硬安全，防第三方页面/导航逃逸后调执行面）。
 * 第三层（策略弹窗）：guardExecutionCall 在 host 通过后，按 execution-policy.decideToolGate
 *   决定 allow/confirm；confirm 时弹主进程对话框（默认聚焦"取消"）。
 *
 * 纯判定（classifyCore + decideToolGate 的编排数据）不依赖 electron；
 * dialog/windowState 通过可注入依赖解耦，便于 vitest 覆盖三档×工具×信任矩阵。
 */
import { createRequire } from 'node:module';
import * as windowState from './window.js';
import { checkSenderUrl, isOwnWindowUrl } from '../infra/host-allowlist.js';
import { getAllProviders } from '../providers/registry.js';
import { isWorkspaceTrusted } from '../infra/workspace-trust.js';
import { findDeliverySignature } from '../infra/dangerous-commands.js';
import { normalizeCommand } from '../infra/decode-output.js';
import {
  decideToolGate,
  COMMAND_TOOLS,
  getExecutionMode,
  type ExecutionMode,
  type GateResult,
} from './execution-policy.js';

const require = createRequire(import.meta.url);

/** 可注入依赖（测试用；生产环境为 electron 真对象） */
interface GuardDeps {
  dialog?: any;
  getMatchers?: () => Array<(u: string) => boolean>;
}
let _deps: GuardDeps = {};

/** 注入测试替身（dialog/matchers）；生产代码不调用 */
export function __setGuardDeps(deps: GuardDeps): void {
  _deps = deps || {};
}

function getDialog(): any {
  if (_deps.dialog) return _deps.dialog;
  try { return require('electron').dialog; } catch (_) { return null; }
}

function providerMatchers(): Array<(u: string) => boolean> {
  if (typeof _deps.getMatchers === 'function') return _deps.getMatchers();
  try {
    return getAllProviders().map((p: any) => (u: string) => (typeof p.matchesUrl === 'function' ? p.matchesUrl(u) : false));
  } catch (_) {
    return [];
  }
}

export type SenderKind = 'provider' | 'own-window' | 'unknown';

export interface SenderClassification {
  ctx: any;
  kind: SenderKind;
  ok: boolean;
  reason?: string;
}

/**
 * 纯判定：给定 ctx、sender 引用、帧 URL、provider matcher 列表，判定来源合法性。
 * @param ctx windowState 反查出的窗口上下文（null = 找不到）
 * @param sender event.sender 的 webContents 引用（与 ctx 各视图比较身份）
 * @param frameUrl event.senderFrame?.url（回退 event.sender.getURL()）
 * @param matchers provider.matchesUrl 列表
 */
export function classifyCore(ctx: any, sender: any, frameUrl: string, matchers: Array<(u: string) => boolean>): SenderClassification {
  if (!ctx || !sender) {
    return { ctx: ctx || null, kind: 'unknown', ok: false, reason: 'sender 不在任何已注册窗口上下文' };
  }
  const isView = ctx.view && ctx.view.webContents === sender;
  const isWin = ctx.win && ctx.win.webContents === sender;
  const isHarness = ctx.harnessView && ctx.harnessView.webContents === sender;
  const isOverlay = ctx.overlayView && ctx.overlayView.webContents === sender;

  if (isView) {
    // AI 远程页：帧 URL 必须命中当前所有 provider 域（页面可能被劫持，以全域为准）
    const chk = checkSenderUrl(frameUrl, matchers);
    if (chk.ok && chk.kind === 'provider') {
      return { ctx, kind: 'provider', ok: true };
    }
    return { ctx, kind: 'unknown', ok: false, reason: 'AI 页面来源不在 provider 白名单: ' + (chk.reason || frameUrl) };
  }

  if (isWin || isHarness || isOverlay) {
    if (isOwnWindowUrl(frameUrl)) {
      return { ctx, kind: 'own-window', ok: true };
    }
    return { ctx, kind: 'unknown', ok: false, reason: '自有窗口 URL 不合法: ' + frameUrl };
  }

  return { ctx, kind: 'unknown', ok: false, reason: 'sender 不属于该窗口的任何已注册视图' };
}

/**
 * 从真实 IPC event 提取 ctx/sender/frameUrl 并分类。
 * ctx 为 null（sender 找不到归属）一律 unknown → 拒绝。
 */
export function classifySender(event: any): SenderClassification {
  let ctx: any = null;
  let sender: any = null;
  let frameUrl = '';
  try {
    sender = event && event.sender;
    ctx = windowState.getContextByWebContents(sender);
    frameUrl = (event.senderFrame && typeof event.senderFrame.url === 'string' && event.senderFrame.url)
      || (sender && typeof sender.getURL === 'function' ? sender.getURL() : '')
      || '';
  } catch (_) { /* 提取失败按 unknown */ }
  const cls = classifyCore(ctx, sender, frameUrl, providerMatchers());
  if (!cls.ok) {
    console.warn('[ipc-guard] 来源校验拒绝:', cls.reason, '| channel=', event && event.channel);
  }
  return cls;
}

/** 副作用面（非命令/非文件写）的轻量断言：仅过 host 硬校验 */
export function assertSenderOk(event: any): SenderClassification {
  return classifySender(event);
}

/** 弹主进程确认框（默认聚焦"取消"）；返回 true = 用户确认 */
async function confirmExecution(win: any, message: string, detail: string): Promise<boolean> {
  const dlg = getDialog();
  if (!dlg) {
    // 无 dialog 环境（测试替身缺失/异常）：保守拒绝，不放过
    return false;
  }
  const parent = win && !win.isDestroyed() ? win : null;
  const res = await dlg.showMessageBox(parent, {
    type: 'warning',
    buttons: ['取消', '确认执行'],
    defaultId: 0,
    cancelId: 0,
    title: '安全确认',
    message,
    detail,
  });
  const idx = typeof res === 'object' && res !== null ? res.response : (typeof res === 'number' ? res : 0);
  return idx === 1;
}

export interface GuardResult {
  pass: boolean;
  ctx?: any;
  error?: { code?: string; error: string };
}

/** 取 ctx 的项目目录（绝对/相对原值） */
function projectDirOf(ctx: any): string | null {
  try {
    const store = ctx && ctx.sessionStore;
    const dir = store && store.state ? store.state.selectedProjectDir : null;
    return typeof dir === 'string' && dir ? dir : null;
  } catch (_) {
    return null;
  }
}

/**
 * 纯编排：算投递特征并产出工具决策（guardExecutionCall 的可测部分）。
 * 不依赖 electron，供 vitest 直接覆盖。
 */
export function planToolGate(toolName: string, params: any, projectDir: string | null, trusted: boolean): { deliveryMatched: string | null; gate: GateResult } {
  const p = params || {};
  const deliveryMatched = COMMAND_TOOLS.has(toolName)
    ? findDeliverySignature(normalizeCommand(typeof p.command === 'string' ? p.command : ''))
    : null;
  return { deliveryMatched, gate: decideToolGate({ toolName, params: p, projectDir, deliveryMatched, isWorkspaceTrusted: trusted }) };
}

/** 纯编排：execute-js 的模式决策（smart allow / workspace 未信任 confirm / strict confirm） */
export function planJsGate(mode: ExecutionMode, trusted: boolean): 'allow' | 'confirm' {
  return (mode === 'smart' || (mode === 'workspace' && trusted)) ? 'allow' : 'confirm';
}

/**
 * 执行面统一闸：host 校验 → 策略判定 → 必要弹窗。
 * @param event IPC event
 * @param kind 'tool'=execute-tool / 'js'=execute-js / 'command'=execute-command（手动通道，仅过 host）
 * @param payload toolName+params / code / command
 */
export async function guardExecutionCall(event: any, kind: 'tool' | 'js' | 'command', payload: any): Promise<GuardResult> {
  const cls = classifySender(event);
  if (!cls.ok) {
    return { pass: false, ctx: null, error: { code: 'SENDER_REJECTED', error: '来源校验失败，已拒绝该操作' } };
  }
  const ctx = cls.ctx;
  const projectDir = projectDirOf(ctx);
  const trusted = isWorkspaceTrusted(projectDir);
  const win = ctx && ctx.win;

  if (kind === 'command') {
    // execute-command 自身已有"每条确认"对话框，这里只过 host 硬校验
    return { pass: true, ctx };
  }

  if (kind === 'js') {
    // execute-js：smart 自动；workspace 未信任 confirm；strict confirm
    const mode: ExecutionMode = getExecutionMode();
    if (planJsGate(mode, trusted) === 'allow') return { pass: true, ctx };
    const ok = await confirmExecution(
      win,
      '当前策略要求确认后再执行 JS 脚本',
      mode === 'strict' ? 'strict 模式：每次执行 JS 都需确认' : 'workspace 模式：未信任工作区执行 JS 需确认'
    );
    return ok ? { pass: true, ctx } : { pass: false, error: { code: 'CANCELED', error: '用户取消了执行' } };
  }

  // kind === 'tool'
  const toolName = (payload && payload.toolName) || '';
  const params = (payload && payload.params) || {};
  const { deliveryMatched, gate } = planToolGate(toolName, params, projectDir, trusted);
  if (gate.decision === 'allow') return { pass: true, ctx };
  if (gate.decision === 'deny') {
    return { pass: false, ctx, error: { code: 'DENIED', error: gate.reason } };
  }
  const detailLines = [gate.reason];
  if (gate.detail) detailLines.push('详情: ' + gate.detail);
  if (deliveryMatched) detailLines.push('命中特征: ' + deliveryMatched);
  detailLines.push('工具: ' + toolName);
  const ok = await confirmExecution(win, '安全策略要求确认后再执行工具', detailLines.join('\n'));
  return ok ? { pass: true, ctx } : { pass: false, error: { code: 'CANCELED', error: '用户取消了执行' } };
}
