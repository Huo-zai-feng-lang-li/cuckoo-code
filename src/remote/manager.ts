/**
 * 远程控制：主进程粘合层
 *
 * 职责：
 *   1. 启动/停止 HTTP+WS 服务（绑定 127.0.0.1，CF 隧道转发）
 *   2. 手机消息 → 路由到目标窗口的 AI 页面（sendToChat）
 *   3. AI 页面上报（回复/流式/工具）→ 广播给手机（按 profileId 隔离）
 *   4. 节流流式推送（避免高频 token 洪水）
 *   5. 手机停止生成 → 复用 stopGeneration
 *
 * 依赖：window（多窗口）、remote/server、remote/config
 */
import * as windowState from '../app/window.js';
import { getProfileById } from '../app/profile.js';
import { hasRunningSubagent } from '../app/subagent.js';
import * as remoteServer from './server.js';
import { readConfig } from './config.js';
import { stopGeneration } from '../app/ipc/harness.js';
import { cdpAttach } from '../app/ipc/cdp-attach.js';
import { startTunnel, stopTunnel, getTunnelStatus } from './tunnel.js';

/** 流式节流：100ms 推送一次。注意 onStream 的 text 是「全量累积文本」，故直接覆盖。 */
const STREAM_FLUSH_MS = 100;

/** 每窗口独立的流式状态（防多窗口串扰）。
 *  text = 最新全量累积文本；sent = 上次已广播出去的文本（用于计算 delta）。 */
interface StreamState { text: string; sent: string; timer: any; active: boolean; }
const streamStates = new Map<string, StreamState>();

function getStreamState(profileId: string): StreamState {
  let s = streamStates.get(profileId);
  if (!s) { s = { text: '', sent: '', timer: null, active: false }; streamStates.set(profileId, s); }
  return s;
}

/** 当前手机选定的目标 profileId（空 = 最近活跃窗口） */
let targetProfileId = '';
/** 本地乐观忙态：收到手机消息即置忙，收到 ai-reply/stop/error 清忙。
 *  带 TTL 兜底（10s）：即使 AI 不回复也不会永久卡忙，之后由 bridge 的 isGenerating 心跳接管。 */
const busyProfiles = new Map<string, number>();
const BUSY_TTL_MS = 10000;
function markBusy(pid: string): void { if (pid) busyProfiles.set(pid, Date.now()); }
function clearBusy(pid: string): void { if (pid) busyProfiles.delete(pid); }
function isLocallyBusy(pid: string): boolean {
  const t = busyProfiles.get(pid);
  if (!t) return false;
  if (Date.now() - t > BUSY_TTL_MS) { busyProfiles.delete(pid); return false; } // TTL 过期
  return true;
}
/** 窗口变化监听器的反注册句柄（防重复注册累积） */
let disposeWindowsChanged: (() => void) | null = null;

/** 取目标窗口；若选定窗口已不存在 → 回退最近活跃，并广播新列表提醒手机 */
function getTargetContext(): any {
  if (targetProfileId) {
    const ctx = windowState.getWindowByProfileId(targetProfileId);
    if (ctx) return ctx;
    // 选定窗口已关闭/切换 → 清空选择，回退最近活跃
    console.log('[Remote] 目标窗口已不存在，回退最近活跃:', targetProfileId);
    targetProfileId = '';
    broadcastProfiles();
  }
  return windowState.getMainContext();
}

/** 广播当前窗口列表 + 当前目标（供手机端选择器实时同步） */
function broadcastProfiles(): void {
  if (!remoteServer.isRunning()) return;
  try {
    remoteServer.broadcast({
      type: 'profiles',
      profiles: listProfiles(),
      currentProfileId: getCurrentProfile(),
    });
  } catch (_) { /* ignore */ }
}

/** 手机来消息 → 发给目标窗口 AI 页面 */
function onPhoneMessage(text: string): void {
  const ctx = getTargetContext();
  const view = ctx && ctx.view;
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    remoteServer.broadcast({ type: 'sys', text: '目标窗口不可用' });
    return;
  }
  // 子代理运行期间：拒收（避免插进正在进行的子代理会话），并向手机回显提示
  if (ctx.profileId && hasRunningSubagent(ctx.profileId)) {
    remoteServer.broadcast({ type: 'sys', profileId: ctx.profileId, text: 'AI 正在执行子代理任务，请等子代理结束后再发消息' });
    return;
  }
  // 忙态准入（本地乐观 + bridge 心跳双保险）：避免插入正在进行的任务
  const pid = ctx.profileId || '';
  if (pid && (isLocallyBusy(pid) || windowState.isGenerating(pid))) {
    remoteServer.broadcast({ type: 'sys', profileId: pid, keepBusy: true, text: 'AI 正在执行任务，请等本轮结束后再发消息' });
    return;
  }
  // 通过 AI 页面 bridge 转发到 AI（专用通道）
  try {
    markBusy(pid); // 乐观置忙（防竞态窗口）
    view.webContents.send('remote-user-message', { text });
  } catch (err: any) {
    clearBusy(pid);
    console.error('[Remote] 转发失败:', err.message);
  }
}

/** 手机请求停止生成 → 复用 stopGeneration（定位并点击网页"停止"） */
function onPhoneStop(): void {
  const ctx = getTargetContext();
  if (!ctx) return;
  const pid = ctx.profileId || '';
  stopGeneration(ctx)
    .then((r: any) => {
      // 只有确实点到网页"停止"按钮才算成功；否则不误报"已停止"（避免手机显示停了、电脑还在跑）
      if (r && r.success) {
        onAiStop(pid);
      } else {
        // 停止未生效：保持执行态（keepBusy），让用户能再试，不误报"已停止"
        remoteServer.broadcast({ type: 'sys', profileId: pid, keepBusy: true, text: '停止未生效（未找到停止按钮），请在电脑上操作' });
      }
    })
    .catch((err: any) => {
      console.error('[Remote] 停止生成失败:', err.message);
      remoteServer.broadcast({ type: 'sys', profileId: pid, keepBusy: true, text: '停止失败：' + (err.message || '未知错误') });
    });
}

/** 列出窗口（供手机端选择器） */
function listProfiles(): any[] {
  const out: any[] = [];
  for (const ctx of windowState.getAllContexts()) {
    if ((ctx as any).isSubagent) continue;
    const p = getProfileById(ctx.profileId);
    out.push({ id: ctx.profileId, name: (p && p.name) || String(ctx.profileId).slice(0, 8) });
  }
  return out;
}

function getCurrentProfile(): string {
  // 不走 getTargetContext，避免其失效分支里 broadcastProfiles → getCurrentProfile 递归
  if (targetProfileId && windowState.getWindowByProfileId(targetProfileId)) return targetProfileId;
  const ctx = windowState.getMainContext();
  return (ctx && ctx.profileId) || '';
}

function selectProfile(profileId: string): void {
  targetProfileId = profileId || '';
}

/** 节流刷新某窗口的流式文本（增量 delta）。
 *  全量以 sent 为前缀 → 只发新增部分（reset=false）；
 *  否则（strip 结果回退/重排，如工具块被剔除）→ 发全文并置 reset=true 让手机端清空重来。 */
function flushStream(profileId: string): void {
  const s = streamStates.get(profileId);
  if (!s) return;
  s.timer = null;
  if (!s.text) return;
  let delta: string;
  let reset = false;
  if (s.text.startsWith(s.sent)) {
    delta = s.text.slice(s.sent.length);
  } else {
    delta = s.text;
    reset = true;
  }
  s.sent = s.text;
  if (!delta && !reset) return;
  remoteServer.broadcast({ type: 'ai-stream', profileId, delta, reset });
}

/** 收到流式文本（onStream 给的是全量累积文本，直接覆盖） */
function onAiStream(text: string, profileId: string): void {
  if (!remoteServer.isRunning()) return;
  const pid = profileId || '';
  const s = getStreamState(pid);
  if (!s.active) {
    s.active = true;
    s.sent = ''; // 新一轮流式开始，重置增量基线
    remoteServer.broadcast({ type: 'ai-start', profileId: pid });
  }
  s.text = text || '';
  if (!s.timer) s.timer = setTimeout(() => flushStream(pid), STREAM_FLUSH_MS);
}

/** 收到完整回复 */
function onAiReply(text: string, profileId: string): void {
  if (!remoteServer.isRunning()) return;
  const pid = profileId || '';
  clearBusy(pid);
  const s = getStreamState(pid);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  s.text = '';
  s.sent = '';
  s.active = false;
  remoteServer.broadcast({ type: 'ai-reply', profileId: pid, text: text || '' });
}

/** 收到用户停止生成信号 */
function onAiStop(profileId: string): void {
  if (!remoteServer.isRunning()) return;
  const pid = profileId || '';
  clearBusy(pid);
  const s = getStreamState(pid);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  s.text = '';
  s.sent = '';
  s.active = false;
  remoteServer.broadcast({ type: 'ai-stop', profileId: pid });
}

/** 收到生成错误 */
/** 清理某窗口的流式状态（窗口关闭时调用，防 Map 无限增长） */
function cleanupStreamState(profileId: string): void {
  const s = streamStates.get(profileId);
  if (s && s.timer) { clearTimeout(s.timer); s.timer = null; }
  streamStates.delete(profileId);
  clearBusy(profileId);
}

function onAiError(profileId: string, error?: string): void {
  if (!remoteServer.isRunning()) return;
  const pid = profileId || '';
  clearBusy(pid);
  const s = getStreamState(pid);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  s.text = '';
  s.sent = '';
  s.active = false;
  remoteServer.broadcast({ type: 'ai-error', profileId: pid, error: error || '生成失败' });
}

/** 手机上传附件（图片等）→ 复用 CDP 上传通道注入 AI 页面 */
async function onPhoneAttach(file: { name: string; data: string; mime: string }): Promise<{ success: boolean; error?: string }> {
  const ctx = getTargetContext();
  if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
    return { success: false, error: '目标窗口不可用' };
  }
  try {
    const r = await cdpAttach(ctx, { name: file.name, data: file.data, mime: file.mime });
    if (r && r.success) return { success: true };
    return { success: false, error: (r && r.error) || '上传失败' };
  } catch (err: any) {
    console.error('[Remote] 附件上传异常:', err.message);
    return { success: false, error: err.message || '上传异常' };
  }
}

/** 工具状态 */
function onTool(phase: string, name: string, profileId: string): void {
  if (!remoteServer.isRunning()) return;
  remoteServer.broadcast({ type: 'tool', profileId: profileId || '', phase, name: name || '' });
}

/** 启动远程服务 */
async function initRemote(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.enabled) {
    console.log('[Remote] 未启用，跳过启动');
    return;
  }
  // 窗口集合变化（新建/关闭/切换）→ 广播新列表给手机（避免选择器过期）
  if (disposeWindowsChanged) { try { disposeWindowsChanged(); } catch (_) {} }
  disposeWindowsChanged = windowState.onWindowsChanged(() => {
    // 清理已关闭窗口的流式状态（防 Map 增长）
    const alive = new Set(listProfiles().map((p) => p.id));
    for (const pid of Array.from(streamStates.keys())) {
      if (!alive.has(pid)) cleanupStreamState(pid);
    }
    broadcastProfiles();
  });
  const r = await remoteServer.startServer({
    onUserMessage: onPhoneMessage,
    onStop: onPhoneStop,
    onAttach: onPhoneAttach,
    onListProfiles: listProfiles,
    onGetCurrentProfile: getCurrentProfile,
    onSelectProfile: selectProfile,
  }, cfg.port, cfg.token);
  if (!r.ok) {
    console.error('[Remote] 启动失败:', r.error);
    // 启动失败：释放已注册的窗口变化监听器（防重复启动累积）
    if (disposeWindowsChanged) { try { disposeWindowsChanged(); } catch (_) {} disposeWindowsChanged = null; }
    return;
  }
  console.log('[Remote] 已启动，端口=' + r.port + '，令牌已配置');

  // 若开启了内置隧道托管，自动拉起 cloudflared
  if (cfg.tunnelEnabled) {
    startTunnel({
      port: r.port || cfg.port,
      tunnelToken: cfg.tunnelToken,
    }).then((tr) => {
      if (tr.ok) {
        console.log('[Remote] Cloudflare 隧道已就绪:', tr.url || '(固定模式)');
      } else {
        console.warn('[Remote] Cloudflare 隧道启动告警:', tr.error);
      }
    }).catch((err) => {
      console.warn('[Remote] Cloudflare 隧道异常:', err.message);
    });
  }
}

/** 停用（同时清理全部流式节流状态，停止隧道子进程，等待底层端口释放） */
async function stopRemote(): Promise<void> {
  for (const s of streamStates.values()) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }
  streamStates.clear();
  busyProfiles.clear();
  if (disposeWindowsChanged) { try { disposeWindowsChanged(); } catch (_) {} disposeWindowsChanged = null; }
  try { await stopTunnel(); } catch (_) {}
  await remoteServer.stopServer();
}

export { initRemote, stopRemote, onAiStream, onAiReply, onAiStop, onAiError, onTool, getTunnelStatus };
