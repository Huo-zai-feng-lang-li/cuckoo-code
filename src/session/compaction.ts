/**
 * 压缩上下文：清 IDB + 刷新，让 DeepSeek 自己写回完整历史
 *
 * 背景（实测）：同会话内 AI 回复后 IDB 不更新；刷新页面才会补齐；
 * 清 IDB 后刷新，DeepSeek 会自动重新拉取完整历史写回（cache_control: REPLACE）。
 *
 * 流程：
 *  段1（当前页 runCompaction）：
 *    发摘要指令 → 等回复 → 清当前会话 IDB 记录 → 存项目目录 → URL 加标记 → 刷新
 *  段2（刷新后同页 checkPendingCompact）：
 *    检测 URL 标记 → 清标记 → 等 hook 的 IDB 写入事件 → 读 IDB
 *    → 取最近 20% 成对 → share/create → 存 pending-init → 跳分享链接
 *  段3（分享页 checkPendingInit）：
 *    现有逻辑：3 秒后自动初始化项目
 *
 * 依赖：
 *  - hook 已缓存真实请求头到 localStorage['cuckoo-ds-headers']
 *  - hook 在 URL 带 cuckoo-compact 时包装 IDBObjectStore.put，写入成功派发
 *    'cuckoo-idb-history-written' 事件
 */
import { sendToChat } from '../overlay/chat-input.js';
import { onInterceptedResponse } from '../bridge/intercept/observer.js';
import { showToast } from '../overlay/panel.js';
import * as retryEngine from '../bridge/loop/retry.js';
import * as watchdog from '../bridge/loop/watchdog.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

const SUMMARY_INSTRUCTION =
  '请把以上对话总结成一份详细的摘要，尽可能完整地保留关键信息、背景上下文、' +
  '已完成的结论和未完成的事项，用中文，一次性输出全部内容，' +
  '不要输出其他解释。\n' +
  '格式要求：第一行单独输出「【标题】xxx」，xxx 为不超过 20 字、概括本次对话主题的中文标题；' +
  '从第二行开始输出摘要正文。';

const COMPACT_URL_FLAG = 'cuckoo-compact';
const COMPACT_DIR_KEY = 'cuckoo-compact-project-dir';
const PENDING_INIT_KEY = 'cuckoo-compact-pending-init';
const IDB_WAIT_TIMEOUT = 20000;
// 压缩摘要：段1 生成 → localStorage 跨刷新/跨页传递 → 段3 注入新会话（实现带前情提要的智能续接）
const COMPACT_SUMMARY_KEY = 'cuckoo-compact-summary';
// 压缩标题：段1 从摘要首行「【标题】xxx」解析 → 段3 设为续接会话标题（方案 B）
const COMPACT_TITLE_KEY = 'cuckoo-compact-title';
/** 注入新会话的摘要长度上限（防 prompt 膨胀） */
const MAX_SUMMARY_LEN = 8000;

// 真截断：URL flag（触发 hook 的 IDB 写入拦截 + 页内检测）与跨刷新 pending 数据 key
const TRUNCATE_URL_FLAG = 'cuckoo-truncate';
const TRUNCATE_PENDING_KEY = 'cuckoo-truncate-pending';

// 窗口组切换：URL flag + 跨刷新 pending reqId（切换需完整 IDB，故与压缩/截断同走"清 IDB + 刷新"）
const SWITCH_URL_FLAG = 'cuckoo-switch-share';
const SWITCH_PENDING_KEY = 'cuckoo-switch-pending';

function logStep(step: string, msg: string): void {
  console.log('[Cuckoo Compact] [' + step + '] ' + msg);
}

/** 解析摘要首行的「【标题】xxx」，返回 { title, body }（无标题时 title 为空） */
function parseSummaryTitle(text: string): { title: string; body: string } {
  const t = String(text || '');
  // 去掉前导空白（含换行），标题应位于有效内容首行
  const trimmed = t.replace(/^[\s]+/, '');
  // 首行是否为「【标题】xxx」；标题内容可为空（此时不把后续正文误当标题）
  const m = trimmed.match(/^【标题】[ \t]*([^\n]*)/);
  if (!m) return { title: '', body: t.trim() };
  const title = m[1].trim().slice(0, 20);
  // 无论标题是否为空，都剥离首行标签，避免污染正文（extraPrompt）
  const body = trimmed.replace(/^【标题】[^\n]*\n?/, '').trim();
  return { title, body };
}

interface MessageItem {
  message_id: number;
  role: string;
  parent_id?: any;
}

/** 等待 AI 回复完成（拦截到完整回复） */
function waitForResponse(timeoutMs: number): Promise<{ text: string; meta: any }> {
  return new Promise((resolve, reject) => {
    let done = false;
    const off = onInterceptedResponse((text: string, meta: any) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve({ text, meta: meta || {} });
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      reject(new Error('等待 AI 回复超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
}

/** 从当前 URL 获取 chat_session_id */
function getSessionIdFromUrl(): string | null {
  const m = String(location.href).match(/\/chat\/s\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** 从 localStorage 读取缓存的真实请求头 */
function getCachedHeaders(): any {
  try {
    const raw = localStorage.getItem('cuckoo-ds-headers');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/** 清掉当前会话在 IDB 的记录 */
function clearSessionFromIdb(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let req: any;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e); return; }
    req.onerror = () => reject(new Error('打开 IndexedDB 失败'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('history-message', 'readwrite');
        const st = tx.objectStore('history-message');
        const d = st.delete(sessionId);
        d.onsuccess = () => { db.close(); resolve(); };
        d.onerror = () => { db.close(); reject(new Error('删除 IDB 记录失败')); };
      } catch (e) { db.close(); reject(e); }
    };
  });
}

/** 等待 hook 派发的 IDB 写入完成事件 */
function waitForIdbWrite(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const handler = () => {
      if (done) return;
      done = true;
      window.removeEventListener('cuckoo-idb-history-written', handler);
      clearTimeout(timer);
      resolve();
    };
    window.addEventListener('cuckoo-idb-history-written', handler);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('cuckoo-idb-history-written', handler);
      reject(new Error('等待 IDB 写入超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
}

/**
 * 从 IndexedDB 读取指定会话的全量消息，按 message_id 升序。
 * 同时取出"当前叶子消息 id"（chat_session.current_message_id），
 * 用于沿 parent_id 回溯主对话链。
 */
function getMessagesFromIndexedDB(sessionId: string): Promise<{ list: MessageItem[]; currentMessageId: number | null }> {
  return new Promise((resolve, reject) => {
    let req: any;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e); return; }
    req.onerror = () => reject(new Error('打开 IndexedDB 失败'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('history-message', 'readonly');
        const store = tx.objectStore('history-message');
        const g = store.get(sessionId);
        g.onsuccess = () => {
          db.close();
          const val = g.result;
          const data = val && val.data;
          const msgs = data && data.chat_messages;
          if (!Array.isArray(msgs)) { reject(new Error('IndexedDB 无该会话消息')); return; }
          const list = msgs
            .filter((m: any) => typeof m.message_id === 'number')
            .map((m: any) => ({ message_id: m.message_id, role: m.role || '', parent_id: m.parent_id }))
            .sort((a: any, b: any) => a.message_id - b.message_id);
          const rawLeaf = data && data.chat_session && data.chat_session.current_message_id;
          const currentMessageId = (typeof rawLeaf === 'number') ? rawLeaf : null;
          resolve({ list, currentMessageId });
        };
        g.onerror = () => { db.close(); reject(new Error('读取消息失败')); };
      } catch (e) { db.close(); reject(e); }
    };
  });
}

/**
 * 沿 parent_id 回溯出「主对话链」，取最近 ratio 比例，保证成对（USER + ASSISTANT），返回降序 id。
 *
 * 为什么不能直接按 message_id 排序取尾部：
 *   DeepSeek 的消息是**树**。重新生成/编辑会产生分支（一个 parent 有多个 child），
 *   message_id 全局递增 → 按 id 排序会把"被丢弃的分支"也混进来，角色序列不再是
 *   USER/ASSISTANT 交替 → share/create 报 MESSAGES_MUST_APPEAR_IN_PAIRS。
 *   必须从「当前叶子」沿 parent_id 回溯，得到真正的主线。
 *
 * @param msgs 全量消息（任意顺序，内部建 map）
 * @param leafId 当前叶子消息 id（chat_session.current_message_id），无则用最大 message_id
 * @param ratio 取最近比例
 */
function pickRecentPairedIds(msgs: MessageItem[], leafId: number | null, ratio: number): number[] {
  if (msgs.length === 0) return [];
  const byId = new Map<number, MessageItem>();
  for (const m of msgs) byId.set(m.message_id, m);

  // 1) 确定叶子：优先 current_message_id，否则用最大 message_id
  let leaf: number | null = (leafId != null && byId.has(leafId)) ? leafId : null;
  if (leaf == null) {
    let maxId: number | null = null;
    for (const m of msgs) if (maxId == null || m.message_id > maxId) maxId = m.message_id;
    leaf = maxId;
  }
  if (leaf == null) return [];

  // 2) 沿 parent_id 回溯主链（叶子 → 根），防环
  const chain: MessageItem[] = [];
  const seen = new Set<number>();
  let cur: number | null = leaf;
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const m: MessageItem = byId.get(cur) as MessageItem;
    chain.push(m);
    cur = (typeof m.parent_id === 'number') ? (m.parent_id as number) : null;
  }
  chain.reverse(); // 根 → 叶子

  // 3) 回溯失败（无 parent_id 数据）→ 回退：按 id 全量排序
  //    C-004：回退分支混入 branch 消息会破坏 user/assistant 严格配对
  //    （share/create 报 MESSAGES_MUST_APPEAR_IN_PAIRS）。回退路径先做
  //    "同角色相邻去重"——合法线性对话角色本就严格交替，去重只删 branch 孤立消息，
  //    不动正常消息；再走 start/end 对齐。
  let ordered: MessageItem[];
  if (chain.length <= 1 && msgs.length > 1) {
    ordered = [];
    for (const m of msgs) {
      const last = ordered[ordered.length - 1];
      if (last && last.role === m.role) continue; // 丢弃 branch 孤立的同角色相邻消息
      ordered.push(m);
    }
  } else {
    ordered = chain;
  }

  // 4) 取最近 ratio，保证成对
  const total = ordered.length;
  let keep = Math.max(2, Math.round(total * ratio));
  let start = Math.max(0, total - keep);
  while (start > 0 && ordered[start].role !== 'USER') start--;
  let end = total;
  while (end > start + 1 && ordered[end - 1].role !== 'ASSISTANT') end--;
  const picked = ordered.slice(start, end);
  return picked.map((m) => m.message_id).sort((a, b) => b - a);
}

/** 调 share/create 创建分享，返回 share_id */
async function createShare(sessionId: string, messageIds: number[], headers: any): Promise<string> {
  const h = Object.assign({}, headers);
  h['content-type'] = 'application/json';
  const resp = await fetch('/api/v0/share/create', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ chat_session_id: sessionId, message_ids: messageIds }),
  });
  const txt = await resp.text();
  console.log('[Cuckoo Compact] [api] share/create HTTP ' + resp.status + ' 响应: ' + txt.slice(0, 600));
  let json: any = null;
  try { json = JSON.parse(txt); } catch (_) {}
  if (!json || json.code !== 0) {
    throw new Error('创建分享失败: ' + (json ? json.msg : txt.slice(0, 200)));
  }
  const shareId = json.data && json.data.biz_data && json.data.biz_data.share_id;
  if (!shareId) throw new Error('响应无 share_id（完整响应见日志）');
  return shareId;
}

/** 段1：当前页 —— 发摘要 → 清 IDB → 刷新 */
async function runCompaction(projectDir?: string): Promise<void> {
  const btn = document.getElementById('cuckoo-btn-compact') as any;
  if (btn) { btn.disabled = true; btn.textContent = '压缩中...'; }
  retryEngine.setCompacting(true);
  watchdog.setSuspended(true);

  try {
    const sessionId = getSessionIdFromUrl();
    if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');
    logStep('api', 'chat_session_id = ' + sessionId);

    // 记下"压缩前的会话ID"（段3 初始化新会话时写入血缘）
    try { localStorage.setItem('cuckoo-compact-parent-session', sessionId); } catch (_) {}
    // 先清旧摘要/旧标题，避免上次压缩失败的残留被本次误用
    try { localStorage.removeItem(COMPACT_SUMMARY_KEY); } catch (_) {}
    try { localStorage.removeItem(COMPACT_TITLE_KEY); } catch (_) {}

    logStep('summary', '发送摘要指令');
    const waitReply = waitForResponse(120000);
    sendToChat(SUMMARY_INSTRUCTION, '压缩-摘要', undefined);
    const { text: summaryText } = await waitReply;
    logStep('summary', '收到摘要回复，长度=' + (summaryText || '').length);
    // 保存摘要（跨刷新 + 跨页传给新会话）。这是"智能续接"的核心：
    // 原实现只取最近 20% 原文，前 80% 关键信息全丢；现在把摘要注入新会话，模型带前情提要。
    // 方案 B：首行「【标题】xxx」解析为续接会话标题（正文剔除标题行，避免污染 extraPrompt）。
    try {
      const parsed = parseSummaryTitle(summaryText || '');
      // C-009：超长摘要按边界感知截断——去掉尾部空白并加省略标记，不再硬切丢语义
      const body = parsed.body || '';
      const clipped = body.length > MAX_SUMMARY_LEN
        ? body.slice(0, MAX_SUMMARY_LEN).replace(/\s+$/, '') + ' …'
        : body;
      if (clipped) localStorage.setItem(COMPACT_SUMMARY_KEY, clipped);
      if (parsed.title) localStorage.setItem(COMPACT_TITLE_KEY, parsed.title);
      else localStorage.removeItem(COMPACT_TITLE_KEY);
    } catch (_) { /* ignore */ }

    // 清当前会话 IDB 记录，触发刷新后 DeepSeek 重新拉取完整历史
    logStep('idb', '清除当前会话 IDB 记录');
    await clearSessionFromIdb(sessionId);

    // 存项目目录（跨页需要）
    try {
      if (projectDir) localStorage.setItem(COMPACT_DIR_KEY, projectDir);
      else localStorage.removeItem(COMPACT_DIR_KEY);
    } catch (_) {}

    // URL 加标记 → 刷新
    const url = new URL(location.href);
    url.searchParams.set(COMPACT_URL_FLAG, '1');
    logStep('reload', '刷新页面以让 DeepSeek 重建 IDB: ' + url.toString());
    showToast('压缩中，正在刷新页面...', 3000);
    location.href = url.toString();
  } catch (err: any) {
    console.error('[Cuckoo Compact] 压缩失败:', err);
    showToast('压缩失败: ' + err.message, 5000);
    retryEngine.setCompacting(false);
    watchdog.setSuspended(false);
    if (btn) { btn.disabled = false; btn.textContent = '压缩'; }
  }
}

/** 段2：刷新后同页 —— 检测 URL 标记，等 IDB 写入，创建分享并跳转 */
async function checkPendingCompact(): Promise<boolean> {
  let flag = '';
  try { flag = new URL(location.href).searchParams.get(COMPACT_URL_FLAG) || ''; } catch (_) {}
  if (!flag) return false;

  // 立即清掉 URL 参数，避免重复触发（URL 天然不持久，关页再开不会误触发）
  try {
    const url = new URL(location.href);
    url.searchParams.delete(COMPACT_URL_FLAG);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    logStep('reload', '已清除 URL 标记');
  } catch (_) {}

  let projectDir: string | null = null;
  try { projectDir = localStorage.getItem(COMPACT_DIR_KEY); } catch (_) {}

  try {
    const sessionId = getSessionIdFromUrl();
    if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');

    logStep('idb', '等待 DeepSeek 重建 IDB（监听写入事件）');
    await waitForIdbWrite(IDB_WAIT_TIMEOUT);
    logStep('idb', '收到 IDB 写入事件');

    const headers = getCachedHeaders();
    if (!headers || !headers['authorization']) {
      throw new Error('未获取到认证请求头（请刷新页面后重试）');
    }

    const { list: allMsgs, currentMessageId } = await getMessagesFromIndexedDB(sessionId);
    if (allMsgs.length === 0) throw new Error('未读取到消息列表');
    const tailIds = pickRecentPairedIds(allMsgs, currentMessageId, 0.2);
    if (tailIds.length === 0) throw new Error('裁剪后无有效消息');
    logStep('api', '全量消息 ' + allMsgs.length + ' 条（叶子=' + (currentMessageId || '?') + '），保留最近 ' + tailIds.length + ' 条（成对）');

    const shareId = await createShare(sessionId, tailIds, headers);
    const link = 'https://chat.deepseek.com/share/' + shareId;
    logStep('api', '分享链接: ' + link);

    showToast('压缩完成，正在打开新会话...', 3000);
    try {
      localStorage.setItem(PENDING_INIT_KEY, String(Date.now()));
      if (projectDir) localStorage.setItem(COMPACT_DIR_KEY, projectDir);
    } catch (_) {}
    location.href = link;
    return true;
  } catch (err: any) {
    console.error('[Cuckoo Compact] 段2失败:', err);
    // 段2 失败：清掉已存的摘要/标题（避免长期占用 localStorage；下次压缩会重新生成）
    try { localStorage.removeItem(COMPACT_SUMMARY_KEY); } catch (_) { /* ignore */ }
    try { localStorage.removeItem(COMPACT_TITLE_KEY); } catch (_) { /* ignore */ }
    showToast('压缩失败: ' + err.message, 5000);
    return false;
  }
}

/** 段3：分享页 —— 检测待初始化标记，自动初始化项目 */
function checkPendingInit(): void {
  let pending = null;
  let projectDir = null;
  try {
    pending = localStorage.getItem(PENDING_INIT_KEY);
    projectDir = localStorage.getItem(COMPACT_DIR_KEY);
  } catch (_) {}
  if (!pending) return;
  try {
    localStorage.removeItem(PENDING_INIT_KEY);
    localStorage.removeItem(COMPACT_DIR_KEY);
  } catch (_) {}
  let parentSessionId = null;
  try { parentSessionId = localStorage.getItem('cuckoo-compact-parent-session'); } catch (_) {}
  // 读取上一段对话的摘要（若有），作为"前情提要"注入新会话，实现智能续接
  let compactSummary = '';
  try { compactSummary = localStorage.getItem(COMPACT_SUMMARY_KEY) || ''; } catch (_) {}
  try { localStorage.removeItem(COMPACT_SUMMARY_KEY); } catch (_) {}
  // 方案 B：读取段1 解析出的续接标题，暂存为新会话标题（等会话 ID 出现时绑定）
  let compactTitle = '';
  try { compactTitle = localStorage.getItem(COMPACT_TITLE_KEY) || ''; } catch (_) {}
  try { localStorage.removeItem(COMPACT_TITLE_KEY); } catch (_) {}
  const extraPrompt = compactSummary
    ? '以下是上一段对话（因上下文接近上限而被压缩）的摘要，请基于它无缝续接，不要重复已完成的工作：\n\n' + compactSummary
    : '';
  console.log('[Cuckoo Compact] 检测到压缩后待初始化，3 秒后执行；项目目录=' + (projectDir || '(无)') + '，压缩前会话=' + (parentSessionId || '(无)') + '，摘要长度=' + compactSummary.length + '，标题=' + (compactTitle || '(无)'));
  // 标题暂存：会话 ID 未出现时先存 pendingTitle，待 initProject 后新会话 ID 出现时绑定（覆盖方案 A 继承的父标题）
  if (compactTitle) {
    try {
      const api: any = (window as any).electronAPI;
      if (api && typeof api.setPendingSessionTitle === 'function') {
        const p = api.setPendingSessionTitle(compactTitle);
        if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
      }
    } catch (_) { /* ignore */ }
  }
  setTimeout(() => {
    try {
      (window as any).electronAPI.initProject(projectDir || null, true, extraPrompt, false, parentSessionId);
    } catch (err) {
      console.error('[Cuckoo Compact] 压缩后初始化失败:', err);
    }
  }, 3000);
}

/**
 * 从全量消息里，沿 parent_id 回溯出主链，截取到 targetWebMsgId 为止（含），返回升序 id。
 *
 * 与 pickRecentPairedIds 的区别：后者是「取最近 ratio」，本函数是「精确截到某条」，
 * 找不到 targetWebMsgId 时返回 null（而不是回退，避免误分享整段会话）。
 *
 * @param msgs 全量消息（任意顺序）
 * @param leafId 当前叶子消息 id；null 时用最大 message_id
 * @param targetWebMsgId 截断终点（该 assistant 的 message_id）
 * @returns 升序 message_id 数组；targetWebMsgId 不在主链上时返回 null
 */
function sliceChainUpTo(msgs: MessageItem[], leafId: number | null, targetWebMsgId: number): number[] | null {
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const byId = new Map<number, MessageItem>();
  for (const m of msgs) byId.set(m.message_id, m);
  if (!byId.has(targetWebMsgId)) return null;

  let leaf: number | null = (leafId != null && byId.has(leafId)) ? leafId : null;
  if (leaf == null) {
    let maxId: number | null = null;
    for (const m of msgs) if (maxId == null || m.message_id > maxId) maxId = m.message_id;
    leaf = maxId;
  }
  if (leaf == null) return null;

  // 沿 parent_id 回溯主链（叶子 → 根），防环
  const chain: MessageItem[] = [];
  const seen = new Set<number>();
  let cur: number | null = leaf;
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const m: MessageItem = byId.get(cur) as MessageItem;
    chain.push(m);
    cur = (typeof m.parent_id === 'number') ? (m.parent_id as number) : null;
  }
  chain.reverse(); // 根 → 叶子

  // 在链上找 targetWebMsgId 的位置，截取到它为止
  const idx = chain.findIndex((m) => m.message_id === targetWebMsgId);
  if (idx < 0) return null;
  const picked = chain.slice(0, idx + 1);
  // 截断点必须是 ASSISTANT（其 parent 是 USER），否则分享链首尾不成对，share/create 会报错
  const last = picked[picked.length - 1];
  if (!last || last.role !== 'ASSISTANT') return null;
  // 与 pickRecentPairedIds 一致：返回降序（share/create API 期望的顺序）
  return picked.map((m) => m.message_id).sort((a, b) => b - a);
}

/**
 * 真截断·段1：清当前会话 IDB → URL 加 cuckoo-truncate flag → 刷新。
 *
 * 为什么必须刷新：与压缩同理——同会话内 AI 回复后 IDB 不更新，只有刷新才会让
 * DeepSeek 重新拉取并写回完整历史。截断要沿 parent_id 精确回溯，必须基于完整 IDB。
 *
 * webMsgId / newText 经 localStorage 跨刷新传递，刷新后由 checkPendingTruncate 消费。
 */
function prepareTruncate(webMsgId: number, newText: string): void {
  const sessionId = getSessionIdFromUrl();
  if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');
  try {
    localStorage.setItem(TRUNCATE_PENDING_KEY, JSON.stringify({ webMsgId: webMsgId, newText: newText || '', ts: Date.now() }));
  } catch (_) { /* ignore */ }
  logStep('truncate', '清 IDB 并刷新以重建完整历史（session=' + sessionId + ', webMsgId=' + webMsgId + '）');
  // 清 IDB 后刷新。clearSessionFromIdb 失败也不阻断——仍刷新，DeepSeek 会重建。
  clearSessionFromIdb(sessionId).catch(() => {}).then(() => {
    const url = new URL(location.href);
    url.searchParams.set(TRUNCATE_URL_FLAG, '1');
    location.href = url.toString();
  });
}

/**
 * 真截断·段2：刷新后同页 —— 检测 URL flag，等 IDB 重建，创建「到 webMsgId 为止」的分享，
 * 回执主进程（由主进程导航 AI 页面到分享页并激活新会话）。
 *
 * 与 checkPendingCompact 同构，只是终点用 sliceChainUpTo(webMsgId) 精确截断。
 * @returns 是否已处理（true = 本次导航属于截断流程）
 */
async function checkPendingTruncate(): Promise<boolean> {
  let flag = '';
  try { flag = new URL(location.href).searchParams.get(TRUNCATE_URL_FLAG) || ''; } catch (_) {}
  if (!flag) return false;

  // 立即清 URL 参数，避免重复触发
  try {
    const url = new URL(location.href);
    url.searchParams.delete(TRUNCATE_URL_FLAG);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    logStep('truncate', '已清除 URL 标记');
  } catch (_) {}

  let pending: any = null;
  try { pending = JSON.parse(localStorage.getItem(TRUNCATE_PENDING_KEY) || 'null'); } catch (_) {}
  if (!pending || typeof pending.webMsgId !== 'number') return false;

  try {
    const sessionId = getSessionIdFromUrl();
    if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');

    logStep('truncate', '等待 DeepSeek 重建 IDB（监听写入事件）');
    await waitForIdbWrite(IDB_WAIT_TIMEOUT);
    logStep('truncate', '收到 IDB 写入事件');

    const headers = getCachedHeaders();
    if (!headers || !headers['authorization']) {
      throw new Error('未获取到认证请求头（请刷新页面后重试）');
    }
    const { list: allMsgs, currentMessageId } = await getMessagesFromIndexedDB(sessionId);
    if (allMsgs.length === 0) throw new Error('未读取到消息列表');
    const ids = sliceChainUpTo(allMsgs, currentMessageId, pending.webMsgId);
    if (!ids || ids.length === 0) {
      throw new Error('截断点不在当前会话主链上（网页可能已变化，请刷新页面后重试）');
    }
    logStep('truncate', '截断分享 ' + ids.length + ' 条消息（到 message_id=' + pending.webMsgId + '）');
    const shareId = await createShare(sessionId, ids, headers);
    const shareUrl = location.origin + '/share/' + shareId;
    try { localStorage.removeItem(TRUNCATE_PENDING_KEY); } catch (_) {}
    // 回执主进程：由它导航 AI 页面到分享页并激活新会话
    try { ipcRenderer.send('cuckoo-truncate-share-ready', { shareUrl: shareUrl, shareId: shareId, newText: pending.newText || '' }); } catch (_) {}
    return true;
  } catch (err: any) {
    console.error('[Cuckoo Compact] 截断段2失败:', err);
    try { localStorage.removeItem(TRUNCATE_PENDING_KEY); } catch (_) {}
    try { ipcRenderer.send('cuckoo-truncate-share-ready', { error: (err && err.message) || '截断失败' }); } catch (_) {}
    return false;
  }
}

/**
 * 窗口组切换·段1：清当前会话 IDB → URL 加 cuckoo-switch-share flag → 刷新。
 *
 * 为什么必须刷新：与压缩/截断同理——同会话内 AI 回复后 IDB 不更新，只有刷新才会让
 * DeepSeek 重新拉取并写回完整历史。切换要把对话**完整**交给另一个窗口，必须基于完整 IDB。
 * （原实现直接读 IDB，常报"IndexedDB 无该会话消息"。）
 *
 * reqId 经 localStorage 跨刷新传递，刷新后由 checkPendingSwitchShare 消费并回执主进程。
 */
function prepareSwitchShare(reqId: string): void {
  const sessionId = getSessionIdFromUrl();
  if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');
  try {
    localStorage.setItem(SWITCH_PENDING_KEY, JSON.stringify({ reqId: reqId, ts: Date.now() }));
  } catch (_) { /* ignore */ }
  logStep('switch', '清 IDB 并刷新以重建完整历史（session=' + sessionId + '）');
  // 清 IDB 后刷新。clearSessionFromIdb 失败也不阻断——仍刷新，DeepSeek 会重建。
  clearSessionFromIdb(sessionId).catch(() => {}).then(() => {
    const url = new URL(location.href);
    url.searchParams.set(SWITCH_URL_FLAG, '1');
    location.href = url.toString();
  });
}

/**
 * 窗口组切换·段2：刷新后同页 —— 检测 URL flag，等 IDB 重建，创建全量分享，回执主进程。
 * 与 checkPendingTruncate 同构，只是取全量（ratio=1.0）。
 * @returns 是否已处理（true = 本次导航属于切换流程）
 */
async function checkPendingSwitchShare(): Promise<boolean> {
  let flag = '';
  try { flag = new URL(location.href).searchParams.get(SWITCH_URL_FLAG) || ''; } catch (_) {}
  if (!flag) return false;

  // 立即清 URL 参数，避免重复触发
  try {
    const url = new URL(location.href);
    url.searchParams.delete(SWITCH_URL_FLAG);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    logStep('switch', '已清除 URL 标记');
  } catch (_) {}

  let pending: any = null;
  try { pending = JSON.parse(localStorage.getItem(SWITCH_PENDING_KEY) || 'null'); } catch (_) {}
  if (!pending || !pending.reqId) return false;

  try {
    const sessionId = getSessionIdFromUrl();
    if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');

    logStep('switch', '等待 DeepSeek 重建 IDB（监听写入事件）');
    await waitForIdbWrite(IDB_WAIT_TIMEOUT);
    logStep('switch', '收到 IDB 写入事件');

    const headers = getCachedHeaders();
    if (!headers || !headers['authorization']) {
      throw new Error('未获取到认证请求头（请刷新页面后重试）');
    }
    const { list: allMsgs, currentMessageId } = await getMessagesFromIndexedDB(sessionId);
    if (allMsgs.length === 0) throw new Error('未读取到消息列表');
    const ids = pickRecentPairedIds(allMsgs, currentMessageId, 1.0);
    if (ids.length === 0) throw new Error('无有效消息可分享');
    logStep('switch', '全量分享 ' + ids.length + ' 条消息（会话 ' + sessionId + '）');
    const shareId = await createShare(sessionId, ids, headers);
    try { localStorage.removeItem(SWITCH_PENDING_KEY); } catch (_) {}
    // 回执主进程（reqId 来自跨刷新的 localStorage）
    try { ipcRenderer.send('cuckoo-switch-share-result', { reqId: pending.reqId, ok: true, shareId: shareId, sessionId: sessionId }); } catch (_) {}
    return true;
  } catch (err: any) {
    console.error('[Cuckoo Compact] 切换分享失败:', err);
    try { localStorage.removeItem(SWITCH_PENDING_KEY); } catch (_) {}
    try { ipcRenderer.send('cuckoo-switch-share-result', { reqId: pending.reqId, ok: false, error: (err && err.message) || '分享失败' }); } catch (_) {}
    return false;
  }
}

export { runCompaction, checkPendingCompact, checkPendingInit, prepareSwitchShare, checkPendingSwitchShare, prepareTruncate, checkPendingTruncate };
// 纯函数导出（测试用）
export { pickRecentPairedIds as _pickRecentPairedIds, sliceChainUpTo as _sliceChainUpTo, parseSummaryTitle as _parseSummaryTitle };
