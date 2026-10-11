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
 * 生成随机等待时间（ms），范围由 state 配置（默认 0.5-1 秒）
 */
function randomDelay(): number {
  const min = typeof state.sendDelayMin === 'number' ? state.sendDelayMin : 500;
  const max = typeof state.sendDelayMax === 'number' ? state.sendDelayMax : 1000;
  if (min >= max) return min;
  return Math.floor(Math.random() * (max - min)) + min;
}
/**
 * 将文本填入输入框（React 兼容：使用原生 value setter）
 * @param input - 输入框元素
 * @param msg - 要填入的文本
 * @returns 是否成功填入
 */
async function setInputContent(input: any, msg: string): Promise<boolean> {
  try {
    if (!input) return false;
    const tag = String(input.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      if (typeof input.focus === 'function') input.focus();
      const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(input, msg);
      } else {
        input.value = msg;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (input.isContentEditable || input.getAttribute?.('contenteditable') === 'true') {
      if (typeof input.focus === 'function') input.focus();
      if (getInputText(input).length > 0) {
        try {
          document.execCommand('selectAll', false, undefined);
          document.execCommand('delete', false, undefined);
        } catch (_) {
          try { input.textContent = ''; } catch (_) {}
        }
      }

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
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[Cuckoo Code] 设置输入框内容失败:', err?.message || err);
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
interface PendingSend { timer: any; input: any; cancelled: boolean; resolve?: (v: boolean) => void; }
let pendingSend: PendingSend | null = null;

// 发送串行链：确保同一时刻只有一条消息处于"填充→等待→发送"流程，
// 避免并发时后一条覆盖输入框、导致前一条内容丢失（实测 Bug：两条并发只发出后者）。
let sendChain: Promise<any> = Promise.resolve();

// 「用户消息已发出」回调（供 bridge 上报飞书等；overlay 不依赖上层，用回调注入）
// 系统内部消息的 tag（不视为"用户消息"，不上报飞书）
const SYSTEM_MSG_TAGS = [
  'JS汇总', '飞书', '看门狗', '重试', '重试(操作频繁)',
  '压缩-摘要', 'MCP信息', '技能与代理清单', '继续',
  'JSON工具调用提示', 'XML工具调用提示', '系统提示词',
];
let onUserMessageSentCb: ((text: string, tag?: string) => void) | null = null;
/** 注册"用户消息已发出"回调（返回取消注册） */
function onUserMessageSent(cb: (text: string, tag?: string) => void): () => void {
  onUserMessageSentCb = cb;
  return () => { if (onUserMessageSentCb === cb) onUserMessageSentCb = null; };
}

// 「消息已投递」回调：所有经 sendToChat 发出的消息都派发（含系统内部消息），
// 供纯净对话模式显示"框架正在驱动 AI 页面"的运行态反馈（内容不显示，只反馈状态）。
let onMessageDeliveredCb: ((info: { text: string; tag: string; isSystem: boolean }) => void) | null = null;
/** 注册"消息已投递"回调（返回取消注册） */
function onMessageDelivered(cb: (info: { text: string; tag: string; isSystem: boolean }) => void): () => void {
  onMessageDeliveredCb = cb;
  return () => { if (onMessageDeliveredCb === cb) onMessageDeliveredCb = null; };
}

/** 是否框架内部消息（不视为"用户消息"，飞书不上报；纯净模式只反馈状态不显示内容） */
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
function sendToChat(msg: string, tag?: string, fixedDelay?: number, afterSent?: () => void): Promise<boolean> {
  const run = sendChain.then(() => doSendToChat(msg, tag, fixedDelay, afterSent));
  // 链上无论成败都继续，避免一次失败卡死后续发送
  sendChain = run.then(() => undefined, () => undefined);
  return run;
}

async function doSendToChat(msg: string, tag?: string, fixedDelay?: number, afterSent?: () => void): Promise<boolean> {
  const input = findInputArea();
  if (!input) {
    console.log('[Cuckoo Code] 找不到输入框，无法发送消息');
    return false;
  }
  const token: PendingSend = { timer: null, input: input, cancelled: false };
  pendingSend = token;
  if (!(await setInputContent(input, msg))) {
    if (pendingSend === token) pendingSend = null;
    return false;
  }
  // 填充期间被取消：不发送（输入框内容保留）
  if (token.cancelled) {
    return false;
  }
  const sendDelay = fixedDelay !== undefined ? fixedDelay : randomDelay();
  console.log('[Cuckoo Code] 消息已填入输入框，等待 ' + sendDelay + 'ms 后发送...');
  return new Promise<boolean>((resolve) => {
    token.resolve = resolve;
    const timer = setTimeout(async function() {
      if (pendingSend === token) pendingSend = null;
      if (token.cancelled) { resolve(false); return; }
      console.log('[Cuckoo Code] 等待结束，开始触发发送');
      const finish = (sent: boolean) => {
        console.log('[Cuckoo Code] 已触发发送, 结果=' + (sent ? '成功' : '失败') + ', ' + (tag || '') + ', 长度=' + msg.length);
        if (!sent) {
          console.log('[Cuckoo Code] 自动发送未确认，保留输入框内容供用户处理');
          // 关键修复：未确认也必须调用 afterSent 解除遮罩，防止全屏死锁
          if (typeof afterSent === 'function') {
            try { afterSent(); } catch (_) {}
          }
          resolve(false);
          return;
        }
        // 通知监听者（飞书同步等）；系统内部消息（工具结果/看门狗/重试等）不上报
        try {
          if (onUserMessageSentCb && !isSystemTag(tag)) onUserMessageSentCb(msg, tag);
        } catch (_) {}
        // 纯净模式：任何投递（含框架内部消息）都派发一次，用于显示"框架正在驱动"运行态
        emitMessageDelivered(msg, tag);
        if (typeof afterSent === 'function') {
          try { afterSent(); } catch (_) {}
        }
        resolve(true);
      };
      const result = triggerSend(input);
      if (result && typeof (result as any).then === 'function') {
        (result as Promise<boolean>).then(finish).catch(() => finish(false));
      } else {
        finish(result === true);
      }
    }, sendDelay);
    token.timer = timer;
  });
}

/**
 * 取消当前待发送的消息（清计时器；输入框内容保留，用户可自行处理）
 * @returns 是否确实取消了待发送
 */
function cancelPendingSend(): boolean {
  if (!pendingSend) return false;
  const t = pendingSend;
  t.cancelled = true;
  if (t.timer) clearTimeout(t.timer);
  // 释放串行链：取消后必须 resolve，否则 sendChain 永久挂起、后续消息全部卡死
  if (t.resolve) { try { t.resolve(false); } catch (_) {} }
  pendingSend = null;
  // 不清空输入框：保留待发内容，用户可自行决定发送或删除
  console.log('[Cuckoo Code] 已取消待发送的消息（输入框内容保留）');
  return true;
}
/**
 * 将消息填入 DeepSeek 聊天输入框并触发发送（工具结果回传的公共实现）
 */
function sendMessageToChat(msg: string, tag?: string, afterSent?: () => void): Promise<boolean> {
  return sendToChat(msg, tag, undefined, afterSent);
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
/**
 * 将 JS 工具脚本执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
async function sendCombinedJsResultsToChat(results: any, onSent?: () => void): Promise<boolean> {
  if (!Array.isArray(results) || results.length === 0) return false;

  const MAX_OUTPUT = 15000;
  const sep = '\n';

  const chunks: string[] = ['【JS 执行结果汇总】(共 ' + results.length + ' 个脚本)' + sep + sep];

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    chunks.push('—— 脚本 ' + (i + 1) + ' ——' + sep);
    if (item && item.result && item.result.success) {
      let out = (item.result.output || '').trim();
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + sep + '...[输出过长已截断]...';
      }
      chunks.push('✅ 成功' + sep + (out || '(脚本执行完成，无输出)'));
    } else {
      chunks.push('❌ 失败' + sep + '错误原因: ' + ((item && item.result && item.result.error) || '未知错误') + sep);
      chunks.push('本次实际执行的代码(前300字符):' + sep + String((item && item.code) || '').slice(0, 300) + sep);
      chunks.push('请修正 JavaScript 代码后重新输出完整的 ' + BT + BT + BT + 'cuckoo 代码块。');
    }
    chunks.push(sep + sep);
  }

  let msg = chunks.join('');

  // provider 可自定义回传格式（某些平台对格式敏感，如触发风控）
  // 若用户误触弹出了搜索模态框，尝试关闭它以免遮挡主界面
  try {
    const searchInput = document.querySelector('input[placeholder*="搜索对话"]') as any;
    if (searchInput) {
      const closeBtn = searchInput.closest('div')?.querySelector('svg, button, [class*="close"]') ||
                       document.querySelector('[role="dialog"] button, .modal button');
      if (closeBtn && typeof (closeBtn as any).click === 'function') {
        (closeBtn as any).click();
      } else {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
    }
  } catch (_) {}

  // 追加（不覆盖）：保留用户已输入的内容，工具结果拼在其后一起发送
  const input = findInputArea();
  if (input) {
    const current = (getInputText(input) || '').trim();
    if (current) {
      msg = current + sep + sep + msg;
      console.log('[Cuckoo Code] 工具结果追加在用户已输入内容之后（保留 ' + current.length + ' 字符）');
    }
  }
  console.log('[Cuckoo Code] 回传 JS 汇总执行结果, 消息长度=' + msg.length);
  // 工具结果回传：走统一发送延迟区间（与其它系统消息一致）
  return sendToChat(msg, 'JS汇总', undefined, onSent);
}
let cachedInputArea: any = null;

function isSearchElement(el: any): boolean {
  if (!el) return false;
  try {
    const ph = String((typeof el.getAttribute === 'function' ? el.getAttribute('placeholder') : el.placeholder) || '').toLowerCase();
    if (ph.includes('搜索') || ph.includes('search')) return true;
    const aria = String((typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : el.ariaLabel) || '').toLowerCase();
    if (aria.includes('搜索') || aria.includes('search')) return true;
    if (typeof el.closest === 'function' && el.closest('[role="dialog"], .modal, [class*="modal"], [class*="search"]')) return true;
  } catch (_) {}
  return false;
}

/**
 * 检查元素是否可见（优先使用原生 checkVisibility 避免强制触发 Layout）
 */
function isInputVisible(el: any): boolean {
  if (!el) return false;
  if (typeof el.isConnected === 'boolean' && !el.isConnected) return false;
  if (typeof el.checkVisibility === 'function') {
    try {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch (_) {}
  }
  try {
    const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : ((el as any).__style || null);
    if (!style) return false;
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  } catch (_) {
    return false;
  }
}

/**
 * 查找 DeepSeek 的输入框元素
 */
function findInputArea(): any {
  // 1. 命中有效缓存：直接 O(1) 返回，零 DOM 树遍历与样式重算开销
  if (cachedInputArea && isInputVisible(cachedInputArea) && !isSearchElement(cachedInputArea)) {
    return cachedInputArea;
  }

  const provider = getCurrentProvider();
  if (provider && typeof provider.findInput === 'function') {
    const el = provider.findInput();
    if (el && !isSearchElement(el)) {
      cachedInputArea = el;
      return el;
    }
  }

  // 通用兜底：找所有可见 textarea
  const allTextareas = document.querySelectorAll('textarea');
  for (let i = 0; i < allTextareas.length; i++) {
    const ta = allTextareas[i];
    if (isInputVisible(ta) && !isSearchElement(ta)) {
      cachedInputArea = ta;
      return ta;
    }
  }
  // 再找 contenteditable 或 textbox
  const editables = document.querySelectorAll('div[contenteditable="true"], [role="textbox"]');
  for (let i = 0; i < editables.length; i++) {
    const editable = editables[i];
    if (isInputVisible(editable) && !isSearchElement(editable)) {
      cachedInputArea = editable;
      return editable;
    }
  }

  cachedInputArea = null;
  return null;
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

  // 初始提示无需延迟：填入后立即发送（低频操作，秒发更自然）
  console.log('[Cuckoo Code] 初始提示已填入，立即发送');
  const finish = (sent: boolean) => {
    console.log('[Cuckoo Code] 初始提示发送结果=' + (sent ? '成功' : '失败'));
    state.pendingInitialPrompt = false;
    if (!sent) return;
    // 纯净模式：系统提示词投递也要有运行态反馈（内容不显示）
    emitMessageDelivered(state.initialPromptContent || '', '系统提示词');
  };
  const result = triggerSend(input);
  if (result && typeof (result as any).then === 'function') {
    (result as Promise<boolean>).then(finish).catch(() => finish(false));
  } else {
    finish(result === true);
  }

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
/** 读取输入框当前文本（优化布局排版开销） */
function getInputText(input: any): string {
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return input.value || '';
    }
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      // 优先读取 textContent：仅读取 DOM 文本树，免除强制同步布局排版（Layout-Free）
      const tc = input.textContent || '';
      if (!tc.trim()) return '';
      return input.innerText || tc;
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
    // 稍等片刻，让输入框内容稳定后再触发发送
    setTimeout(function () { triggerSend(input); }, 300);
    console.log('[Cuckoo Code] 提示词已追加并触发发送, 长度=' + content.length);
  } else {
    console.log('[Cuckoo Code] 提示词已追加（未发送）, 长度=' + content.length);
  }
  return true;
}

/**
 * 触发发送消息
 */
const SEND_BUTTON_RETRY_COUNT = 14;
const SEND_BUTTON_RETRY_MS = 150;
const SEND_CONFIRM_TIMEOUT_MS = 900;

function getElementLabel(el: any): string {
  if (!el) return '';
  return String(el.getAttribute?.('aria-label') || el.textContent || '').trim();
}

function sendStateChanged(input: any, button: any): boolean {
  const label = getElementLabel(button).toLowerCase();
  if (button && (button.disabled || button.getAttribute?.('aria-busy') === 'true')) return true;
  if (/(stop|cancel|停止|取消|生成中|回答中|dismiss)/i.test(label)) return true;
  return !getInputText(input).trim();
}

async function waitForSendConfirmation(input: any, button: any): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SEND_CONFIRM_TIMEOUT_MS) {
    if (sendStateChanged(input, button)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return sendStateChanged(input, button);
}

function findFormSendButton(input: any): any {
  try {
    const form = input?.form || input?.closest?.('form');
    if (!form) return null;
    const button = form.querySelector('button[type="submit"], input[type="submit"]');
    if (button && isInputVisible(button) && !button.disabled) return button;
  } catch (_) {}
  return null;
}

function triggerClickSequence(el: any): void {
  try {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  } catch (_) {
    try { el.click(); } catch (_) {}
  }
}

function isSafeSendButton(button: any, input: any): boolean {
  if (!button) return false;
  try {
    // 严禁误判文件上传控件：input[type=file] 或内部包含 input[type=file] 的容器绝对不能点击！
    if (button.tagName === 'INPUT' && (button.type || '').toLowerCase() === 'file') return false;
    if (typeof button.querySelector === 'function' && button.querySelector('input[type="file"]')) {
      return false;
    }
    if (typeof button.closest === 'function') {
      if (button.closest('aside, nav, [class*="sidebar"], [class*="side-bar"], [class*="nav"], header, [role="dialog"], .modal, [class*="modal"], [class*="search"]')) {
        return false;
      }
    }
    const aria = String((typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : button.ariaLabel) || '').toLowerCase();
    const title = String((typeof button.getAttribute === 'function' ? button.getAttribute('title') : button.title) || '').toLowerCase();
    const className = String(button.className || '').toLowerCase();
    const testId = String((typeof button.getAttribute === 'function' ? button.getAttribute('data-testid') : '') || '').toLowerCase();
    const text = String(button.innerText || button.textContent || '').trim().toLowerCase();

    const forbidden = [
      '搜索', 'search', '侧边栏', 'sidebar', 'menu', '菜单', 'collapse', 'expand',
      '折叠', '展开', '关闭', 'close', '新对话', '新建对话', 'new chat',
      '深度思考', '联网搜索', 'think', 'history', '历史',
      '上传', '附件', '文件', 'upload', 'attach', 'file', 'image', '图片', '语音', 'audio', 'mic', '录音', 'paperclip', 'clip'
    ];
    if (forbidden.some(w => aria.includes(w) || title.includes(w) || className.includes(w) || testId.includes(w) || text.includes(w))) {
      return false;
    }

    if (typeof button.querySelector === 'function') {
      const svg = button.querySelector('svg');
      if (svg) {
        const svgAria = String(svg.getAttribute?.('aria-label') || '').toLowerCase();
        const svgClass = String(svg.getAttribute?.('class') || '').toLowerCase();
        if (forbidden.some(w => svgAria.includes(w) || svgClass.includes(w))) {
          return false;
        }
      }
    }
  } catch (_) {}
  return true;
}

async function clickAndConfirm(button: any, input: any): Promise<boolean> {
  if (!button || button.disabled) return false;
  if (!isSafeSendButton(button, input)) {
    console.warn('[Cuckoo Code] 拒绝点击非发送区域的危险候选按钮:', getElementLabel(button));
    return false;
  }
  console.log('[Cuckoo Code] 发送候选按钮 aria=' + getElementLabel(button) + ', type=' + (button.type || '') + ', disabled=' + !!button.disabled);
  try {
    triggerClickSequence(button);
  } catch (err: any) {
    console.warn('[Cuckoo Code] 点击发送按钮失败:', err?.message || err);
    return false;
  }
  const confirmed = await waitForSendConfirmation(input, button);
  console.log('[Cuckoo Code] 发送提交确认=' + (confirmed ? '成功' : '未确认'));
  return confirmed;
}

async function requestFormSubmit(button: any, input: any): Promise<boolean> {
  try {
    const form = button?.form || button?.closest?.('form');
    if (!form || typeof form.requestSubmit !== 'function') return false;
    form.requestSubmit(button);
    const confirmed = await waitForSendConfirmation(input, button);
    console.log('[Cuckoo Code] 表单 requestSubmit 确认=' + (confirmed ? '成功' : '未确认'));
    return confirmed;
  } catch (err: any) {
    console.warn('[Cuckoo Code] 表单 requestSubmit 失败:', err?.message || err);
    return false;
  }
}

async function sendButtonWithFallback(btn: any, input: any): Promise<boolean> {
  if (await clickAndConfirm(btn, input)) return true;
  const hasForm = !!(btn?.form || input?.form || (typeof btn?.closest === 'function' && btn.closest('form')) || (typeof input?.closest === 'function' && input.closest('form')));
  if (hasForm && await requestFormSubmit(btn, input)) return true;
  if (input) {
    try {
      if (typeof input.focus === 'function') input.focus();
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, isComposing: false };
      input.dispatchEvent(new KeyboardEvent('keydown', opts));
      input.dispatchEvent(new KeyboardEvent('keypress', opts));
      input.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (await waitForSendConfirmation(input, btn)) return true;
    } catch (_) {}
  }
  return false;
}

function triggerSend(input: any): boolean | Promise<boolean> {
  const provider = getCurrentProvider();

  // 方法 0: 站点原生发送（智谱等免疫合成事件的平台，经主进程注入真实级输入）
  if (provider && typeof provider.triggerSend === 'function') {
    let result: any = null;
    try { result = provider.triggerSend(input); } catch (_) { /* 站点实现异常时回退通用逻辑 */ }
    if (result && typeof result.then === 'function') {
      return result.then(function (ok: boolean) {
        if (ok) {
          console.log('[Cuckoo Code] 已通过站点原生发送触发');
          return true;
        }
        return fallbackSend(provider, input);
      }).catch(function () { return fallbackSend(provider, input); });
    }
    if (result) {
      console.log('[Cuckoo Code] 已通过站点原生发送触发');
      return true;
    }
  }

  return fallbackSend(provider, input);
}

/**
 * 通用发送兜底：查找发送按钮点击，或模拟 Enter 按键序列
 */
function fallbackSend(provider: any, input: any): boolean | Promise<boolean> {
  // 方法 1: 调用平台 Provider 查找发送按钮（透传 input，避免 provider 兜底重复扫描输入框）
  const findButton = provider && typeof provider.findSendButton === 'function'
    ? () => provider.findSendButton(input)
    : () => findFormSendButton(input);
  let btn: any = null;
  const retryCount = provider && typeof provider.findSendButton === 'function' ? SEND_BUTTON_RETRY_COUNT : 1;
  btn = findButton();
  if (btn && isSafeSendButton(btn, input)) {
    return sendButtonWithFallback(btn, input);
  }
  if (retryCount > 1) return retrySendButton(findButton, input, retryCount - 1);

  // 站点 provider 未提供按钮时，仍尝试标准 HTML 表单的 submit 按钮。
  if (provider && typeof provider.findSendButton === 'function') {
    const formButton = findFormSendButton(input);
    if (formButton && formButton !== btn && isSafeSendButton(formButton, input)) {
      return sendButtonWithFallback(formButton, input);
    }
  }

  // 方法 2: 在输入框上模拟完整 Enter 按键序列（keydown + keypress + keyup）
  if (input) {
    if (typeof input.focus === 'function') input.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, isComposing: false };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
    // 键盘事件没有统一的 DOM 状态可供确认；事件派发成功即视为已触发。
    console.log('[Cuckoo Code] 已通过 Enter 键触发发送（站点未提供可确认状态）');
    return true;
  }
  console.log('[Cuckoo Code] 未找到可用发送方式');
  return false;
}


async function retrySendButton(findButton: () => any, input: any, remaining: number): Promise<boolean> {
  for (let attempt = 0; attempt < remaining; attempt++) {
    await new Promise(resolve => setTimeout(resolve, SEND_BUTTON_RETRY_MS));
    const btn = findButton();
    if (btn) return sendButtonWithFallback(btn, input);
  }
  return false;
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


function clearInputAreaCache(): void {
  cachedInputArea = null;
}

export {
  randomDelay,
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
  findInputArea,
  clearInputAreaCache,
  isInputVisible,
  isSafeSendButton,
  sendInitialPromptToInput,
  waitForInitialPromptAndSend,
  triggerSend,
  registerIpcListeners,
};
