/**
 * 远程控制：bridge 侧逻辑（运行在 AI 页面 preload）
 *
 * 职责：
 *   1. 监听 AI 回复完成 → 上报主进程 → 广播给手机
 *   2. 监听流式文本 → 上报（节流由主进程做）
 *   3. 监听工具调用（start/end）→ 上报
 *
 * 门控：主进程切换远程启用状态时通知（enabled=false 时各回调立即返回，零开销）。
 * 注意：手机用户消息回显由手机端乐观 UI 负责，此处不订阅 onUserMessageSent。
 */
import { createRequire } from 'node:module';
import { onInterceptedResponse, onToolCall, onStream, onUserStop, onAiError } from './intercept/observer.js';
import { looksLikeToolScript } from './parser/js-detector.js';
import { sendToChat } from '../overlay/chat-input.js';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

function report(payload: any): void {
  try {
    ipcRenderer.invoke('remote-report', payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

let inited = false;
export function initRemoteBridge(): void {
  if (inited) return;
  inited = true;

  // 启用门控：远程未启用时各回调立即返回（零开销）；主进程启停时下发 remote-mode 切换
  let enabled = false;
  ipcRenderer.on('remote-mode', (_e: any, payload: any) => {
    enabled = !!(payload && payload.enabled);
  });
  try {
    ipcRenderer.invoke('remote-is-enabled').then((r: any) => {
      if (r) enabled = !!r.enabled;
    }).catch(() => {});
  } catch (_) { /* ignore */ }

  // 1. 流式文本 → 上报（剥离工具代码块；此处节流 ~100ms，主进程再节流广播）
  //    节流原因：onStream 每个 token 事件都触发，若每帧对全文跑 stripBlocks（6 次正则）
  //    会占满 AI 页面主线程（O(n²)）。合并到 ~100ms 一次，只处理最新全量文本。
  //    注意：与 manager.ts 的 STREAM_FLUSH_MS（100ms）叠加后，端到端首帧延迟约 200ms。
  //    bridge 侧节流保留是为了省 AI 页面主线程的 stripBlocks 开销（下层更贵）。
  //    注意：跳过 finished 收尾帧（它带全文，会与 onInterceptedResponse 的 ai-reply 重复 → 双气泡）
  let streamTimer: any = null;
  let pendingText = '';
  /** 清理流式节流状态：任意终帧（reply/stop/error）到达时必须调用，
   *  否则节流窗口内排队的幽灵帧会在终帧之后上报，导致手机端重复 ai-start、生成幽灵气泡。 */
  function stopStreamThrottle(): void {
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    pendingText = '';
  }
  onStream((ev: any) => {
    if (!enabled || !ev || !ev.text || ev.finished) return;
    pendingText = ev.text;
    if (streamTimer) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      const clean = stripBlocks(pendingText);
      if (clean) report({ type: 'ai-stream', text: clean });
    }, 100);
  });

  // 2. AI 回复完成 → 上报（剥离工具代码块）
  onInterceptedResponse((text: string) => {
    stopStreamThrottle(); // 先清幽灵帧，再上报终帧（顺序不能反）
    if (!enabled || !text) return;
    const clean = stripBlocks(text);
    if (!clean) return;
    report({ type: 'ai-reply', text: clean });
  });

  // 3. 用户停止生成（网页点停止或收到停止信号）→ 上报收尾
  onUserStop(() => {
    stopStreamThrottle();
    if (!enabled) return;
    report({ type: 'ai-stop' });
  });

  // 4. AI 请求失败（网络/限流报错）→ 上报收尾
  onAiError((detail: any) => {
    stopStreamThrottle();
    if (!enabled) return;
    report({ type: 'ai-error', error: (detail && detail.text) || '请求失败' });
  });

  // 5. 工具调用状态 → 上报（仅状态）
  onToolCall((ev: any) => {
    if (!enabled || !ev) return;
    report({ type: 'tool', phase: ev.phase || '' });
  });

  // 6. 手机来消息 → 主进程转发到此 → 发给 AI
  ipcRenderer.on('remote-user-message', (_e: any, payload: any) => {
    const text = payload && payload.text;
    if (!text) return;
    // 上报给 harness 显示用户气泡（否则纯净模式可见历史与实际上下文分叉）
    try { ipcRenderer.invoke('harness-event-report', { type: 'user', text }).catch(() => {}); } catch (_) { /* ignore */ }
    sendToChat(text, '远程', undefined).catch(() => {});
  });
}

/** 移除文本中的 cuckoo 工具块，以及调用了内置/MCP工具函数的 js/javascript 脚本块 */
function stripBlocks(text: string): string {
  if (!text) return '';
  const F = '```';
  if (text.indexOf(F) === -1) return text.trim();
  let out = text;
  // 1. cuckoo 代码块：一律视为工具执行脚本，剔除（包含完整、未闭合或刚输出的围栏）
  out = out.replace(/```cuckoo\s*\n[\s\S]*?```/gi, '');
  out = out.replace(/```cuckoo\s*\n[\s\S]*$/gi, '');
  out = out.replace(/```cuckoo\s*$/i, '');

  // 2. js / javascript 代码块：仅剔除包含工具特征调用的脚本，保留普通示例代码
  out = out.replace(/```(?:javascript|js)\s*\n([\s\S]*?)```/gi, (match, code) => {
    return looksLikeToolScript(code) ? '' : match;
  });
  // 未闭合的 js 工具块（流式中且显露出工具特征）：隐藏
  out = out.replace(/```(?:javascript|js)\s*\n([\s\S]*)$/gi, (match, code) => {
    return looksLikeToolScript(code) ? '' : match;
  });

  // 3. 裸 ``` 且全文仅此一个围栏（且行尾紧随工具标记）→ 隐藏；普通代码块保留
  const firstFence = out.indexOf('```');
  if (firstFence !== -1 && out.indexOf('```', firstFence + 3) === -1) {
    if (/```\s*$/i.test(out)) out = out.replace(/```\s*$/i, '');
  }
  return out.trim();
}

export { stripBlocks };
