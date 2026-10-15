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

/** 流式节流：60ms 推送一次。注意 onStream 的 text 是「全量累积文本」，故直接覆盖。 */
const STREAM_FLUSH_MS = 60;

/** 每窗口独立的流式状态（防多窗口串扰）。
 *  text = 最新全量累积文本；sent = 上次已广播出去的文本（用于计算 delta）。 */
interface StreamState {
  text: string; sent: string; think: string; thinkSent: string;
  timer: any; active: boolean;
  /** 该窗口当前正在跑的工具数（用于 watchdog 判定"不在工具阶段"） */
  toolCount: number;
  /** 最近一次流式/工具活动时间戳（用于静默判定） */
  lastAt: number;
  /** 最近一次工具活动时间戳（tool-end 丢失时的时间兜底） */
  toolLastAt: number;
}
const streamStates = new Map<string, StreamState>();

function getStreamState(profileId: string): StreamState {
  let s = streamStates.get(profileId);
  if (!s) { s = { text: '', sent: '', think: '', thinkSent: '', timer: null, active: false, toolCount: 0, lastAt: 0, toolLastAt: 0 }; streamStates.set(profileId, s); }
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
/** 卡"生成中" watchdog 定时器 */
let busyWatchdogTimer: any = null;

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
  if (!s.text && !s.think) return;
  // 正文与思考各自算增量；任一"前缀不匹配"即触发 reset（手机端清空重来）
  // 关键：reset 时两个字段都必须发全量（手机端会清空，只发 delta 会丢前缀）
  const textOk = s.text.startsWith(s.sent);
  const thinkOk = s.think.startsWith(s.thinkSent);
  const reset = !textOk || !thinkOk;
  const textDelta = reset ? s.text : s.text.slice(s.sent.length);
  const thinkDelta = reset ? s.think : s.think.slice(s.thinkSent.length);
  s.sent = s.text;
  s.thinkSent = s.think;
  if (!textDelta && !thinkDelta && !reset) return;
  remoteServer.broadcast({ type: 'ai-stream', profileId, thinkDelta, textDelta, reset });
}

/** 收到流式文本（onStream 给的是全量累积快照，直接覆盖）。
 *  think 为思考全量，text 为正文全量；两者独立累积。 */
function onAiStream(text: string, think: string, profileId: string): void {
  if (!remoteServer.isRunning()) return;
  const pid = profileId || '';
  const s = getStreamState(pid);
  if (!s.active) {
    s.active = true;
    s.sent = ''; // 新一轮流式开始，重置增量基线
    s.think = '';
    s.thinkSent = '';
    s.toolCount = 0; // 上轮 tool-end 可能丢失，新一轮开始清零防 watchdog 误跳过
    remoteServer.broadcast({ type: 'ai-start', profileId: pid });
  }
  s.text = text || '';
  s.think = think || '';
  s.lastAt = Date.now();
  if (!s.timer) s.timer = setTimeout(() => flushStream(pid), STREAM_FLUSH_MS);
}

/** 新客户端连入：把每个活跃流的当前全量以 reset=true 补发，避免重连后缺消息 */
function pushActiveStreamsToNewClient(): void {
  if (!remoteServer.isRunning()) return;
  for (const [pid, s] of streamStates) {
    if (!s.active) continue;
    remoteServer.broadcast({
      type: 'ai-stream',
      profileId: pid,
      thinkDelta: s.think,
      textDelta: s.text,
      reset: true,
    });
    // 关键：补发即把当前全量标记为"已送达"，否则下一轮 flush 会重复发尾部
    s.sent = s.text;
    s.thinkSent = s.think;
  }
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
  s.think = '';
  s.thinkSent = '';
  s.active = false;
  s.toolCount = 0;
  remoteServer.broadcast({ type: 'ai-reply', profileId: pid, text: text || '' });
}

/** 收到用户停止生成信号 */
function onAiStop(profileId: string): void {
  if (!remoteServer.isRunning()) return;
  const pid = profileId || '';
  clearBusy(pid);
  const s = getStreamState(pid);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  // 先把尚未广播的尾帧 flush 出去，再清空（否则节流窗口内最后 <100ms 文本/思考永久丢失）
  if ((s.text && s.text !== s.sent) || (s.think && s.think !== s.thinkSent)) flushStream(pid);
  s.text = '';
  s.sent = '';
  s.think = '';
  s.thinkSent = '';
  s.active = false;
  s.toolCount = 0;
  remoteServer.broadcast({ type: 'ai-stop', profileId: pid });
}

/** 卡"生成中"兜底 watchdog 间隔（ms） */
const BUSY_WATCHDOG_MS = 3000;
/** 判定为"已停止但未收尾"所需的静默时长（ms）——给足余量避免误伤刚要开始的生成 */
const BUSY_STALE_MS = 8000;
/** 工具阶段无活动的超时（ms）——超过视为 tool-end 丢失，强制收尾（工具可能长跑，给足量） */
const BUSY_TOOL_STALE_MS = 300000;
/** 卡"生成中" watchdog：网页已停止生成（windowState.isGenerating=false）、
 *  不在工具阶段、且静默超过阈值 → 主动收尾，防终态事件丢失导致手机端永久 busy。
 *  这是 Harness 侧 `ai-state` 心跳兜底的对应机制（手机端独缺）。 */
function busyWatchdogTick(): void {
  if (!remoteServer.isRunning()) return;
  const now = Date.now();
  for (const [pid, s] of streamStates) {
    if (!s.active) continue;
    if (windowState.isGenerating(pid)) continue; // 网页仍在生成：正常，给足耐心
    if (s.toolCount > 0) {
      // 有工具账目：若长时间无任何工具活动（tool-end 丢失），且网页已停 → 强制收尾，
      // 否则 toolCount 卡住会让 watchdog 永久跳过（修复在最需要的 stuck 场景失效）。
      if (now - s.toolLastAt < BUSY_TOOL_STALE_MS) continue;
      console.log('[Remote] watchdog：tool-end 疑似丢失，强制收尾 ' + pid);
    } else {
      if (now - s.lastAt < BUSY_STALE_MS) continue; // 静默不足：可能是刚起手
      console.log('[Remote] watchdog：检测到已停止但未收尾，主动收尾 ' + pid);
    }
    onAiStop(pid);
  }
}

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
  // 同 onAiStop：先 flush 未广播的尾帧（含思考），再清空
  if ((s.text && s.text !== s.sent) || (s.think && s.think !== s.thinkSent)) flushStream(pid);
  s.text = '';
  s.sent = '';
  s.think = '';
  s.thinkSent = '';
  s.active = false;
  s.toolCount = 0;
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
  const pid = profileId || '';
  const s = getStreamState(pid);
  // 维护工具计数（watchdog 据此判断"是否在工具执行阶段"）
  if (phase === 'start') s.toolCount++;
  else if (phase === 'end' && s.toolCount > 0) s.toolCount--;
  s.lastAt = Date.now();
  s.toolLastAt = Date.now();
  remoteServer.broadcast({ type: 'tool', profileId: pid, phase, name: name || '' });
}

/** 广播远程启用状态给所有 AI 页面（bridge 门控开关） */
function broadcastRemoteMode(enabled: boolean): void {
  for (const ctx of windowState.getAllContexts()) {
    try {
      const v = ctx && ctx.view;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.send('remote-mode', { enabled });
      }
    } catch (_) { /* ignore */ }
  }
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
    onNewClient: pushActiveStreamsToNewClient,
  }, cfg.port, cfg.token);
  if (!r.ok) {
    console.error('[Remote] 启动失败:', r.error);
    // 启动失败：释放已注册的窗口变化监听器（防重复启动累积）
    if (disposeWindowsChanged) { try { disposeWindowsChanged(); } catch (_) {} disposeWindowsChanged = null; }
    return;
  }
  console.log('[Remote] 已启动，端口=' + r.port + '，令牌已配置');
  // 广播启用状态给所有 AI 页面（bridge 据此打开上报门控）。
  // 关键：bridge 若在服务启动前查询 remote-is-enabled 得到 false，此后再无事件复位 →
  // onStream 被门控全丢（"连接成功但推送失败"）。故启动成功后必须主动广播一次。
  broadcastRemoteMode(true);
  // 启动卡"生成中" watchdog（终态事件丢失时兜底收尾）
  if (busyWatchdogTimer) clearInterval(busyWatchdogTimer);
  busyWatchdogTimer = setInterval(busyWatchdogTick, BUSY_WATCHDOG_MS);

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
  if (busyWatchdogTimer) { clearInterval(busyWatchdogTimer); busyWatchdogTimer = null; }
  for (const s of streamStates.values()) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }
  streamStates.clear();
  busyProfiles.clear();
  if (disposeWindowsChanged) { try { disposeWindowsChanged(); } catch (_) {} disposeWindowsChanged = null; }
  try { await stopTunnel(); } catch (_) {}
  await remoteServer.stopServer();
  broadcastRemoteMode(false);
}

export { initRemote, stopRemote, onAiStream, onAiReply, onAiStop, onAiError, onTool, getTunnelStatus, broadcastRemoteMode };
