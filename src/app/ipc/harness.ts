/**
 * 纯净对话模式（Harness）IPC
 *
 * 数据流：
 *   用户输入(harness 页面) → 'harness-send' → 转发给 AI 页面(bridge) 由 sendToChat 发出
 *   AI 回复/工具事件(AI 页面 bridge) → 'harness-event-report' → 转发给 harness 页面显示
 *   切换：'harness-exit' → 隐藏 harness view，露出网页
 *
 * 依赖：仅 window.js（窗口上下文）。与官方 IPC 解耦，独立注册。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as windowState from '../window.js';
import { scanSkills } from '../../skills/index.js';
import { getPluginScanRoots } from '../../plugins/roots.js';
import { registry, jsRunner } from '../../tools/index.js';
import { abortWindowProcesses } from '../../infra/process-tracker.js';
import { stopBySource } from '../../infra/task-manager.js';

/**
 * 强杀该窗口后台正在跑的工具子进程（bash / grep 等）和 JS 沙箱 worker。
 * 不包含点击网页停止按钮。
 */
function abortWindowWork(ctx: any): void {
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  const winId = ctx.win.id;
  try {
    // 1. 杀前台命令工具（bash/pwsh/grep）
    abortWindowProcesses(winId);
    
    // 2. 杀 JS 沙箱
    if (jsRunner && typeof jsRunner.abortAll === 'function') jsRunner.abortAll(winId);
    
    // 3. 停掉 AI 拉起的后台长驻任务（如 dev server）
    stopBySource('ai');
  } catch (err) {
    console.log('[Cuckoo Harness] abortWindowWork 异常:', err);
  }
}
import { getProvider } from '../../providers/registry.js';
import { resetTodosCache } from './tool.js';
import { cdpAttach } from './cdp-attach.js';
import { initProject } from '../../session/project-context.js';
import { onHarnessReady } from './window-groups.js';
import { readPrefs, writePrefs, type PromptEnhancerConfig } from '../ui-prefs.js';
import { enhancePrompt } from '../prompt-enhancer.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/**
 * 注入到 AI 页面执行的上传函数（harness 专用，比官方 attachFile 更健壮）。
 * 先找 input[type=file]，找不到则尝试点击上传按钮再等（很多站点输入框是懒创建的）。
 * 用函数 toString 注入，避免多行字符串转义问题。
 */
function attachFn(doc: any, win: any, b64: any, fileName: any, mimeType: any, timeoutMs: any, waitMs: any) {
  return (async function () {
    try {
      var bin = win.atob(b64);
      var bytes = new win.Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var file = new win.File([bytes], fileName, { type: mimeType });
      function findInput() { return doc.querySelector('input[type=file]'); }
      var input = findInput();
      if (!input) {
        var keys = ['attach', 'upload', 'paperclip', 'file', 'image', '图片', '文件', '上传', '添加'];
        var cands = doc.querySelectorAll('button, [role=button], [class*=attach], [class*=upload], [class*=file], [class*=plus], [class*=add]');
        for (var ci = 0; ci < cands.length; ci++) {
          var b = cands[ci];
          if (!b || b.offsetWidth === 0) continue;
          var sig = String(b.className || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
          var low = sig.toLowerCase();
          for (var ki = 0; ki < keys.length; ki++) {
            if (low.indexOf(keys[ki].toLowerCase()) !== -1) { b.click(); break; }
          }
          input = findInput();
          if (input) break;
        }
        if (!input) {
          var dl = win.Date.now() + 2500;
          while (win.Date.now() < dl && !input) { await new Promise(function (r) { win.setTimeout(r, 120); }); input = findInput(); }
        }
      }
      if (!input) return { success: false, error: '未找到文件上传输入框（已尝试点击上传按钮）' };
      var dt = new win.DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // dispatch 后立即判断：文件已写入 input 即视为提交成功（图片缩略图不含文件名，不能只靠文本检测）
      var submitted = false;
      try { input.dispatchEvent(new win.Event('change', { bubbles: true })); submitted = true; } catch (e) { /* ignore */ }
      var hasFiles = false;
      try { hasFiles = !!(input.files && input.files.length > 0); } catch (e) { /* ignore */ }
      // 站点可能在 change 后清空 input.files，但文件其实已被接收；派发成功即视为提交成功
      if (submitted) return { success: true, fileName: fileName };
      function fileVisible() {
        var node = input;
        for (var d = 0; d < 12 && node; d++) {
          if (node.innerText && node.innerText.indexOf(fileName) !== -1) return true;
          node = node.parentElement;
        }
        var bt = doc.body ? doc.body.innerText : '';
        return bt.indexOf(fileName) !== -1;
      }
      if (submitted && hasFiles) return { success: true, fileName: fileName };
      // 退化检测：等待附件 chip 出现
      await new Promise(function (r) { win.setTimeout(r, waitMs); });
      if (fileVisible()) return { success: true, fileName: fileName };
      var deadline = win.Date.now() + timeoutMs;
      while (win.Date.now() < deadline) {
        await new Promise(function (r) { win.setTimeout(r, 300); });
        if (fileVisible()) return { success: true, fileName: fileName };
      }
      return { success: false, error: '上传超时，未检测到附件出现' };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  })();
}

// 真截断：请求 AI 页面「清 IDB + 刷新」，刷新后由渲染进程完成分享并回执 shareUrl。
// 因中间有整页刷新（reqId 无法跨刷新传递），故用「单飞」pending 而非 reqId map：
// 一次只允许一个截断请求进行（截断本就是单用户串行操作）。
let truncatePending: { resolve: (v: any) => void; timer: any } | null = null;

/** AI 页面回执入口（由 registerHarnessIpc 注册到 ipcMain.on）。
 *  刷新后的渲染进程经 checkPendingTruncate 完成分享，回执 { shareUrl, shareId, newText } 或 { error }。 */
function onTruncateShareReady(_event: any, payload: any): void {
  if (!truncatePending) return;
  const p = truncatePending;
  truncatePending = null;
  if (p.timer) clearTimeout(p.timer);
  p.resolve(payload || {});
}

/**
 * 请求 AI 页面执行「清 IDB + 刷新重建历史」（段1），并等待刷新后的渲染进程回执 shareUrl（段2）。
 * 超时（含刷新 + 等 IDB 重建 + share 请求）后返回 { error }，绝不滞留。
 */
function requestTruncateReady(wc: any, webMsgId: number, newText: string, timeoutMs = 60000): Promise<any> {
  // 防重入：单飞 pending 下并发触发会让后者的回执覆盖前者、且前者定时器误清后者。
  // 截断本就是单用户串行操作，直接拒绝并发请求即可（UI 侧点击后即移除编辑态，实务不可达，此为兜底）。
  if (truncatePending) return Promise.resolve({ error: '已有截断正在进行，请稍候' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (truncatePending) { truncatePending = null; resolve({ error: '截断超时（未收到分享结果）' }); }
    }, timeoutMs);
    truncatePending = { resolve, timer };
    try { wc.send('cuckoo-truncate-prepare', { webMsgId, newText }); }
    catch (err: any) { truncatePending = null; clearTimeout(timer); resolve({ error: err.message }); }
  });
}

/**
 * 分享页激活：等页面加载完成 → 在分享页发送新消息（触发克隆成活会话）。
 * 分享页是静态快照，在其中发消息后 URL 会变为 /a/chat/s/<新id>。
 * 发送可能因 bridge 尚未就绪而失败 → 有限重试。
 */
function waitForLoad(wc: any, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { wc.off('did-finish-load', finish); } catch (_) {} resolve(); };
    try { wc.on('did-finish-load', finish); } catch (_) { finish(); return; }
    setTimeout(finish, timeoutMs);
  });
}

async function activateShareSession(wc: any, shareUrl: string, newText: string, fallbackUrl: string): Promise<void> {
  // 等分享页导航完成（loadURL 已 await，但 WebContentsView 可能还有二次跳转）
  await waitForLoad(wc, 15000);
  // 给分享页前端一点渲染时间，再发消息；最多重试 3 次
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (wc.isDestroyed()) return;
    const url = wc.getURL() || '';
    // 若已变活会话（/a/chat/s/），说明上一条发送已生效，停止
    if (/\/a\/chat\/s\//.test(url)) {
      console.log('[Cuckoo Harness] 分享会话已激活: ' + url);
      return;
    }
    try {
      console.log('[Cuckoo Harness] 在分享页发送新消息（第 ' + (attempt + 1) + ' 次）');
      wc.send('harness-user-message', { text: newText });
    } catch (_) { /* ignore */ }
  }
  // 全部重试后仍未变活 → 兜底导航回原会话（避免用户卡在静态分享页）
  if (fallbackUrl && !wc.isDestroyed()) {
    console.log('[Cuckoo Harness] 分享会话激活失败，回退到原会话: ' + fallbackUrl);
    try { await wc.loadURL(fallbackUrl); } catch (_) { /* ignore */ }
  }
}

/** 该窗口的 harness view（用于状态查询） */
function getHarnessView(sender: any): any {
  const ctx = windowState.getContextByWebContents(sender);
  return ctx ? (ctx as any).harnessView : null;
}

/**
 * 按 sender 找到对应窗口上下文（含 AI view）。
 * 注意：harness view 不在官方 getContextByWebContents 的匹配范围内，故自行遍历上下文。
 */
function findContext(sender: any): any {
  for (const ctx of windowState.getAllContexts()) {
    const c: any = ctx;
    if (c.harnessView && c.harnessView.webContents === sender) return c;
    if (c.view && c.view.webContents === sender) return c;
    if (c.win && c.win.webContents === sender) return c;
  }
  return null;
}

/**
 * 停止指定窗口的生成：先给 bridge 发停止信号（取消延时发送 + 中止工具回传），
 * 再定位并点击网页的"停止"按钮（优先 CDP 真实鼠标事件）。
 * 供 harness-stop IPC 与"窗口组切换"复用。
 */
async function stopGeneration(ctx: any): Promise<any> {
  if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) return { success: false };
  const wc = ctx.view.webContents;

  // 强杀该窗口后台正在跑的工具子进程和 JS 沙箱 worker
  abortWindowWork(ctx);

  try {
    try { wc.send('harness-stop-signal'); } catch (_) { /* ignore */ }
    try { wc.focus(); } catch (_) { /* ignore */ }
    let locateFn = attachStopFn;
    try {
      const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
      if (provider && typeof provider.getStopFn === 'function') {
        const f = provider.getStopFn();
        if (typeof f === 'function') locateFn = f;
      }
    } catch (_) { /* 回退内置定位 */ }
    const code = '(' + locateFn.toString() + ')(document, window)';
    const r = await wc.executeJavaScript(code);
    console.log('[Cuckoo Harness] stopGeneration 定位结果: ' + JSON.stringify(r));
    if (r && r.found && typeof r.x === 'number') {
      let cdpOk = false;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', clickCount: 0 });
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
        cdpOk = true;
      } catch (e: any) { console.log('[Cuckoo Harness] CDP 失败: ' + (e && e.message)); }
      if (!cdpOk) {
        wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      }
      return { success: true, method: cdpOk ? 'cdp' : 'sendInputEvent' };
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', key: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape', key: 'Escape' });
    return { success: false, method: 'escape' };
  } catch (err: any) {
    console.log('[Cuckoo Harness] stopGeneration 异常: ' + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 通知 harness 视图：当前对话已作废，请完整重置。
 *
 * 为什么必须是一个**独立事件**，而不是靠 URL 变化触发的 `session-changed`：
 * "新对话"落在平台首页，URL 里没有会话 id，`session-changed` 拿到的是空串；
 * 而空串既可能是"新会话"的 key、也可能是当前会话的 key ——
 * 复用按 session 存取那套逻辑会命中 harness 侧首行的 `sid === currentSessionId` 早退，
 * 结果**什么都清不掉**（表现就是"新对话"后满屏残留）。
 *
 * 新对话是"丢弃"，切换会话是"存取"，语义不同就必须有不同的事件。
 *
 * 两条入口都要调它：
 *  - harness 页面自己的清空按钮（harness-new-conversation）
 *  - 壳页面侧栏的「新对话」按钮（web-new-conversation）
 */
function notifyHarnessReset(ctx: any): void {
  try {
    const hv = ctx && ctx.harnessView;
    if (!hv || !hv.webContents || hv.webContents.isDestroyed()) return;
    hv.webContents.send('harness-event', { type: 'reset' });
  } catch (_) { /* ignore */ }
}

/** 新对话的公共前置：清主进程侧 todo 缓存 + 让 harness 视图完整重置 */
function prepareNewConversation(ctx: any): void {
  try { resetTodosCache(); } catch (_) { /* ignore */ }
  notifyHarnessReset(ctx);
}

function registerHarnessIpc(): void {
  // 用户在 harness 输入 → 转给 AI 页面（bridge 会调 sendToChat）
  ipcMain.handle('harness-send', (event: any, payload: any) => {
    console.log('[Cuckoo Harness] 收到用户消息，长度=' + ((payload && payload.text) || '').length);
    const text = (payload && payload.text) || '';
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    // 发送新消息前，先强杀上一轮可能仍在后台跑的旧任务（防并行冲突）
    abortWindowWork(ctx);
    // 新用户消息 = 新任务：清空旧计划（否则旧 todoWrite 结果一直挂着）
    try {
      resetTodosCache();
      const hv = (ctx as any).harnessView;
      if (hv && !hv.webContents.isDestroyed()) hv.webContents.send('harness-event', { type: 'plan', todos: [] });
    } catch (_) { /* ignore */ }
    ctx.view.webContents.send('harness-user-message', { text: text });
    return { success: true };
  });

  // AI 页面的 bridge 上报事件 → 转给 harness 页面
  //（bridge 侧不设门控，一律上报；此处没有 harness 视图时自然丢弃）
  ipcMain.handle('harness-event-report', (event: any, payload: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false };
    // 记录窗口忙闲（供窗口组切换跳过忙碌窗口，避免掐断并行任务）
    // 传 isSubagent：window 层分开存储"主窗口生成"与"子代理生成"，供不同消费者使用
    if (payload && payload.type === 'ai-state') {
      try { windowState.setGenerating(ctx.profileId, !!payload.generating, !!ctx.isSubagent); } catch (_) { /* ignore */ }
    }
    // C3：把 AI 事件广播给已加载的 DSH 插件（事件总线）
    try {
      import('../../plugins/cuckoo-plugins/event-bridge.js').then((m: any) => m.dispatchHarnessPayload(payload)).catch(() => {});
    } catch (_) { /* ignore */ }
    const hv = (ctx as any).harnessView;
    if (hv && !hv.webContents.isDestroyed()) {
      hv.webContents.send('harness-event', payload);
    }
    return { success: true };
  });

  // 停止生成（IPC 入口）
  ipcMain.handle('harness-stop', async (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false };
    return stopGeneration(ctx);
  });

  // 列出可用技能与工具
  ipcMain.handle('harness-list-tools', async (event: any) => {
    try {
      const ctx = findContext(event.sender);
      const projectDir = ctx && ctx.sessionStore ? ctx.sessionStore.state.selectedProjectDir : null;
      const skills = scanSkills(projectDir || null, getPluginScanRoots().skillDirs)
        .map((s: any) => ({ name: s.name, description: s.description }));
      const tools = registry.getDescriptions().map((t: any) => ({ name: t.name, description: t.description }));
      return { success: true, skills, tools };
    } catch (err: any) {
      return { success: false, error: err.message, skills: [], tools: [] };
    }
  });

  // 上传附件
  ipcMain.handle('harness-attach', async (event: any, payload: any) => {
    const files = (payload && payload.files) || [];
    console.log('[Cuckoo Harness] harness-attach 调用, files=' + (Array.isArray(files) ? files.length : 'non-array'));
    if (!Array.isArray(files) || files.length === 0) return { success: false, error: 'empty' };
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    const pageWc = ctx.view.webContents;
    const results: any[] = [];
    for (const f of files) {
      console.log('[Cuckoo Harness] 上传文件: ' + f.name + ' b64len=' + ((f.data || '').length));
      // CDP 真实点击优先：合成事件免疫站点（如智谱）走原生文件选择通道
      try {
        const cr = await cdpAttach(ctx as any, { name: f.name, data: f.data, mime: f.mime });
        console.log('[Cuckoo Harness] CDP 上传结果: ' + JSON.stringify(cr));
        if (cr && cr.success) { results.push({ success: true, name: f.name }); continue; }
      } catch (cdpErr: any) {
        console.log('[Cuckoo Harness] CDP 通道异常，转合成事件兜底: ' + (cdpErr && cdpErr.message));
      }
      try {
        const code = '(' + attachFn.toString() + ')(document, window, ' +
          JSON.stringify(f.data || '') + ', ' +
          JSON.stringify(f.name || 'file') + ', ' +
          JSON.stringify(f.mime || 'application/octet-stream') + ', 12000, 500)';
        const r = await pageWc.executeJavaScript(code, true);
        console.log('[Cuckoo Harness] 上传结果: ' + JSON.stringify(r));
        if (r && r.success) results.push({ success: true, name: f.name });
        else results.push({ success: false, name: f.name, error: (r && r.error) || '上传失败' });
      } catch (err: any) {
        console.log('[Cuckoo Harness] 上传异常: ' + err.message);
        results.push({ success: false, name: f.name, error: err.message });
      }
    }
    const ok = results.filter((x) => x.success).length;
    console.log('[Cuckoo Harness] harness-attach 完成, ok=' + ok + '/' + files.length);
    return { success: ok > 0, uploaded: ok, total: files.length, results };
  });

  // 重载 harness 页面（加载最新 HTML，无需重启应用）
  ipcMain.handle('harness-reload', (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !(ctx as any).harnessView || (ctx as any).harnessView.webContents.isDestroyed()) {
      return { success: false };
    }
    try {
      (ctx as any).harnessView.webContents.reloadIgnoringCache();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 新对话：在 AI 网页中真正开一个新会话（导航到平台首页）
  ipcMain.handle('harness-new-conversation', async (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) return { success: false };
    try {
      const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
      const url = provider && provider.homeUrl ? provider.homeUrl : null;
      if (!url) return { success: false, error: 'no-home-url' };
      console.log('[Cuckoo Harness] 新对话 → 导航到 ' + url);
      // 清主进程 todo 缓存 + 让 harness 视图完整重置（后者是"残留"的根治点）
      prepareNewConversation(ctx);
      ctx.view.webContents.loadURL(url).catch((err: any) => {
        console.log('[Cuckoo Harness] loadURL 失败:', err && err.message);
      });
      return { success: true, url: url };
    } catch (err: any) {
      console.log('[Cuckoo Harness] 新对话异常: ' + err.message);
      return { success: false, error: err.message };
    }
  });

  // 真截断：从指定网页消息处开新会话，并在其中发送新消息。
  // 流程：请求 AI 页面清 IDB + 刷新（重建完整历史）→ 刷新后渲染进程精确截断并回执 shareUrl
  //      → 本进程导航到分享页 → 在其中发新消息把静态快照激活成活会话。
  ipcMain.handle('harness-truncate', async (event: any, payload: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    const webMsgId = payload && payload.webMsgId;
    if (typeof webMsgId !== 'number') return { success: false, error: '缺少有效的 webMsgId' };
    const wc = ctx.view.webContents;
    const newText = (payload && payload.newText) || '';
    console.log('[Cuckoo Harness] 真截断请求 webMsgId=' + webMsgId);
    // 记录当前会话 id（供失败"返回原会话"）
    let prevSid = '';
    try {
      const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
      if (provider && typeof provider.extractSessionId === 'function') prevSid = provider.extractSessionId(wc.getURL()) || '';
    } catch (_) { /* ignore */ }
    // 段1 + 段2：AI 页面清 IDB + 刷新 → 刷新后渲染进程截断分享 → 回执 shareUrl
    const r = await requestTruncateReady(wc, webMsgId, newText);
    if (!r || !r.shareUrl) {
      return { success: false, error: (r && r.error) || '截断分享失败', prevSessionId: prevSid };
    }
    // 导航 AI 页面到分享页（静态快照），加载完后再发新消息触发"变活会话"
    try {
      console.log('[Cuckoo Harness] 截断成功，导航到 ' + r.shareUrl);
      await wc.loadURL(r.shareUrl);
    } catch (err: any) {
      return { success: false, error: '导航新会话失败: ' + err.message, shareUrl: r.shareUrl, prevSessionId: prevSid };
    }
    // 分享页是静态快照；在其中发送一条消息才会克隆成活会话（URL 变为 /a/chat/s/xxx）。
    // 不能固定延迟——改为轮询：等页面就绪（did-finish-load）后再发，发送失败可重试。
    if (newText) {
      // 回退 URL：原会话（供分享会话激活失败时退回）
      let fallbackUrl = '';
      try {
        const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
        if (provider && provider.sessionUrlBase && prevSid) fallbackUrl = provider.sessionUrlBase + prevSid;
      } catch (_) { /* ignore */ }
      activateShareSession(wc, r.shareUrl, newText, fallbackUrl).catch((err: any) => {
        console.log('[Cuckoo Harness] 激活分享会话失败: ' + (err && err.message));
      });
    }
    return { success: true, shareUrl: r.shareUrl, shareId: r.shareId, prevSessionId: prevSid };
  });

  // 真截断：AI 页面（刷新后）回执分享结果
  ipcMain.on('cuckoo-truncate-share-ready', onTruncateShareReady);

  // 退出纯净模式，返回网页模式
  ipcMain.handle('harness-exit', (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.win) return { success: false };
    try { (ctx.win as any).__ckToggleHarness?.(false); } catch (_) {}
    return { success: true };
  });

  // harness 忙状态（生成中）→ 通知壳页面禁用对话切换
  ipcMain.on('harness-set-busy', (event: any, payload: any) => {
    const busy = !!(payload && payload.busy);
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
    (ctx.win as any).__ckHarnessBusy = busy;
    try { ctx.win.webContents.send('shell-harness-busy', { busy: busy }); } catch (_) { /* ignore */ }
  });

  // 查询当前状态（首页且未选项目目录 → 需初始化）
  ipcMain.handle('harness-get-state', async (event: any) => {
    const ctx = findContext(event.sender);
    return computeHarnessState(ctx);
  });

  // 初始化项目（复用官方 init-project 逻辑：弹目录选择框）
  ipcMain.handle('harness-init-project', async (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false, error: 'no-context' };
    try {
      const result = await initProject(false, ctx, null, false, '', false);
      // 初始化后推最新状态（按钮消失 / 输入框恢复）
      pushHarnessState(ctx);
      return result;
    } catch (err: any) {
      console.log('[Cuckoo Harness] 初始化项目失败: ' + err.message);
      return { success: false, error: err.message };
    }
  });

  // harness 页面就绪
  ipcMain.on('harness-ready', (event: any) => {
    console.log('[Cuckoo Harness] 页面已就绪');
    try {
      const ctx = findContext(event.sender);
      const winId = ctx && ctx.win ? ctx.win.id : null;
      // 补发当前会话：页面加载完才注册监听器，view 导航时的 session-changed 可能已错过。
      // 窗口组切换的导入状态依赖它确定 sid 才能应用（否则永远卡在 pending）。
      try {
        if (ctx && ctx.view && !ctx.view.webContents.isDestroyed()) {
          const url = ctx.view.webContents.getURL();
          let sid = '';
          const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
          if (provider && typeof provider.extractSessionId === 'function') sid = provider.extractSessionId(url) || '';
          event.sender.send('harness-event', { type: 'session-changed', sessionId: sid });
        }
      } catch (_) { /* ignore */ }
      // 页面就绪 → 若有暂存状态则推送
      if (winId != null) onHarnessReady(winId);
    } catch (_) { /* ignore */ }
  });

  // ========== 提示词增强（独立 API 旁路调用，不占对话轮次）==========

  // 增强：读当前草稿 + 最近 N 轮历史 + 项目技术栈 → 调 API → 回填
  // 单飞：同一时刻只允许一个在途增强（增强本就是单用户串行操作），可被"停止增强"中止
  let activeEnhanceAbort: AbortController | null = null;
  ipcMain.handle('harness-enhance-prompt', async (event: any, payload: any) => {
    const text = (payload && payload.text) || '';
    if (!text.trim()) return { success: false, error: '输入为空' };
    const ctx = findContext(event.sender);
    const projectDir = ctx && ctx.sessionStore ? ctx.sessionStore.state.selectedProjectDir : null;
    const history = Array.isArray(payload && payload.history) ? payload.history : [];
    // 已有在途：拒绝并发（前端也有 enhanceInFlight 挡，此为兜底）
    if (activeEnhanceAbort) return { success: false, error: '已有增强在进行中' };
    const ac = new AbortController();
    activeEnhanceAbort = ac;
    try {
      const r = await enhancePrompt({ text, history, projectDir, signal: ac.signal });
      return r;
    } catch (err: any) {
      return { success: false, error: (err && err.message) || String(err) };
    } finally {
      if (activeEnhanceAbort === ac) activeEnhanceAbort = null;
    }
  });

  // 停止增强：abort 在途 fetch
  ipcMain.handle('harness-cancel-enhance', async () => {
    if (activeEnhanceAbort) { try { activeEnhanceAbort.abort(); } catch (_) { /* ignore */ } return { success: true }; }
    return { success: false, error: 'no-active-enhance' };
  });

  // 列出可用的增强背景图（src/ui/enhance-images/*.jpg）
  ipcMain.handle('harness-list-enhance-images', async () => {
    try {
      const { resolveSrc } = await import('../../infra/paths.js');
      const dir = resolveSrc('ui/enhance-images');
      const fs2 = await import('node:fs');
      if (!fs2.existsSync(dir)) return { success: true, images: [] };
      const files = fs2.readdirSync(dir).filter((f: string) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
      return { success: true, images: files };
    } catch (err: any) {
      return { success: false, error: (err && err.message) || String(err), images: [] };
    }
  });

  // 读增强配置（不回传 apiKey 明文全量？—— 本地应用，回传以便设置页回显）
  ipcMain.handle('harness-get-enhancer-config', async () => {
    try {
      return { success: true, config: readPrefs().promptEnhancer };
    } catch (err: any) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });

  // 存增强配置（部分字段覆盖）→ 广播给所有窗口，全局即时生效（无需保存按钮）
  ipcMain.handle('harness-set-enhancer-config', async (_event: any, payload: any) => {
    try {
      const patch: Partial<PromptEnhancerConfig> = (payload && payload.config) || {};
      const next = writePrefs({ promptEnhancer: patch as any }).promptEnhancer;
      for (const ctx of windowState.getAllContexts()) {
        try {
          const hv = (ctx as any).harnessView;
          if (hv && hv.webContents && !hv.webContents.isDestroyed()) {
            hv.webContents.send('harness-enhancer-config', next);
          }
        } catch (_) { /* ignore */ }
      }
      return { success: true, config: next };
    } catch (err: any) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });
}

/**
 * 计算 harness 页面所需状态：
 *   needInit = 当前是平台首页（新对话）且未选择项目目录
 */
function computeHarnessState(ctx: any): any {
  if (!ctx) return { success: false, needInit: false, isHome: false, hasProjectDir: false };
  let isHome = false;
  try {
    const url = ctx.view && ctx.view.webContents && !ctx.view.webContents.isDestroyed()
      ? ctx.view.webContents.getURL() : '';
    const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
    isHome = !!(provider && provider.homeUrlPattern && url && provider.homeUrlPattern.test(url));
  } catch (_) { /* ignore */ }
  const dir = (ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.selectedProjectDir) || null;
  return { success: true, isHome, hasProjectDir: !!dir, needInit: isHome && !dir };
}

/** 推送状态给 harness 页面（若已创建） */
function pushHarnessState(ctx: any): void {
  try {
    const hv = ctx && ctx.harnessView;
    if (!hv || hv.webContents.isDestroyed()) return;
    hv.webContents.send('harness-state', computeHarnessState(ctx));
  } catch (_) { /* ignore */ }
}

/**
 * 停止生成：定位 AI 页面的"停止"按钮，返回其视口坐标 { found, x, y, tag, candidates }。
 * 实际点击由主进程 sendInputEvent 完成（真实鼠标事件，React 站点才响应合成事件）。
 */
function attachStopFn(doc: any, win: any) {
  try {
    var vh = win.innerHeight || 800;
    var vw = win.innerWidth || 1200;
    var kw = /(停止|停止生成|stop|cancel|abort|结束|中断)/i;
    var cands = doc.querySelectorAll('button, [role="button"], [class*="stop"], [class*="abort"]');
    var scored = [];
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!el) continue;
      // 排除 Cuckoo 自己的覆盖层 UI（overlay 注入在 AI 页面内，勿误点自己的按钮）
      try {
        if (el.closest && (el.closest('#cuckoo-overlay') || el.closest('.cuckoo-overlay') || el.closest('[class*="cuckoo-"]'))) continue;
      } catch (e) { /* ignore */ }
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      if (rect.left < 0 || rect.top < 0 || rect.left > vw || rect.top > vh) continue;
      var isBtn = (el.tagName === 'BUTTON');
      var cls = (typeof el.className === 'string') ? el.className : '';
      // 排除 cuckoo 类名
      if (/cuckoo/i.test(cls)) continue;
      var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      var title = (el.getAttribute && el.getAttribute('title')) || '';
      var txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      var sig = cls + ' ' + aria + ' ' + title + ' ' + txt;
      var lower = sig.toLowerCase();
      var tokens = cls.split(/\s+/);
      var score = 0;
      // 显式"停止"关键词：最高优先
      if (/stop|abort|cancel|停止|中止|中断/.test(lower)) score += 100;
      if (kw.test(sig)) score += 30;
      // DeepSeek 设计系统：主操作按钮（发送/停止切换）= ds-button--primary + ds-button--filled
      if (tokens.indexOf('ds-button--primary') >= 0) score += 40;
      if (tokens.indexOf('ds-button--filled') >= 0) score += 20;
      // 停止图标通常是方块 rect（svg 内 rect），发送图标是箭头 path
      var hasRect = false;
      try { hasRect = !!(el.querySelector && el.querySelector('svg rect')); } catch (e) { /* ignore */ }
      if (hasRect) score += 10;
      // 位于右下角（输入区发送/停止按钮所在）
      if (rect.top > vh * 0.7) score += 15;
      if (rect.left > vw * 0.55) score += 15;
      if (isBtn) score += 5;
      if (score > 0) scored.push({ el: el, score: score, sig: sig.slice(0, 80), isBtn: isBtn, hasRect: hasRect, rect: rect });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    var diag = scored.slice(0, 6).map(function (s) { return s.score + ':' + s.sig; });
    // 诊断补充：视口下方所有可见按钮（前 12），便于定位 DeepSeek 真实停止按钮
    try {
      var allBtns = [];
      var b2 = doc.querySelectorAll('button, [role="button"], [class*="stop"], [class*="btn"]');
      for (var bi = 0; bi < b2.length && allBtns.length < 12; bi++) {
        var be = b2[bi];
        if (!be) continue;
        if (be.closest && (be.closest('#cuckoo-overlay') || be.closest('.cuckoo-overlay') || be.closest('[class*="cuckoo-"]'))) continue;
        var bc = (typeof be.className === 'string') ? be.className : '';
        if (/cuckoo/i.test(bc)) continue;
        var br = be.getBoundingClientRect ? be.getBoundingClientRect() : null;
        if (!br || br.width === 0 || br.height === 0) continue;
        if (br.top < vh * 0.5) continue;
        allBtns.push('(' + Math.round(br.left) + ',' + Math.round(br.top) + ') ' + (be.tagName || '') + '.' + String(bc).slice(0, 50));
      }
      diag.push('--- 下方按钮 ---');
      diag = diag.concat(allBtns);
    } catch (e) { /* ignore */ }
    // 直接选得分最高者
    var pick = scored.length > 0 ? scored[0] : null;
    if (pick) {
      var cx = Math.round(pick.rect.left + pick.rect.width / 2);
      var cy = Math.round(pick.rect.top + pick.rect.height / 2);
      // 页面内派发完整事件序列 + 原生 click（命中正确元素后通常有效）
      var clickedInPage = false;
      try {
        var t = pick.el;
        var opts = { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, button: 0 };
        try { t.dispatchEvent(new win.PointerEvent('pointerdown', opts)); } catch (e) {}
        t.dispatchEvent(new win.MouseEvent('mousedown', opts));
        try { t.dispatchEvent(new win.PointerEvent('pointerup', opts)); } catch (e) {}
        t.dispatchEvent(new win.MouseEvent('mouseup', opts));
        t.dispatchEvent(new win.MouseEvent('click', opts));
        try { if (typeof t.click === 'function') t.click(); } catch (e) {}
        clickedInPage = true;
      } catch (e) { /* ignore */ }
      var onTop = null;
      try { var oe = doc.elementFromPoint(cx, cy); onTop = oe ? ((oe.tagName || '') + '.' + String(oe.className || '').slice(0, 50)) : null; } catch (e) { /* ignore */ }
      console.log('[zhipu?][stopDiag] onTop=' + onTop + ' tag=' + ((pick.el.tagName || '') + '.' + String(pick.el.className || '').slice(0, 40)));
      return { found: true, x: cx, y: cy, onTop: onTop, clickedInPage: clickedInPage, tag: (pick.el.tagName || '') + '.' + String(pick.el.className || '').slice(0, 40), candidates: diag };
    }
    return { found: false, candidates: diag };
  } catch (e: any) {
    return { found: false, reason: 'error:' + (e && e.message) };
  }
}

export { registerHarnessIpc, prepareNewConversation, pushHarnessState, stopGeneration };


