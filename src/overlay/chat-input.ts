/**
 * 聊天输入框交互：查找输入框、填入与发送消息、工具结果回传
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
import { createRequire } from 'node:module';
import { state } from './state.js';
import { BT } from '../infra/markdown.js';
import { getProviderByUrl } from '../providers/registry.js';

// electron 特殊：其 index.js 导出字符串，须用 createRequire（见 P3a 手册 1.5）
const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

/**
 * 根据当前 URL 获取 provider
 */
function getCurrentProvider(): any {
  return getProviderByUrl(window.location.href);
}

/**
 * 生成自适应拟人化等待时间（ms）：
 * 1. 结合回传内容长度计算认知负荷（短文本 3~6s，长文本 12~25s）；
 * 2. 附加轻量随机抖动（Jitter），破坏机械周期特征；
 * 3. 严格在 state 配置的 [min, max] 范围内钳制，兼顾防风控安全与丝滑流畅体验。
 */
function randomDelay(msg?: string): number {
  const min = typeof state.sendDelayMin === 'number' ? state.sendDelayMin : 1000;
  const max = typeof state.sendDelayMax === 'number' ? state.sendDelayMax : 10000;
  if (min >= max) return min;

  const len = typeof msg === 'string' ? msg.length : 0;
  // 认知耗时模型：按文本长度映射到用户配置区间。
  // 需求 114 改造（用户痛点：工具循环每轮 30~36 秒，20 轮要 10 分钟）：
  //  - 旧阈值 4000 对 Cuckoo 毫无意义 —— 工具回传动辄数千到上万字符，
  //    ratio 恒等于 1，延迟永远贴死在配置上限。
  //  - 现用 sqrt 压缩 + 阈值提到 16000：前段上升快（短内容能立刻区分），
  //    后段趋平（超长内容不会无限逼近 max），分布整体左移约 60%。
  //  - 宁可让「中等长度」多等一下，也不要让「所有长度」都等最久。
  const ratio = Math.min(1, Math.sqrt(len / 16000));
  const cognitiveBase = min + ratio * (max - min);
  // 随机抖动 Jitter：±35%（原 ±20%）。恒定节拍比「慢」更像机器特征，
  // 加大抖动让每次间隔差异明显，分散度比单纯拉长更有价值。
  const jitter = (Math.random() * 0.7 - 0.35) * cognitiveBase;
  const target = Math.round(cognitiveBase + jitter);
  const clamped = Math.max(min, Math.min(max, target));
  // 钳制后若恰好落在边界，认知抖动会被抹平（短文本永远精确等于 min）——固定节拍即机器特征。
  // 在「对应边界附近」补一段均匀抖动，既保持每次不同，又不破坏「内容越长越慢」的语义：
  //   - 命中 min：在 [min, min+25%区间] 抖动（短文本仍快）
  //   - 命中 max：在 [max-25%区间, max] 抖动（长文本仍慢，绝不反转到最快）
  // 命中下限时的抖动幅度必须按 min 自身比例算，不能按整个区间跨度算：
  // 默认 4~30s 时跨度 26s，25% 就是 6.5s —— 短消息会被抖到 10.5s，
  // 与「短内容快速响应」的目标直接冲突。改为 min 的 60%（4s → 4~6.4s）。
  const spanLow = Math.min((max - min) * 0.25, min * 0.6);
  const spanHigh = (max - min) * 0.25;
  if (clamped === min) return Math.round(min + Math.random() * spanLow);
  if (clamped === max) return Math.round(max - Math.random() * spanHigh);
  return clamped;
}

/**
 * 计算本次发送的拟人化时序：总延迟严格遵守 state.sendDelayMin/Max 配置区间，
 * 拆成 R（填充前反应停顿）+ S（填充后犹豫停顿）两段。
 * - 总延迟由 randomDelay(msg) 产出，已 clamp 到用户配置的 [min, max]；
 * - R 占比与「上一条 AI 回复长度」相关：回复越长，人读得越久，R 占比越高（0.3~0.55）；
 * - 两段之和 = 总延迟，绝不突破用户配置区间。
 * @param msg 要发送的内容（用于 randomDelay 的认知模型）
 * @param prevReplyLen 上一条 AI 回复的字符长度
 */
function planSendTiming(msg: string, prevReplyLen: number): { reactionMs: number; hesitationMs: number } {
  const total = randomDelay(msg);
  const len = Number.isFinite(prevReplyLen) && prevReplyLen > 0 ? prevReplyLen : 0;
  const ratio = Math.min(0.55, 0.3 + len / 8000);
  const reactionMs = Math.round(total * ratio);
  return { reactionMs, hesitationMs: total - reactionMs };
}

/**
 * 可被 cancelPendingSend 打断的等待。
 * @returns true=正常等待结束；false=被取消
 */
function interruptibleWait(ms: number, token: PendingSend): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (token.cancelled) { resolve(false); return; }
    token.wake = resolve;
    const t = setTimeout(() => {
      if (token.wake === resolve) token.wake = null;
      if (token.timer === t) token.timer = null;
      resolve(!token.cancelled);
    }, ms);
    token.timer = t;
  });
}

/**
 * 将文本填入输入框（React 兼容：使用原生 value setter）
 * @param input - 输入框元素
 * @param msg - 要填入的文本
 * @returns 是否成功填入
 */
async function setInputContent(input: any, msg: string): Promise<boolean> {
  try {
    // 平台自定义填入（优先）：部分站点对 ClipboardEvent('paste') 敏感
    // （ChatGPT 会识别为"粘贴的文件"附件），由 provider.fillInput 覆盖。
    try {
      const provider = getCurrentProvider();
      if (provider && typeof provider.fillInput === 'function') {
        const r = await provider.fillInput(input, msg);
        if (r) return true;
      }
    } catch (err: any) {
      console.warn('[Cuckoo Code] provider.fillInput 失败，回退通用逻辑:', err && err.message);
    }

    const api = (window as any).electronAPI;
    const isTextareaOrInput = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT';
    const isContentEdit = !!input.isContentEditable || (typeof input.getAttribute === 'function' && input.getAttribute('contenteditable') === 'true');

    // 优先尝试 Chromium 原生物理级文本输入管线（isTrusted=true）
    if (api && typeof api.insertTextToChat === 'function') {
      try {
        input.focus();
        if (isTextareaOrInput) {
          const desc = Object.getOwnPropertyDescriptor(
            input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
            'value'
          );
          if (desc && typeof desc.set === 'function') {
            desc.set.call(input, '');
          } else {
            input.value = '';
          }
          // 清空后补 input 事件：React 受控组件靠它同步 state，否则内部 state 残留旧值
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (isContentEdit) {
          document.execCommand('selectAll', false, undefined);
          document.execCommand('delete', false, undefined);
        }
        // 分段注入，每段 4000 字符，避免巨型文本瞬间溢出。
        // 任一段失败 → 整体判定失败（nativeOk=false），由下方 DOM 填充兜底，杜绝残缺内容。
        const CHUNK_SIZE = 4000;
        let nativeOk = true;
        for (let i = 0; i < msg.length; i += CHUNK_SIZE) {
          const chunk = msg.slice(i, i + CHUNK_SIZE);
          const ok = await api.insertTextToChat(chunk);
          if (!ok) { nativeOk = false; break; }
        }
        if (nativeOk) {
          // 校验完整性：注入后文本长度不得少于原消息长度（允许站点归一化空白导致少量偏差）
          const currentText = getInputText(input);
          if (currentText && currentText.length >= msg.length - 16) {
            return true;
          }
          console.warn('[Cuckoo Code] 原生注入后长度不符（期望 ' + msg.length + '，实际 ' + (currentText ? currentText.length : 0) + '），回退 DOM 填充');
        }
      } catch (err: any) {
        console.warn('[Cuckoo Code] 原生 insertTextToChat 异常，回退 DOM 填充:', err && err.message);
      }
    }

    if (isTextareaOrInput) {
      input.focus();
      const desc = Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      );
      if (desc && typeof desc.set === 'function') {
        desc.set.call(input, msg);
      } else {
        input.value = msg;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (isContentEdit) {
      input.focus();
      document.execCommand('selectAll', false, undefined);
      document.execCommand('delete', false, undefined);

      // 分段 Paste：每段 ≤6000 字符，不会触发 ChatGPT 的附件行为，且每段都很快。
      // 实测 12000 字符只需约 350ms。
      const CHUNK_SIZE = 6000;
      for (let i = 0; i < msg.length; i += CHUNK_SIZE) {
        const chunk = msg.slice(i, i + CHUNK_SIZE);
        const dt = new DataTransfer();
        dt.setData('text/plain', chunk);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        input.dispatchEvent(pasteEvent);
        if (i + CHUNK_SIZE < msg.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[Cuckoo Code] 设置输入框内容失败:', err.message);
    return false;
  }
}
/**
 * 将消息填入当前可见输入框并按指定延迟触发发送
 * @param msg - 要发送的消息
 * @param tag - 日志标记
 * @param fixedDelay - 固定延迟毫秒数；缺省时使用 randomDelay()
 * @param afterSent - 发送后回调
 * @returns 是否成功
 */
// 当前待发送的消息（可被 cancelPendingSend 取消）
interface PendingSend { timer: any; input: any; cancelled: boolean; tag?: string; resolve?: (v: boolean) => void; wake?: ((v: boolean) => void) | null; }
let pendingSend: PendingSend | null = null;

// 发送串行链：确保同一时刻只有一条消息处于"填充→等待→发送"流程，
// 避免并发时后一条覆盖输入框、导致前一条内容丢失（实测 Bug：两条并发只发出后者）。
let sendChain: Promise<any> = Promise.resolve();

// 「用户消息已发出」回调（供 bridge 上报远程等；overlay 不依赖上层，用回调注入）
// 系统内部消息的 tag（不视为"用户消息"，不上报远程）
const SYSTEM_MSG_TAGS = [
  'JS汇总', '看门狗', '重试', '重试(操作频繁)',
  '压缩-摘要', 'MCP信息', '技能与代理清单', '继续',
  'JSON工具调用提示', 'XML工具调用提示', '系统提示词',
];
const userMessageSentListeners = new Set<(text: string, tag?: string) => void>();
/** 注册"用户消息已发出"回调（支持多订阅；返回取消注册） */
function onUserMessageSent(cb: (text: string, tag?: string) => void): () => void {
  userMessageSentListeners.add(cb);
  return () => { userMessageSentListeners.delete(cb); };
}

// 「消息已投递」回调：所有经 sendToChat 发出的消息都派发（含系统内部消息），
// 供纯净对话模式显示"框架正在驱动 AI 页面"的运行态反馈（内容不显示，只反馈状态）。
let onMessageDeliveredCb: ((info: { text: string; tag: string; isSystem: boolean }) => void) | null = null;
/** 注册"消息已投递"回调（返回取消注册） */
function onMessageDelivered(cb: (info: { text: string; tag: string; isSystem: boolean }) => void): () => void {
  onMessageDeliveredCb = cb;
  return () => { if (onMessageDeliveredCb === cb) onMessageDeliveredCb = null; };
}

/** 是否框架内部消息（不视为"用户消息"，远程不上报；纯净模式只反馈状态不显示内容） */
function isSystemTag(tag?: string): boolean {
  return SYSTEM_MSG_TAGS.indexOf(tag || '') !== -1;
}

/** 派发"消息已投递"（回调缺失时零开销） */
function emitMessageDelivered(text: string, tag?: string): void {
  if (!onMessageDeliveredCb) return;
  try {
    onMessageDeliveredCb({ text: text, tag: tag || '', isSystem: isSystemTag(tag) });
  } catch (_) { /* ignore */ }
}

/**
 * 发送消息（对外入口）：挂到串行链上，前一条发送完成后才执行下一条。
 * 避免并发覆盖输入框内容（实测 Bug：两条并发只发出后者，前者丢失）。
 */
function sendToChat(msg: string, tag?: string, fixedDelay?: number, afterSent?: () => void, contextLen?: number): Promise<boolean> {
  const run = sendChain.then(() => doSendToChat(msg, tag, fixedDelay, afterSent, contextLen));
  // 链上无论成败都继续，避免一次失败卡死后续发送
  sendChain = run.then(() => undefined, () => undefined);
  return run;
}

async function doSendToChat(msg: string, tag?: string, fixedDelay?: number, afterSent?: () => void, contextLen?: number): Promise<boolean> {
  const input = findInputArea();
  if (!input) {
    console.log('[Cuckoo Code] 找不到输入框，无法发送消息');
    return false;
  }
  const token: PendingSend = { timer: null, input: input, cancelled: false, tag: tag };
  pendingSend = token;

  // 时序规划：总延迟严格遵守 state.sendDelayMin/Max，拆成 R（填之前）+ S（填之后）。
  // fixedDelay 显式传入（格式纠正等系统即时指令传 0）→ 不拆分，仅填充后一次性等，保持旧行为。
  let reactionMs = 0;
  let hesitationMs = 0;
  if (fixedDelay !== undefined) {
    hesitationMs = fixedDelay;
  } else {
    const timing = planSendTiming(msg, contextLen || 0);
    reactionMs = timing.reactionMs;
    hesitationMs = timing.hesitationMs;
  }

  // R：填充前的反应停顿（真人先看完回复才动手输入）
  if (reactionMs > 0) {
    console.log('[Cuckoo Code] 反应停顿 ' + reactionMs + 'ms（读完回复再输入）...');
    if (!(await interruptibleWait(reactionMs, token))) {
      if (pendingSend === token) pendingSend = null;
      return false;
    }
  }

  // T：填充内容（原生分块注入，自带自然耗时）
  if (!(await setInputContent(input, msg))) {
    if (pendingSend === token) pendingSend = null;
    return false;
  }
  // 填充期间被取消：不发送（输入框内容保留）
  if (token.cancelled) {
    return false;
  }

  // S：填充后的犹豫停顿，然后触发发送
  console.log('[Cuckoo Code] 消息已填入输入框，等待 ' + hesitationMs + 'ms 后发送...');
  return new Promise<boolean>((resolve) => {
    token.resolve = resolve;
    const timer = setTimeout(function() {
      if (pendingSend === token) pendingSend = null;
      if (token.cancelled) { resolve(false); return; }
      console.log('[Cuckoo Code] 等待结束，开始触发发送');
      Promise.resolve(triggerSend(input)).then(() => {
        console.log('[Cuckoo Code] 已触发发送, ' + (tag || '') + ', 长度=' + msg.length);
        // 通知监听者（远程等）；系统内部消息（工具结果/看门狗/重试等）不上报
        if (!isSystemTag(tag)) {
          for (const cb of userMessageSentListeners) {
            try { cb(msg, tag); } catch (_) { /* ignore */ }
          }
        }
        // 纯净模式：任何投递（含框架内部消息）都派发一次，用于显示"框架正在驱动"运行态
        emitMessageDelivered(msg, tag);
        if (typeof afterSent === 'function') afterSent();
        resolve(true);
      }).catch((err) => {
        console.warn('[Cuckoo Code] triggerSend 执行异常:', err && err.message);
        if (typeof afterSent === 'function') afterSent();
        resolve(false);
      });
    }, hesitationMs);
    token.timer = timer;
  });
}

/**
 * 取消当前待发送的消息（清计时器；若为系统内部消息则清空输入框防止残留）
 * @param clearSystemTagOnly 是否清空系统内部消息填入的输入框内容
 * @returns 是否确实取消了待发送
 */
function cancelPendingSend(clearSystemTagOnly = true): boolean {
  if (!pendingSend) return false;
  const t = pendingSend;
  t.cancelled = true;
  if (t.timer) clearTimeout(t.timer);
  // 唤醒正卡在 R（反应）延迟 interruptibleWait 里的等待，立即返回 false
  if (t.wake) { try { t.wake(false); } catch (_) {} t.wake = null; }
  // 释放串行链：取消后必须 resolve，否则 sendChain 永久挂起、后续消息全部卡死
  if (t.resolve) { try { t.resolve(false); } catch (_) {} }
  // 系统内部消息（工具结果/看门狗/重试）：取消时必须清空输入框，防止工具结果残留/回显
  if (clearSystemTagOnly && isSystemTag(t.tag)) {
    setInputContent(t.input, '').catch(() => {});
  }
  pendingSend = null;
  console.log('[Cuckoo Code] 已取消待发送的消息' + (isSystemTag(t.tag) ? '（已清空系统内部内容）' : ''));
  return true;
}

/** 清空底层网页输入框（供停止信号或队列发送调用，防任务结果回显） */
async function clearInputArea(): Promise<boolean> {
  const input = findInputArea();
  if (!input) return false;
  return setInputContent(input, '');
}
/**
 * 将消息填入 DeepSeek 聊天输入框并触发发送（工具结果回传的公共实现）
 * @param fixedDelay 固定延迟（ms）；缺省走拟人化随机延迟。格式纠正等系统提示应传 0 立即发出。
 */
function sendMessageToChat(msg: string, tag?: string, afterSent?: () => void, fixedDelay?: number, contextLen?: number): Promise<boolean> {
  return sendToChat(msg, tag, fixedDelay, afterSent, contextLen);
}
/**
 * 应用 provider 的工具结果格式转换（若提供）。
 * 独立成纯函数：接收文本与 provider，返回转换后文本，便于单测。
 * @returns 转换后文本；provider 未实现或返回空串时保持原文
 */
function applyResultTransform(text: string, provider: any): string {
  if (provider && typeof provider.transformToolResult === 'function') {
    try {
      const t = provider.transformToolResult(text);
      if (typeof t === 'string' && t) return t;
    } catch (err: any) {
      console.warn('[Cuckoo Code] transformToolResult 调用失败:', err && err.message);
    }
  }
  return text;
}
// 回传前缀随机化：真人不会每轮都说同一句话，固定文案本身就是机器特征。
// 注意：前缀本身不能省 —— 真机验证过裸 <path> 结果会让 AI 认不出是工具返回而停止工作。
const SINGLE_PREFIXES = ['跑完了，结果：', '执行结果：', '好了：', '搞定：', '结果出来了：'];
const MULTI_PREFIXES = ['跑完了，结果如下：', '执行完了，结果是这样：', '好了，结果如下：', '搞定，结果如下：', '结果出来了：'];
function pickPrefix(multi: boolean): string {
  const arr = multi ? MULTI_PREFIXES : SINGLE_PREFIXES;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 将 JS 工具脚本执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
async function sendCombinedJsResultsToChat(results: any, onSent?: () => void, contextLen?: number): Promise<boolean> {
  if (!Array.isArray(results) || results.length === 0) return false;

  const MAX_OUTPUT = 15000;
  const sep = String.fromCharCode(10);

  // 前缀不能省：真机验证过「单段直接给 <path> 裸结果」会让 AI 认不出这是工具返回，
  // 直接停止不再继续工作。故保留前缀，但每次随机选，避免几十轮形成稳定句式。
  const multi = results.length > 1;
  let msg = pickPrefix(multi) + sep + sep;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (multi) msg += '第 ' + (i + 1) + ' 段：' + sep;
    if (item && item.result && item.result.success) {
      let out = (item.result.output || '').trim();
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + sep + '...[输出过长已截断]...\n⚠️ 警告：回传内容超出长度上限被系统截断。严禁再次尝试输出全量内容，请立即改用 read 的 offset/limit 分段读取，或在 JS 脚本中使用 slice/filter 提取关键片段后再 log。';
      }
      // 多段必须保留「成功」锚点：失败段有「失败了」兜底，成功段若无标记则结构不对称，
      // AI 得靠输出首字符推断。单段不需要（前缀已表明这是结果）。
      if (multi) msg += '成功' + sep;
      msg += (out || '（没有输出）');
    } else {
      msg += '失败了' + sep + '报错：' + ((item && item.result && item.result.error) || '未知错误') + sep;
      msg += '跑的是这段代码：' + sep + String((item && item.code) || '').slice(0, 300) + sep;
      msg += '代码有问题，请修正后重新输出完整的 ' + BT + BT + BT + 'cuckoo 代码块。';
    }
    msg += sep + sep;
  }

  // provider 可自定义回传格式（某些平台对格式敏感，如触发风控）
  msg = applyResultTransform(msg, getCurrentProvider());

  // 追加（不覆盖）：保留用户已输入的内容，工具结果拼在其后一起发送
  const input = findInputArea();
  if (input) {
    const current = (getInputText(input) || '').trim();
    if (current) {
      msg = current + sep + sep + msg;
      console.log('[Cuckoo Code] 工具结果追加在用户已输入内容之后（保留 ' + current.length + ' 字符）');
    }
  }
  console.log('[Cuckoo Code] 回传 JS 汇总执行结果, 消息长度=' + msg.length + ', 上一条回复长度=' + (contextLen || 0));
  return sendMessageToChat(msg, 'JS汇总', onSent, undefined, contextLen);
}
/**
 * 查找 DeepSeek 的输入框元素
 */
function findInputArea(): any {
  const provider = getCurrentProvider();
  if (provider && typeof provider.findInput === 'function') {
    const el = provider.findInput();
    if (el) return el;
  }

  // 通用兜底：找所有可见 textarea
  const allTextareas = document.querySelectorAll('textarea');
  for (const ta of allTextareas) {
    // 【幽灵发送防御】必须过滤纯净模式(harness)的输入框，否则框架内部消息会串台填入用户的草稿框
    if (ta.id === 'input' || (ta as any).placeholder?.includes('输入消息')) continue;
    if (isInputVisible(ta)) return ta;
  }
  // 再找 contenteditable 或 textbox
  const editables = document.querySelectorAll('div[contenteditable="true"], [role="textbox"]');
  for (const ed of editables) {
    if (ed.id === 'input') continue;
    if (isInputVisible(ed)) return ed;
  }

  return null;
}
/**
 * 检查元素是否可见
 */
function isInputVisible(el: any): boolean {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}
/**
 * 发送初始提示（目录树+systemPrompt）到输入框
 */
async function sendInitialPromptToInput(): Promise<boolean> {
  if (!state.initialPromptContent) {
    state.pendingInitialPrompt = false;
    return false;
  }

  const input = findInputArea();
  if (!input) {
    return false;
  }

  if (!(await setInputContent(input, state.initialPromptContent))) {
    console.log('[Cuckoo Code] 初始提示填充失败');
    return false;
  }

  // 校验：填充后输入框确实有内容（contenteditable 合成粘贴可能被站点拒绝）
  try {
    const filled = getInputText(input);
    if (!filled || filled.trim().length < 10) {
      console.log('[Cuckoo Code] 初始提示填充后输入框为空，判定失败');
      return false;
    }
  } catch (_) { /* ignore */ }

  // 初始提示是框架驱动的系统指令（非"用户回复 AI"），与 insertSnippet / 格式纠正同类：
  // 必须 0ms 立即发出。旧实现走 randomDelay(提示词自身长度) —— 系统提示词数万字符，
  // 按认知模型会算到配置上限（默认 36s），用户看到"填进输入框却半天不发"以为坏了。
  console.log('[Cuckoo Code] 初始提示已填入，立即发送...');
  try {
    await triggerSend(input);
  } finally {
    // 无论 triggerSend 是否抛异常都必须清除标志，否则重试逻辑会卡死
    state.pendingInitialPrompt = false;
  }
  // 纯净模式：系统提示词投递也要有运行态反馈（内容不显示）
  emitMessageDelivered(state.initialPromptContent || '', '系统提示词');

  return true;
}
/** 初始提示发送的最大尝试次数（跨"等输入框"与"等发送成功"共用） */
const INITIAL_PROMPT_MAX_ATTEMPTS = 30;

/**
 * 尝试发送初始提示；失败则重试，直到成功或达上限。
 * @param attempt 已尝试次数（递归时 +1 传递，不重置，避免无限重试）
 */
function trySendInitialPrompt(attempt: number): void {
  const input = findInputArea();
  if (!input) {
    if (attempt >= INITIAL_PROMPT_MAX_ATTEMPTS) {
      state.pendingInitialPrompt = false;
      console.log('[Cuckoo Code] 等待输入框超时，放弃发送初始提示');
      return;
    }
    setTimeout(() => trySendInitialPrompt(attempt + 1), 500);
    return;
  }
  // 找到输入框：尝试发送（sendInitialPromptToInput 内部会校验填充是否成功）
  sendInitialPromptToInput().then((ok) => {
    if (ok) return;
    if (attempt < INITIAL_PROMPT_MAX_ATTEMPTS) {
      console.log('[Cuckoo Code] 初始提示发送失败，重试（第 ' + (attempt + 1) + ' 次）');
      setTimeout(() => trySendInitialPrompt(attempt + 1), 500);
    } else {
      console.log('[Cuckoo Code] 初始提示发送失败，已达上限，放弃');
      state.pendingInitialPrompt = false;
    }
  }).catch(() => {
    if (attempt < INITIAL_PROMPT_MAX_ATTEMPTS) setTimeout(() => trySendInitialPrompt(attempt + 1), 500);
  });
}

/** 等待输入框出现后再发送初始提示（对外入口，从 0 开始） */
function waitForInitialPromptAndSend(): void {
  trySendInitialPrompt(0);
}
/** 读取输入框当前文本 */
function getInputText(input: any): string {
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return input.value || '';
    }
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      return input.innerText || input.textContent || '';
    }
  } catch (_) {}
  return '';
}

/**
 * 在输入框现有内容末尾追加一段文本（不发送），光标移到末尾。
 * 用于快捷提示词/MCP 名等"追加"场景。
 * @param text 要追加的文本
 * @returns 是否成功
 */
async function appendTextToInput(text: string): Promise<boolean> {
  const input = findInputArea();
  if (!input) {
    console.log('[Cuckoo Code] 找不到输入框，无法追加文本');
    return false;
  }
  const current = getInputText(input);
  // 若已有内容且不以空白结尾，补一个空格
  const sep = current && !/\s$/.test(current) ? ' ' : '';
  const next = current + sep + text;
  const ok = await setInputContent(input, next);
  if (ok) {
    moveCaretToEnd(input);
    console.log('[Cuckoo Code] 已追加文本到输入框, 追加长度=' + text.length);
  }
  return ok;
}

/**
 * 把光标移到输入框末尾（填入提示词后，方便用户接着补充）
 */
function moveCaretToEnd(input: any): void {
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const len = input.value ? input.value.length : 0;
      input.setSelectionRange(len, len);
      return;
    }
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false); // 折叠到末尾
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  } catch (err: any) {
    console.error('[Cuckoo Code] 移动光标到末尾失败:', err.message);
  }
}

/**
 * 插入快捷提示词：填入输入框 + 光标移到末尾；autoSend=true 时自动发送。
 * @param content 提示词内容
 * @param autoSend 是否自动发送（默认 false = 只填入）
 * @returns 是否成功填入
 */
async function insertSnippet(content: string, autoSend?: boolean): Promise<boolean> {
  const input = findInputArea();
  if (!input) {
    console.log('[Cuckoo Code] 找不到输入框，无法插入提示词');
    return false;
  }
  // 追加（不覆盖用户已输入的内容）：读现有内容 + 分隔 + 新内容
  const current = getInputText(input);
  const sep = current && !/\s$/.test(current) ? ' ' : '';
  const next = current + sep + content;
  if (!(await setInputContent(input, next))) {
    return false;
  }
  moveCaretToEnd(input);
  if (autoSend) {
    // 快捷提示词是用户手动点按钮触发的：与 harness 手动发送同理，0ms 立即发出。
    // 真人手动操作本身是最强的人类证据，加随机延迟反而制造「每次都落在固定区间」的机器特征。
    triggerSend(input).catch((err: any) => {
      console.warn('[Cuckoo Code] 提示词发送异常:', err && err.message);
    });
    console.log('[Cuckoo Code] 提示词已追加并立即触发发送, 长度=' + content.length);
  } else {
    console.log('[Cuckoo Code] 提示词已追加（未发送）, 长度=' + content.length);
  }
  return true;
}

/**
 * 触发发送消息
 */
async function triggerSend(input: any): Promise<void> {
  const provider = getCurrentProvider();

  // 方法 0: 站点原生发送（若平台有针对特定输入组件的定制发送逻辑）
  if (provider && typeof provider.triggerSend === 'function') {
    let result: any = null;
    try { result = provider.triggerSend(input); } catch (_) { /* 站点实现异常时回退通用逻辑 */ }
    if (result && typeof result.then === 'function') {
      try {
        const ok = await result;
        if (ok) {
          console.log('[Cuckoo Code] 已通过站点原生发送触发');
          return;
        }
      } catch (_) { /* ignore */ }
      await fallbackSend(provider, input);
      return;
    }
    if (result) {
      console.log('[Cuckoo Code] 已通过站点原生发送触发');
      return;
    }
  }

  await fallbackSend(provider, input);
}

/**
 * 通用发送兜底：
 * 优先走主进程物理级原生输入（isTrusted=true），彻底杜绝合成事件触发的反爬虫与风控封号
 */
async function fallbackSend(provider: any, input: any): Promise<void> {
  // 1. 确保输入框聚焦
  if (input && typeof input.focus === 'function') {
    try { input.focus(); } catch (_) {}
  }

  // 2. 原生 Enter 按键（通过主进程 sendInputEvent 派发 C++ 内核事件，isTrusted=true）
  try {
    const api = (window as any).electronAPI;
    if (api && typeof api.sendEnterToChat === 'function') {
      const ok = await api.sendEnterToChat();
      if (ok) {
        console.log('[Cuckoo Code] 已通过原生 Enter 触发发送 (isTrusted=true)');
        return;
      }
    }
  } catch (err: any) {
    console.warn('[Cuckoo Code] 原生 Enter 发送异常，尝试备用发送:', err && err.message);
  }

  // 3. 尝试平台发送按钮（优先原生物理鼠标点击）
  if (provider && typeof provider.findSendButton === 'function') {
    try {
      const btn = provider.findSendButton();
      if (btn) {
        // 优先尝试主进程物理鼠标点击（isTrusted=true）
        try {
          const rect = btn.getBoundingClientRect();
          const api = (window as any).electronAPI;
          if (rect && rect.width > 0 && rect.height > 0 && api && typeof api.simulateMouse === 'function') {
            const cx = Math.round(rect.left + rect.width / 2);
            const cy = Math.round(rect.top + rect.height / 2);
            const ok = await api.simulateMouse('click', cx, cy);
            if (ok) {
              console.log('[Cuckoo Code] 已通过原生物理鼠标点击发送按钮 (isTrusted=true)');
              return;
            }
          }
        } catch (_) {}

        // 若主进程鼠标模拟不可用，降级为 DOM click
        btn.click();
        console.log('[Cuckoo Code] 已通过 DOM click 点击发送按钮 (降级)');
        return;
      }
    } catch (_) {}
  }

  // 4. 兜底合成 Enter 按键序列（最后防线）
  if (input) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
    console.log('[Cuckoo Code] 已通过合成 Enter 触发发送 (兜底)');
  }
}
/**
 * 注册主进程消息监听（initial-prompt）
 * 与原 preload.js 顶层注册时机一致：preload 入口加载时同步调用。
 */
function registerIpcListeners(): void {
// 监听主进程发送的初始提示
ipcRenderer.on('initial-prompt', (_event: any, content: string) => {
  console.log('[' + new Date().toISOString() + '] [Cuckoo Code] 收到 initial-prompt 事件, content长度=' + (content || '').length);
  state.initialPromptContent = content || '';
  state.pendingInitialPrompt = true;
  // 如果当前已有新的空会话输入框，立即发送
  if (state.pendingInitialPrompt && state.initialPromptContent) {
    try {
      const input = findInputArea();
      console.log('[' + new Date().toISOString() + '] [Cuckoo Code] 首次查找输入框结果=' + (input ? '找到' : '未找到'));
      // 统一走"尝试发送 + 失败重试"（找到/未找到都在内部处理）
      waitForInitialPromptAndSend();
    } catch (e: any) {
      console.error('[' + new Date().toISOString() + '] [Cuckoo Code] initial-prompt 处理异常:', e.message);
    }
  }
});
}


export {
  randomDelay,
  planSendTiming,
  setInputContent,
  insertSnippet,
  appendTextToInput,
  sendToChat,
  onUserMessageSent,
  onMessageDelivered,
  isSystemTag,
  sendMessageToChat,
  applyResultTransform,
  sendCombinedJsResultsToChat,
  cancelPendingSend,
  clearInputArea,
  findInputArea,
  getInputText,
  isInputVisible,
  sendInitialPromptToInput,
  waitForInitialPromptAndSend,
  triggerSend,
  registerIpcListeners,
};
