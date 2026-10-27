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
  //    会占满 AI 页面主线程（O(n²)）。合并到 ~60ms 一次，只处理最新全量文本。
  //    注意：与 manager.ts 的 STREAM_FLUSH_MS（60ms）叠加后，端到端首帧延迟约 120ms。
  //    bridge 侧节流保留是为了省 AI 页面主线程的 stripBlocks 开销（下层更贵）。
  //    注意：跳过 finished 收尾帧（它带全文，会与 onInterceptedResponse 的 ai-reply 重复 → 双气泡）
  let streamTimer: any = null;
  let pendingText = '';
  let pendingThink = '';
  /** 清理流式节流状态。
   *  flushText=true：先把节流窗口内未上报的最后一批文本发出去（stop/error 无后续全量帧兜底，必须 flush）；
   *  flushText=false：只清 timer/pending（reply 有全量帧兜底，避免重复上报）。
   *  调用点语义：
   *   - onInterceptedResponse（ai-reply）：有全量 → false（避免与全文重复）
   *   - onUserStop / onAiError：无全量 → true（保尾帧）
   */
  function stopStreamThrottle(flushText: boolean): void {
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    if (flushText && enabled && (pendingText || pendingThink)) {
      let clean = stripBlocks(pendingText);
      if (!clean && !pendingThink && pendingText) clean = ' ';
      if (clean || pendingThink) { try { report({ type: 'ai-stream', text: clean, think: pendingThink }); } catch (_) { /* ignore */ } }
    }
    pendingText = '';
    pendingThink = '';
  }
  onStream((ev: any) => {
    if (!enabled || !ev || ev.finished) return;
    if (!ev.text && !ev.think) return; // 空心跳
    pendingText = ev.text || '';
    pendingThink = ev.think || '';
    if (streamTimer) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      const text = pendingText;
      const think = pendingThink;
      pendingText = ''; // 已投递：清空，防下一轮 stop 时重复 flush 上一段全文
      pendingThink = '';
      let clean = stripBlocks(text);
      // 若正文全被剥离（如正在生成工具代码），但原始 text 有值，塞个空格保活
      // 这样手机端就能立刻建出流式气泡，不至于等到工具执行完才显示。
      if (!clean && !think && text) clean = ' ';
      if (clean || think) report({ type: 'ai-stream', text: clean, think });
    }, 60);
  });

  // 2. AI 回复完成 → 上报（剥离工具代码块）
  onInterceptedResponse((text: string) => {
    stopStreamThrottle(false); // 有全量帧，不 flush（防重复）
    if (!enabled || !text) return;
    const clean = stripBlocks(text);
    if (!clean) return;
    report({ type: 'ai-reply', text: clean });
  });

  // 3. 用户停止生成（网页点停止或收到停止信号）→ 上报收尾
  onUserStop(() => {
    stopStreamThrottle(true); // 无后续全量帧，先 flush 保尾
    if (!enabled) return;
    report({ type: 'ai-stop' });
  });

  // 自动重试感知：电脑端自动重试引擎（retry.ts）会接管"可重试的临时错误"。
  // 若不感知，同一错误会被立即上报手机 → 手机在电脑倒计时重试时就显示"生成失败/请求失败"，
  // 而其实电脑端还在重试（用户看到的是"总是失败"）。
  // retry 引擎在同 tick 同步派发 cuckoo-retry-state；用 setTimeout(0) 延迟判断，避免注册顺序依赖。
  let retryActive = false;
  let retryNoticeShown = false;
  try {
    window.addEventListener('cuckoo-retry-state', (ev: any) => {
      const st = ev && ev.detail && ev.detail.state;
      retryActive = (st === 'pending');
      if (!retryActive) retryNoticeShown = false; // 重试结束 → 允许下次再提示
    });
  } catch (_) { /* ignore */ }

  // 4. AI 请求失败（网络/限流报错）→ 上报收尾（仅当不在自动重试中）
  onAiError((detail: any) => {
    stopStreamThrottle(true); // 同上，保尾
    if (!enabled) return;
    setTimeout(() => {
      if (!enabled) return;
      if (retryActive) {
        // 电脑端正在自动重试 → 不报终态，仅首次提示手机"正在重试"，保持执行态
        if (!retryNoticeShown) {
          retryNoticeShown = true;
          report({ type: 'sys', keepBusy: true, text: '请求失败，电脑端正在自动重试…' });
        }
        return;
      }
      report({ type: 'ai-error', error: (detail && detail.text) || '请求失败' });
    }, 0);
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
    // 必须检查返回值：sendToChat 可能返回 false（找不到输入框 / 被停止信号 cancelPendingSend 取消）。
    // 手机端已乐观显示用户气泡，若这里静默失败，手机会误以为已发送、AI 却收不到。
    sendToChat(text, '远程', undefined).then((ok) => {
      if (!ok) {
        report({ type: 'sys', text: '消息未发出（输入框未就绪或被停止取消），请重试' });
      }
    }).catch((err: any) => {
      report({ type: 'sys', text: '消息发送失败：' + ((err && err.message) || String(err)) });
    });
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
  // 流式边界兜底：开标记行未收全（如 ```cuck）→ 也隐藏，避免尾部闪现
  out = out.replace(/```[a-z]*\s*$/i, '');
  return out.trim();
}

export { stripBlocks };
