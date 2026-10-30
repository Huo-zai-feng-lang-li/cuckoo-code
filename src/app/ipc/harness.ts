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
import * as windowState from '../window.js';
import { scanSkills } from '../../skills/index.js';
import { getPluginScanRoots } from '../../plugins/roots.js';
import { registry, jsRunner } from '../../tools/index.js';
import { abortWindowProcesses } from '../../infra/process-tracker.js';

/**
 * 强杀该窗口后台正在跑的工具子进程（bash / grep 等）和 JS 沙箱 worker。
 * 不包含点击网页停止按钮。
 */
function abortWindowWork(ctx: any): void {
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  const winId = ctx.win.id;
  try {
    // 只杀"阻塞当前回复"的前台进程（bash/pwsh/grep）和 JS 沙箱。
    // 绝对不杀：task-manager 里的后台长驻任务（比如 AI 拉起的 dev server），
    // 因为它们有独立的生命周期，用户可能正在浏览器里用，不能被聊天窗口的“停止”误杀。
    abortWindowProcesses(winId);
    if (jsRunner && typeof jsRunner.abortAll === 'function') jsRunner.abortAll(winId);
  } catch (err) {
    console.log('[Cuckoo Harness] abortWindowWork 异常:', err);
  }
}
import { getProvider, getProviderByUrl } from '../../providers/registry.js';
import { resetTodosCache } from './tool.js';
import { cdpAttach } from './cdp-attach.js';
import { initProject } from '../../session/project-context.js';
import { onHarnessReady } from './window-groups.js';
import { readPrefs, writePrefs, type PromptEnhancerConfig } from '../ui-prefs.js';
import { enhancePrompt } from '../prompt-enhancer.js';
import { cancelSubagentsByParent } from '../subagent.js';

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
 *  刷新后的渲染进程经 checkPendingTruncate 完成分享，回执 { shareUrl, shareId, newText } 或 { error }。
 *
 *  重要：快路径（tryFastTruncate）在长历史下可能耗时 60~90 秒（读 IDB + 造分享），
 *  若比 requestTruncateReady 的超时更晚到达，原实现会因 truncatePending 已被清空而**静默丢弃**，
 *  导致分享已成功创建却无人消费 —— 用户看到"截断中…"后无反应，回到原会话。
 *  修复：即使 truncatePending 已空（超时），只要回执里带 shareUrl，也主动完成导航。 */
let truncateLateHandler: ((r: any) => void) | null = null;

function onTruncateShareReady(_event: any, payload: any): void {
  const p = truncatePending;
  truncatePending = null;
  if (p && p.timer) clearTimeout(p.timer);
  if (p) {
    p.resolve(payload || {});
    return;
  }
  // 迟到回执：truncatePending 已空（超时/已完成），但 AI 页面仍回报了分享结果。
  // 交给外面注册的 lateHandler 处理（主进程侧导航到分享页）。
  if (payload && payload.shareUrl && truncateLateHandler) {
    console.log('[Cuckoo Harness] 收到迟到截断回执（主进程已超时），主动导航: ' + payload.shareUrl);
    try { truncateLateHandler(payload); } catch (err: any) {
      console.log('[Cuckoo Harness] 迟到回执处理失败: ' + (err && err.message));
    }
  }
}

/**
 * 请求 AI 页面执行「清 IDB + 刷新重建历史」（段1），并等待刷新后的渲染进程回执 shareUrl（段2）。
 * 超时（含刷新 + 等 IDB 重建 + share 请求）后返回 { error }，绝不滞留。
 */
function requestTruncateReady(wc: any, webMsgId: number, newText: string, timeoutMs = 120000): Promise<any> {
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

async function activateShareSession(wc: any, shareUrl: string, newText: string, fallbackUrl: string, projectDir?: string | null, providerId?: string | null): Promise<void> {
  // 注意：调用方已 await wc.loadURL(shareUrl)，did-finish-load 已过去。
  // 原实现再调 waitForLoad 会因监听器注册晚于事件而永远等 15s 超时 —— 截断慢的主因。
  // 改为轮询：等前端渲染出输入框 → 发消息 → 检查是否变活，总计最多约 6 秒。
  //
  // projectDir：变活后要把当前项目目录绑到**新 sid**。原实现没做 → 新会话
  // 在 handleUrlChange 里 getProjectDirBySessionId(newSid) 返回空 → 资源管理器
  // 显示"未选择"（用户反馈的问题）。
  function bindProjectDirToNewSid(newSid: string): void {
    if (!newSid || !projectDir) return;
    try {
      const ctx = windowState.getContextByWebContents(wc);
      if (!ctx || !ctx.sessionStore) return;
      ctx.sessionStore.saveSessionDirMapping(newSid, projectDir);
      ctx.sessionStore.state.selectedProjectDir = projectDir;
      try {
        if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('shell-project-dir', projectDir);
      } catch (_) { /* ignore */ }
      try { wc.send('project-dir-updated', projectDir); } catch (_) { /* ignore */ }
      console.log('[Cuckoo Harness] 截断变活后已绑定项目目录到新 sid=' + newSid + ' dir=' + projectDir);
    } catch (err: any) {
      console.log('[Cuckoo Harness] 绑定项目目录到新 sid 失败: ' + (err && err.message));
    }
  }
  function extractSid(url: string): string {
    try {
      const m = url.match(/\/a\/chat\/s\/([a-f0-9-]+)/i);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }
  // ⚠️ 只能发一次！原实现每轮（800ms）都发，而分享页克隆成活会话需 2~3 秒，
  // 导致同一文本被发 3~4 次 —— 用户看到导航栏出现多个相同的消息（实测踩过）。
  // 现在：未发送过 + textarea 就绪 → 发一次并标记；之后只轮询 URL 等变活。
  let sent = false;
  // 原实现首轮就 await 800ms（白等），且轮询粒度 800ms 太粗。
  // 改为：首轮立即检查（分享页可能已就绪），之后 300ms 一轮。
  // 总时长上限保持 12 秒（40 × 300ms = 15 × 800ms）。
  const POLL_MS = 300;
  const MAX_ATTEMPTS = 40;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, POLL_MS));
    if (wc.isDestroyed()) return;
    const url = wc.getURL() || '';
    if (/\/a\/chat\/s\//.test(url)) {
      console.log('[Cuckoo Harness] 分享会话已激活: ' + url);
      bindProjectDirToNewSid(extractSid(url));
      return;
    }
    if (sent) continue; // 已发过，只等 URL 变化
    let ready = false;
    try {
      ready = await wc.executeJavaScript('!!document.querySelector("textarea")');
    } catch (_) { /* ignore */ }
    if (!ready) continue;
    try {
      console.log('[Cuckoo Harness] 在分享页发送新消息（仅一次）');
      wc.send('harness-user-message', { text: newText });
      sent = true;
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

  // 强杀该窗口下所有运行中的子代理（含排队中的），否则「停止」只停主对话，
  // 侧边/卡片里的子代理仍会继续跑，用户感知为"没停掉"。
  try {
    if (ctx.win && !ctx.win.isDestroyed()) {
      const n = cancelSubagentsByParent(ctx.win.id);
      if (n > 0) console.log('[Cuckoo Harness] 已取消 ' + n + ' 个子代理');
    }
  } catch (err) {
    console.log('[Cuckoo Harness] 取消子代理异常:', err);
  }

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

    // 注意：定位失败（抛错/返回 null）不代表"已停止"，不能用来判成功。
    // 只有明确定位函数表态 generating === false 才算确认已停。
    const locate = async () => {
      try { return await wc.executeJavaScript(code); } catch (_) { return null; }
    };

    const r = await locate();
    console.log('[Cuckoo Harness] stopGeneration 定位结果: ' + JSON.stringify(r));

    // 守卫：定位函数明确表示「当前没有在生成」→ 不点击（避免误点发送按钮）
    if (r && r.found === false && r.generating === false) {
      return { success: true, reason: 'not-generating', detail: r.reason || '' };
    }

    if (r && r.found && typeof r.x === 'number') {
      // 点击方式说明（真机取证 2026-10-18）：
      //   CDP Input.dispatchMouseEvent 只会让按钮图标变回箭头，但**流不会停**；
      //   页面内合成 PointerEvent 序列才能真触发 DeepSeek 的停止逻辑（实测 8 秒仅 +4 帧）。
      // 因此这里统一用「页面内合成 Pointer 事件」点击，不使用 CDP debugger。
      const clickInPage = async (x: number, y: number): Promise<boolean> => {
        const js = '(function(){' +
          // 优先按标记找，解决纯净模式下页面不可见 elementFromPoint 返回 null 的问题
          'var el=document.querySelector("[data-cuckoo-stop-target]");' +
          'if(!el){el=document.elementFromPoint(' + x + ',' + y + ');}' +
          'if(!el)return false;' +
          'var opts={bubbles:true,cancelable:true,view:window,clientX:' + x + ',clientY:' + y + ',button:0};' +
          'try{el.dispatchEvent(new PointerEvent("pointerdown",opts));}catch(e){}' +
          'try{el.dispatchEvent(new MouseEvent("mousedown",opts));}catch(e){}' +
          'try{el.dispatchEvent(new PointerEvent("pointerup",opts));}catch(e){}' +
          'try{el.dispatchEvent(new MouseEvent("mouseup",opts));}catch(e){}' +
          'try{el.dispatchEvent(new MouseEvent("click",opts));}catch(e){}' +
          'try{if(typeof el.click==="function")el.click();}catch(e){}' +
          'return true;' +
          '})()';
        try { return !!(await wc.executeJavaScript(js)); } catch (_) { return false; }
      };

      // 校验：等 400ms 后重新定位。
      // - 定位函数有 generating 语义（如 DeepSeek getStopFn）：必须明确 generating === false 才算停住；
      //   定位失败（null / 抛错 / generating 为 null）一律视为"未确认"，不据此报成功。
      // - 定位函数无 generating 语义（通用 attachStopFn 回退）：退化为"找不到可点的停止按钮 = 已停"，
      //   与原行为一致，避免把其它平台误判为失败。
      const hasGeneratingSemantics = !!(r && typeof r.generating === 'boolean');
      const verify = async (): Promise<boolean> => {
        await new Promise((res) => setTimeout(res, 400));
        const again = await locate();
        if (!again) return false;
        if (hasGeneratingSemantics) return again.generating === false;
        return !(again.found && typeof again.x === 'number');
      };

      if (await clickInPage(r.x, r.y) && await verify()) {
        return { success: true, method: 'pointer-event' };
      }

      // 重试一次
      console.log('[Cuckoo Harness] 首次点击后仍在生成，重试');
      const again = await locate();
      if (again && again.found && typeof again.x === 'number') {
        if (await clickInPage(again.x, again.y) && await verify()) {
          return { success: true, method: 'pointer-event-retry' };
        }
      }
      return { success: false, reason: 'still-generating' };
    }

    // 定位失败：尝试 Escape 兜底（部分站点可用）
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', key: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape', key: 'Escape' });
    return { success: true, method: 'escape' };
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

  // 自动重试状态（bridge 的 retry 引擎上报）→ 转发给 harness 页面。
  // 纯净模式是独立页面，看不到 AI 页面的倒计时浮层：等待期间需显式置忙并豁免静默判据，
  // 耗尽时需立即收尾（否则界面永久卡在运行中）。
  ipcMain.handle('harness-retry-state', (event: any, payload: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false };
    const hv = (ctx as any).harnessView;
    if (hv && !hv.webContents.isDestroyed()) {
      hv.webContents.send('harness-event', {
        type: 'retry-state',
        state: payload && payload.state,
        delayMs: payload && payload.delayMs,
      });
    }
    return { success: true };
  });

  // 停止生成（IPC 入口）
  ipcMain.handle('harness-stop', async (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false };
    return stopGeneration(ctx);
  });

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

    // 关键：截断会激活出**新 sid**，需要把当前项目目录绑定到新会话。
    // 原实现没做 → 新 sid 出现时 handleUrlChange 里 getProjectDirBySessionId(newSid) 返回空
    // → selectedProjectDir = null → 资源管理器显示"未选择"（用户反馈的问题）。
    //
    // ⚠️ 不能用 state.pendingProjectDir：截断流程中途会**刷新页面重建 IDB**，
    // 刷新后 URL 仍是原会话 → handleUrlChange 会把 pendingProjectDir 消费并绑到旧 sid 上，
    // 等变活成新 sid 时它已空 → 新 sid 照样找不到目录（实测踩过）。
    // 正确做法：记住当前目录（内存），在 activateShareSession 检测到变活后**显式**绑到新 sid。
    let curProjectDir: string | null = null;
    try {
      if (ctx.sessionStore && ctx.sessionStore.state) {
        curProjectDir = ctx.sessionStore.state.selectedProjectDir || null;
      }
    } catch (_) { /* ignore */ }
    // 记录当前会话 id（供失败"返回原会话"）
    let prevSid = '';
    try {
      const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
      if (provider && typeof provider.extractSessionId === 'function') prevSid = provider.extractSessionId(wc.getURL()) || '';
    } catch (_) { /* ignore */ }
    // 注册迟到回执处理器：requestTruncateReady 超时后（长历史下快路径可能 >60s），
    // 若 AI 页面仍回报了 shareUrl，仍要完成导航与激活，不能丢弃。
    truncateLateHandler = async (lateR: any) => {
      try {
        console.log('[Cuckoo Harness] 迟到回执导航到 ' + lateR.shareUrl);
        await wc.loadURL(lateR.shareUrl);
        if (lateR.newText) {
          let fallbackUrl = '';
          try {
            const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
            if (provider && provider.sessionUrlBase && prevSid) fallbackUrl = provider.sessionUrlBase + prevSid;
          } catch (_) { /* ignore */ }
          activateShareSession(wc, lateR.shareUrl, lateR.newText, fallbackUrl, curProjectDir, ctx.providerId).catch((err: any) => {
            console.log('[Cuckoo Harness] 迟到回执激活失败: ' + (err && err.message));
          });
        }
      } catch (err: any) {
        console.log('[Cuckoo Harness] 迟到回执导航失败: ' + (err && err.message));
      } finally {
        truncateLateHandler = null;
      }
    };
    // 段1 + 段2：AI 页面清 IDB + 刷新 → 刷新后渲染进程截断分享 → 回执 shareUrl
    const r = await requestTruncateReady(wc, webMsgId, newText);
    if (!r || !r.shareUrl) {
      // 超时：保留 lateHandler 一段时间（AI 页面可能马上回报结果）。
      // 注意：pendingProjectDir 不在这里清 —— 迟到回执仍可能导航到新会话并需要绑定目录；
      // 5 分钟定时器会兜底清理未消费的 pendingProjectDir。
      setTimeout(() => { truncateLateHandler = null; }, 120000);
      return { success: false, error: (r && r.error) || '截断分享失败', prevSessionId: prevSid };
    }
    truncateLateHandler = null;
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
      activateShareSession(wc, r.shareUrl, newText, fallbackUrl, curProjectDir, ctx.providerId).catch((err: any) => {
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
          // 原实现只用 ctx.providerId 取 provider —— 若该字段未设置（懒加载/异常路径），
          // sid 恒为空，harness 永远加载不到当前会话历史。
          // 兜底：优先 ctx.providerId，取不到则用 getProviderByUrl 从当前 URL 识别。
          let provider = ctx.providerId ? getProvider(ctx.providerId) : null;
          if (!provider) provider = getProviderByUrl(url);
          if (provider && typeof provider.extractSessionId === 'function') sid = provider.extractSessionId(url) || '';
          console.log('[Cuckoo Harness] ready 补发 session-changed: url=' + url + ' sid=' + (sid || '(空)') + ' provider=' + (provider ? provider.id : '(无)'));
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
    // 清理旧的标记
    var olds = doc.querySelectorAll('[data-cuckoo-stop-target]');
    for (var oi = 0; oi < olds.length; oi++) {
      try { olds[oi].removeAttribute('data-cuckoo-stop-target'); } catch (e) {}
    }
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
      // 纯定位：只打标记，点击统一交给主进程的 clickInPage（避免重复点击）
      try { pick.el.setAttribute('data-cuckoo-stop-target', '1'); } catch (e) { /* ignore */ }
      var onTop = null;
      try { var oe = doc.elementFromPoint(cx, cy); onTop = oe ? ((oe.tagName || '') + '.' + String(oe.className || '').slice(0, 50)) : null; } catch (e) { /* ignore */ }
      return { found: true, x: cx, y: cy, onTop: onTop, clickedInPage: false, tag: (pick.el.tagName || '') + '.' + String(pick.el.className || '').slice(0, 40), candidates: diag };
    }
    return { found: false, candidates: diag };
  } catch (e: any) {
    return { found: false, reason: 'error:' + (e && e.message) };
  }
}

export { registerHarnessIpc, prepareNewConversation, pushHarnessState, stopGeneration };


