/**
 * 纯净对话模式（Harness）的 bridge 侧逻辑
 *
 * 运行在 AI 页面（preload）。职责：
 *   1. 订阅 AI 回复（onInterceptedResponse）→ 上报主进程 → harness 页面显示
 *   2. 订阅工具调用事件（onToolCall）→ 上报工具开始/结束
 *   3. 监听主进程转发的 'harness-user-message' → 调 sendToChat 发到 AI
 *   4. 目标模式：goalDone 工具（主进程）直接向 harness 视图推送 goal-done，无需在此识别文本标记
 *   5. 生成状态心跳（ai-state）：周期上报"AI 页面是否正在生成"，供 harness 校正运行态
 *
 * 与官方解耦：仅在 bridge/entry.ts 中 import 激活；其余为独立文件。
 *
 * 【为什么不做上报门控】
 * 这里曾用主进程下发的 'harness-mode' 开关做门控（"关闭时零开销"）。但它有个致命性质：
 * 只要判断错一次（AI 页面导航/重载重建 preload 会丢广播；查询通道本身也可能失败），
 * 所有上报被静默丢弃 —— 界面表现是"对话流空白 + 状态永久卡在运行中"，
 * 而且因为丢弃是静默的，排查成本极高（实测踩过两次）。
 * 现在一律上报：主进程在没有 harness 视图时本就会丢弃，多出的开销只是几次 IPC，
 * 换掉一整类"哑界面"故障是划算的。
 */
import { createRequire } from 'node:module';
import {
  onInterceptedResponse, onToolCall, onStream, onTaskIdle, onAiError, onUserStop,
  requestAbort, clearAbort,
} from './intercept/observer.js';
import { sendToChat, cancelPendingSend, clearInputArea, onMessageDelivered } from '../overlay/chat-input.js';
import { hideToolMask } from '../overlay/panel.js';
import { cancelPendingForSwitch, resumeRetry } from './loop/retry.js';
import { extractJsToolBlocks } from './parser/js-detector.js';
import { setSuspended as setWatchdogSuspended } from './loop/watchdog.js';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

/** 移除文本中的 cuckoo / js 工具代码块（工具调用改由卡片展示） */
function stripToolBlocks(text: string): string {
  if (!text) return '';
  // 快速路径：正文无代码围栏 → 无需跑 3 个全文正则。
  // 本函数在流式每帧被调用（onStream），正文长度随生成增长；
  // 绝大多数帧不含围栏，跳过正则可显著降低长回复下的累积开销。
  if (text.indexOf('```') === -1) return text.trim();
  let out = text;
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*?```/gi, '');
  // 流式输出中途：代码块尚未闭合 → 从开标记起全部隐藏，避免 ```cuckoo 内容闪现
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*$/gi, '');
  out = out.replace(/```(?:cuckoo|javascript|js)\s*$/gi, '');
  // 流式边界兜底：开标记行未收全（如 ```cuck / ```cuckoo 尚未换行）→ 也隐藏，
  // 否则这几个字符会作为普通文本闪现在流式输出尾部。
  // B-009：要求反引号后至少带一个字母——即"半截开标记"才剥；回复若以普通语言代码块
  // （如 ```python）收尾，其收尾 ``` 是裸反引号（后无字母），不被误剥导致气泡渲染异常。
  out = out.replace(/```[a-z]+\s*$/i, '');
  return out.trim();
}

/** 回复里是否含工具调用代码块（有则说明后面还有工具循环，本轮不算结束） */
const HAS_TOOL_BLOCK_RE = /```(?:cuckoo|javascript|js)\s*\n/i;

function report(payload: any): void {
  try {
    ipcRenderer.invoke('harness-event-report', payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

/** 初始化 harness bridge（幂等） */
let inited = false;
export function initHarnessBridge(): void {
  if (inited) return;
  inited = true;

  // ===== AI 页面生成状态（权威信号）=====
  // 由 hook 事件驱动，是"网页到底还在不在干活"的唯一可靠来源。
  // 变化即时上报 + 每 2 秒心跳（harness 页面可能在生成中途才被创建/刷新，
  // 只报变化的话它会拿不到当前状态）。
  let aiGenerating = false;
  // 最近一次"AI 页面确实有动作"的时间戳。心跳看门狗据此复位卡死的 aiGenerating。
  // 背景：aiGenerating 由流式/回复/工具/错误/停止等事件驱动，任一关键帧丢失
  //（页面重载、hook 中断、SSE 异常收尾）都会让它永久停在 true，
  // 心跳随即持续上报 g=true，使 harness 侧的静默兜底永远失效 —— 界面卡「生成中…」。
  let lastAiActivityAt = Date.now();
  function markAiActivity(): void { lastAiActivityAt = Date.now(); }
  // 无任何 AI 页面活动多久后判定 aiGenerating 是陈旧残留。
  // 取值说明：工具执行期间 aiGenerating 本应为 false（finished 帧已复位），
  // 框架侧长任务由 harness 的 toolRunning 容忍窗口（10 分钟）单独兜底，
  // 故这里给 120s 不会误伤正常长任务。
  const AI_GENERATING_STALE_MS = 120000;
  function setAiGenerating(next: boolean): void {
    if (aiGenerating === next) return;
    aiGenerating = next;
    // AI 从"未工作"变为"正在工作" = 新一轮任务开始，恢复看门狗
    // （否则普通模式/框架续跑等不经 harness-user-message 的路径会让看门狗永久挂起）
    if (next === true) {
      try { setWatchdogSuspended(false); } catch (_) { /* ignore */ }
    }
    report({ type: 'ai-state', generating: next });
  }
  try {
    setInterval(() => {
      // 看门狗：aiGenerating 卡 true 且长时间无任何真实活动 → 判定为陈旧残留，强制复位。
      // 否则心跳会一直上报 g=true，harness 永远等不到"AI 已停止"，只能手动点停止解套。
      if (aiGenerating && Date.now() - lastAiActivityAt > AI_GENERATING_STALE_MS) {
        console.warn('[Cuckoo Harness] aiGenerating 已 ' + Math.round((Date.now() - lastAiActivityAt) / 1000) + 's 无活动，判定为陈旧残留，强制复位');
        setAiGenerating(false);
      }
      report({ type: 'ai-state', generating: aiGenerating });
    }, 2000);
  } catch (_) { /* ignore */ }

  // 流式增量 → 上报
  onStream((ev: any) => {
    if (!ev) return;
    markAiActivity();
    if (ev.finished) {
      // 收尾帧 = 流式输出结束（网页本轮生成已完成）。
      // 这是最可靠的"停止生成"信号：即使最终回复含工具块（onInterceptedResponse
      // 会因 HAS_TOOL_BLOCK_RE 跳过复位），这里也一定把 aiGenerating 复位，
      // 否则心跳会持续上报 true，令 harness 的静默兜底永远失效（卡"生成中"）。
      setAiGenerating(false);
    } else if (ev.text || ev.think) {
      setAiGenerating(true);
    }
    const t = stripToolBlocks(ev.text || '');
    report({ type: 'stream', think: ev.think || '', text: t, finished: !!ev.finished });
  });

  // AI 回复完成 → 上报（目标收束由 goalDone 工具在主进程直接推送，这里不再检测文本标记）
  onInterceptedResponse((text: string, meta: any) => {
    markAiActivity();
    const raw = text || '';
    // 回复里没有工具调用 → 本轮真的结束（有工具调用时后面还有工具循环）
    if (!HAS_TOOL_BLOCK_RE.test(raw)) setAiGenerating(false);
    // 透传服务端权威消息 id（供 harness 真截断定位；平台未提供时为 null）
    const msgIds = (meta && meta.msgIds) || null;
    // hasTool 必须显式透传：text 已被 stripToolBlocks 剥掉工具块，harness 侧无从判断。
    // observer 是先通知本回调、再执行工具（emitToolCall start 在之后），
    // 故此刻 harness 的 toolRunningCount 仍为 0 —— 不带此标记会让状态栏误闪「就绪」。
    // ⚠️ 必须用 extractJsToolBlocks 而非 HAS_TOOL_BLOCK_RE：后者是宽松正则，
    //    普通回答里附带的 js 示例也会命中，但那种块根本不会被执行
    //    （extractJsToolBlocks 要求 js 块是纯代码块且调用了工具函数）。
    //    用宽松正则会让状态栏误显示「工具运行中…」，随后被静默兜底收尾。
    const hasTool = extractJsToolBlocks(raw).length > 0;
    report({ type: 'assistant-done', text: stripToolBlocks(raw), msgIds, hasTool });
  });

  // 任务空闲（observer 判定：回复里没有工具调用 = 本轮任务真的结束）→ 上报。
  // 这是"网页执行完了"的权威终态信号：harness 据此收尾，不再靠超时猜。
  onTaskIdle(() => {
    markAiActivity();
    setAiGenerating(false);
    report({ type: 'task-idle' });
  });

  // AI 请求失败 → 不再处于生成中（重试引擎会重新投递，届时再置忙）
  onAiError(() => {
    markAiActivity();
    setAiGenerating(false);
  });

  // 网页模式点"停止"（hook 检测到 status=stopped）→ 同步纯净模式收尾
  onUserStop(() => {
    markAiActivity();
    setAiGenerating(false);
    report({ type: 'task-idle' });
  });

  // 工具调用事件 → 上报（含计划解析）
  onToolCall((ev: any) => {
    if (!ev) return;
    markAiActivity();
    if (ev.phase === 'start') {
      report({ type: 'tool-start', code: ev.code });
      // 计划（todoWrite）改由主进程读官方 globalThis.__cuckooTodos 后推送，这里不再用正则解析
    } else if (ev.phase === 'end') {
      report({
        type: 'tool-end',
        code: ev.code,
        success: !!ev.success,
        output: ev.output || '',
        error: ev.error || '',
      });
    }
  });

  // 框架侧投递（系统提示词 / 工具结果回传 / 看门狗 / 重试 / 压缩等）→ 上报运行态。
  // 内容不进对话流（那是底层指令），但要给 harness 一个"框架正在驱动 AI 页面"的反馈。
  // harness 自己发的用户消息（tag='harness'）不上报：气泡已显示，状态机自己管。
  onMessageDelivered((info: any) => {
    if (!info) return;
    // 投递即视为活动：从"消息发出"到"首个流式帧"之间可能隔着拟人化延迟（6~16s）
    // 乃至模型排队，不续命的话看门狗可能把这段正常等待误判为陈旧残留。
    markAiActivity();
    setAiGenerating(true); // 有消息投递 = AI 页面即将工作
    if (info.tag === 'harness') return;
    report({ type: 'framework-send', tag: info.tag || '', system: !!info.isSystem });
  });

  // 用户在 harness 输入 → 主进程转发到此 → 发到 AI
  ipcRenderer.on('harness-user-message', (_e: any, payload: any) => {
    const text = payload && payload.text;
    if (!text) return;
    clearAbort(); // 新消息：清除中止标志
    try { setWatchdogSuspended(false); } catch (_) { /* ignore */ } // 新任务：恢复看门狗
    // 用户手动在纯净模式发送：无需 4-12s 自动化防风控延时，直接 0ms 秒发
    sendToChat(text, 'harness', 0).then((ok) => {
      if (!ok) {
        report({ type: 'status', text: '网页未找到输入框（可能在分享页或页面加载中）', busy: false });
        report({ type: 'task-idle' });
      }
    }).catch((err: any) => {
      report({ type: 'status', text: '发送失败: ' + ((err && err.message) || String(err)), busy: false });
      report({ type: 'task-idle' });
    });
  });

  // 停止：取消延时发送 + 清空输入框 + 中止工具回传
  ipcRenderer.on('harness-stop-signal', () => {
    try { cancelPendingSend(); } catch (_) { /* ignore */ }
    clearInputArea().catch((err: any) => {
      console.warn('[Cuckoo Harness] 清空输入框失败:', err?.message);
    });
    try { requestAbort(); } catch (_) { /* ignore */ }
    try { cancelPendingForSwitch(); } catch (_) { /* ignore */ }
    try { hideToolMask(); } catch (_) { /* ignore */ }
    // 暂停看门狗：否则旧任务的 SSE 静默会触发"请继续"，把已停止的任务催活
    try { setWatchdogSuspended(true); } catch (_) { /* ignore */ }
    setAiGenerating(false);
    console.log('[Cuckoo Harness] 收到停止信号：已取消待发送 + 清空输入框 + 中止工具回传 + 取消重试倒计时 + 暂停看门狗');
  });

  // 恢复重试（窗口组切换失败退回时）
  ipcRenderer.on('harness-resume-retry', () => {
    try { resumeRetry(); } catch (_) { /* ignore */ }
    try { setWatchdogSuspended(false); } catch (_) { /* ignore */ }
    console.log('[Cuckoo Harness] 收到恢复重试信号');
  });
}
