/**
 * Cuckoo Code 主进程入口（多窗口多 profile 版）
 * 由项目根目录 main.js 薄壳加载。
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as windowState from './window.js';
import * as profileManager from './profile.js';
import { createSessionStore } from '../session/store.js';
import { getProvider } from '../providers/registry.js';
import * as updater from '../updater/index.js';
import * as mcpConfig from '../mcp/config.js';
import * as mcpClient from '../mcp/client.js';
import { resolveAsset, resolveSrc } from '../infra/paths.js';
import { applyHarnessZoom } from './harness-zoom.js';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, WebContentsView, Menu, dialog, screen, nativeTheme, ipcMain: ipcMainForProfile, Notification } = require('electron');

// ========== 持久化会话配置 ==========
const SESSION_DIR = process.env.CUCKOO_SESSION_DIR || 'cuckoo-ai-pro-session';
const USER_DATA_DIR = path.join(app.getPath('appData'), SESSION_DIR);
// app.setPath('userData', ...) 要求目标目录必须已存在，否则会抛错导致启动闪退。
// 用户首次运行或手动删除该目录时，此处负责兜底创建。
try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
} catch (err: any) {
  console.error('[Cuckoo Code] 创建 userData 目录失败:', err.message);
}
app.setPath('userData', USER_DATA_DIR);
console.log('[Cuckoo Code] Session 数据目录:', app.getPath('userData'));

// 渲染进程日志输出目录（仅开发环境持久化；打包版不写日志文件）
const RENDERER_LOG_DIR = app.isPackaged
  ? null
  : path.join(app.getPath('userData'), 'wyp', 'log');
if (RENDERER_LOG_DIR) {
  fs.mkdirSync(RENDERER_LOG_DIR, { recursive: true });
  // 开发环境每次启动清空平台日志，避免无限累积（与 start.js 清空 electron.log 一致）
  try {
    for (const f of fs.readdirSync(RENDERER_LOG_DIR)) {
      if (f.endsWith('.log')) fs.writeFileSync(path.join(RENDERER_LOG_DIR, f), '', 'utf-8');
    }
  } catch (err: any) {
    console.warn('[Cuckoo Code] 清空平台日志失败:', err.message);
  }
}

import { registerIpcHandlers } from './ipc/index.js';
import * as taskManager from '../infra/task-manager.js';
import { buildChromeUserAgent, buildClientHintsHeaders } from '../infra/user-agent.js';
import { initFeishu } from './ipc/feishu.js';
import { injectSubagentDeps, runAgent as runAgentImpl, runGatewayQuery as runGatewayQueryImpl } from './subagent.js';
import { injectAgentRunner, injectSubagentChecker } from '../tools/impl/run-agent.js';
import { injectGoalDonePusher } from '../tools/impl/goal-done.js';
import { isSubagentWindow, pushGoalDone } from './goal.js';
import { injectSessionTitleSetter } from '../tools/impl/name-conversation.js';
import { injectMemoryStore } from '../tools/impl/remember.js';
import { injectSnapshotStore } from '../tools/impl/snapshot.js';
import { addMemory, removeMemory, listMemories } from '../infra/memories.js';
import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshots.js';
import { pushUrlState } from './ipc/shell.js';
import { pushHarnessState, stopGeneration } from './ipc/harness.js';
import { injectWindowGroupDeps, requestShareFromWindow, requestHarnessExport, stageHarnessImport } from './ipc/window-groups.js';
import { seedDefaultRules } from '../rules/index.js';
import { initProject } from '../session/project-context.js';
import * as windowGroups from './window-groups.js';

// 退出前需要 flush 的 sessions
const sessionsToFlush = new Set<any>();

async function flushAllSessions() {
  const promises = [];
  for (const ses of sessionsToFlush) {
    promises.push(ses.flushStorageData().catch((err: any) => {
      console.error('[Cuckoo Code] 刷新 session 失败:', err.message);
    }));
  }
  await Promise.all(promises);
  console.log('[Cuckoo Code] 全部 session 数据已刷新到磁盘');
}

/**
 * 把窗口尺寸/位置夹取到"当前显示器工作区"内。
 * 防止恢复的旧尺寸超出屏幕（换小屏/改分辨率）→ 底部被裁切（状态栏看不见）。
 * @param {{x:number,y:number,width:number,height:number}} b 期望的 bounds
 * @returns 夹取后的 bounds（失败时原样返回）
 */
function clampBounds(b: any) {
  try {
    const display = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height });
    const wa = display.workArea; // { x, y, width, height }
    const width = Math.min(b.width, wa.width);
    const height = Math.min(b.height, wa.height);
    const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width));
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height));
    return { x, y, width, height };
  } catch (_) {
    return b;
  }
}

/**
 * 创建窗口（绑定指定 profile）
 * @param {object|null} profile profile 对象，null 则使用默认 profile
 */
function createWindow(profile: any) {
  const profileData = profile || profileManager.getDefaultProfile();
  const provider = getProvider(profileData.providerId) || null;
  const storeDir = app.getPath('userData');
  const sessionStore = createSessionStore(profileData.id, storeDir, windowState);
  const hasExplicitProfile = !!profile;
  // providerId 已确定 → 直接打开；未确定 → 显示平台选择页
  const providerChosen = !!profileData.providerId;

  // 窗口大小/位置：优先用该 profile 上次记录；无记录则用默认 + 级联偏移（避免多窗口完全重叠）
  // 记录值可能超出"当前屏幕工作区"（换屏幕/分辨率变小时），导致底部（状态栏）被裁切。
  // 故恢复前夹取到当前显示器工作区内，保证整个窗口（含底部状态栏）可见。
  const savedBounds = profileData.bounds;
  const winCount = windowState.getAllWindows().length;
  const defaultBounds = savedBounds
    ? clampBounds({ x: savedBounds.x, y: savedBounds.y, width: savedBounds.width, height: savedBounds.height })
    : { x: undefined, y: undefined, width: 1280, height: 900 };
  const cascadeOffset = savedBounds ? 0 : winCount * 30;

  // 壳窗口：webContents 承载地址栏（src/ui/shell.html），AI 页面放入下方 WebContentsView
  const isMac = process.platform === 'darwin';
  const mainWindow = new BrowserWindow({
    width: defaultBounds.width,
    height: defaultBounds.height,
    // 自绘标题栏：
    //  - macOS：hiddenInset（保留左上角红绿灯，隐藏标题栏）
    //  - Windows/Linux：无边框（顶部工具栏兼任拖拽区，右上角自绘窗口按钮）
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    // 最小尺寸：保证工具栏(46)+状态栏(28)+内容区都放得下（防止恢复成过小窗口导致状态栏被挤出）
    minWidth: 480,
    minHeight: 240,
    ...(defaultBounds.x !== undefined ? { x: defaultBounds.x + cascadeOffset, y: (defaultBounds.y || 0) + cascadeOffset } : {}),
    icon: resolveAsset('assets/icon.png'),
    title: 'Cuckoo Code Pro - ' + (provider ? provider.name : '未选择平台') + ' - ' + profileData.name,
    // 子代理窗口：隐藏（不弹窗、不占任务栏）；跑完由主进程主动关闭
    ...(profileData.isSubagent ? { show: false, skipTaskbar: true } : {}),
    webPreferences: {
      // 壳页面 preload（只负责地址栏导航，与 AI 页面 preload 分离）
      preload: path.join(import.meta.dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: profileData.partition, // 每个 profile 独立持久化 session
      additionalArguments: ['--cuckoo-user-data=' + app.getPath('userData'), '--cuckoo-platform=' + process.platform],
    },
  });

  // 无边框窗口：最大化时按当前显示器工作区设置 bounds，避免盖住任务栏（Windows 已知问题）
  try {
    const applyWorkArea = () => {
      if (!mainWindow.isMaximized()) return;
      const { screen } = require('electron');
      const disp = screen.getDisplayMatching(mainWindow.getBounds());
      mainWindow.setBounds(disp.workArea);
    };
    mainWindow.on('maximize', () => { try { applyWorkArea(); } catch (_) {} });
    mainWindow.on('unmaximize', () => { try { mainWindow.setBounds(mainWindow.getBounds()); } catch (_) {} });
  } catch (_) { /* ignore */ }

  // 子代理配置：序列化后经 additionalArguments 传给 bridge（供子代理窗口自识别）
  const subagentArg = profileData.subagentConfig
    ? '--cuckoo-subagent=' + encodeURIComponent(JSON.stringify(profileData.subagentConfig))
    : null;

  // AI 页面视图（复用现有 bridge preload；与壳共用 partition）
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(import.meta.dirname, '..', 'bridge', 'entry.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: profileData.partition,
      backgroundThrottling: false,
      additionalArguments: subagentArg
        ? ['--cuckoo-user-data=' + app.getPath('userData'), subagentArg]
        : ['--cuckoo-user-data=' + app.getPath('userData')],
    },
  });
  mainWindow.contentView.addChildView(view);

  // ========== 插件覆盖层窗口（透明、置顶、鼠标穿透） ==========
  // 用独立 BrowserWindow（而非 WebContentsView）——因为只有 BrowserWindow 支持
  // setIgnoreMouseEvents（鼠标穿透）；WebContentsView 不支持，会拦截 AI 页面的滚轮/点击。
  // 插件 UI（如桌宠）住在这里，不注入 AI 页面；由 ctx.ui.overlay 驱动。
  let overlayWin: any = null;
  (mainWindow as any).__ckOverlayView = null;  // 兼容旧引用名（值为 overlayWin）
  (mainWindow as any).__ckEnsureOverlay = () => ensureOverlayView();
  const ensureOverlayView = (): any => {
    // 子代理窗口是隐藏的，不需要覆盖层——否则它的 overlay 会浮到主窗口上，
    // 导致插件面板（如 MCP 内网穿透桥）显示两份。
    if (profileData.isSubagent) return null;
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
    const ow = new BrowserWindow({
      parent: mainWindow,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,           // 不抢焦点
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(import.meta.dirname, 'plugin-overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: profileData.partition,
        transparent: true,
        additionalArguments: ['--cuckoo-user-data=' + app.getPath('userData')],
      },
    });
    // 鼠标穿透：默认全穿透（滚轮/点击/滚动条透到 AI 页面）
    try { ow.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
    overlayWin = ow;
    (mainWindow as any).__ckOverlayView = ow;
    // 主窗口关闭 → overlay 一起关
    mainWindow.on('closed', () => { try { if (!ow.isDestroyed()) ow.destroy(); } catch (_) {} });
    mainWindow.on('minimize', () => { try { ow.hide(); } catch (_) {} });
    mainWindow.on('restore', () => { try { ow.showInactive(); } catch (_) {} });
    // 挂到窗口上下文
    {
      const ctx: any = windowState.getWindowContext(mainWindow.id);
      if (ctx) { ctx.__ckEnsureOverlay = () => ensureOverlayView(); ctx.overlayView = ow; }
    }
    // 加载覆盖层页面（内联 HTML）
    ow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}*{box-sizing:border-box}</style></head><body><div id="__ck_overlay_root"></div></body></html>'
    ));
    ow.webContents.on('did-finish-load', () => {
      console.log('[Cuckoo Overlay] 页面加载完成');
      try { ow.showInactive(); } catch (_) {}
    });
    setTimeout(() => { try { (mainWindow as any).__ckLayout && (mainWindow as any).__ckLayout(); } catch (_) {} }, 50);
    return ow;
  };

  // ========== 纯净对话模式（Harness）覆盖视图（懒加载） ==========
  // 承载类 Codex 的纯净对话 UI，默认隐藏；按 Ctrl+Shift+H 或 IPC 切换。
  // AI 网页（view）继续在后台运行，仅被遮挡。
  // 懒加载：首次进入纯净模式才创建 WebContentsView，避免"从不使用纯净模式"的窗口
  // 也常驻一个渲染进程、并提前加载 1486 行页面（降内存/启动开销）。
  let harnessView: any = null;
  (mainWindow as any).__ckHarnessView = null;
  (mainWindow as any).__ckHarnessVisible = false; // 默认网页模式，Ctrl+Shift+H 进入纯净模式

  const ensureHarnessView = (): any => {
    if (harnessView && !harnessView.webContents.isDestroyed()) return harnessView;
    const hv = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, 'harness-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: profileData.partition,
        additionalArguments: ['--cuckoo-user-data=' + app.getPath('userData')],
      },
    });
    mainWindow.contentView.addChildView(hv);
    // harness 页面加载前的底色：跟随系统深浅色（对齐设计规范，加载后由页面 CSS 接管）
    // 透明：让 harness 透出下面的壳页面（壁纸/背景）
    hv.setBackgroundColor('#00000000');
    hv.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    harnessView = hv;
    (mainWindow as any).__ckHarnessView = hv;
    // 挂到窗口上下文，供 harness IPC 查找
    {
      const ctx: any = windowState.getWindowContext(mainWindow.id);
      if (ctx) ctx.harnessView = hv;
    }
    // 加载 harness 页面
    hv.webContents.loadFile(resolveSrc('ui/harness.html'));
    hv.webContents.on('did-finish-load', () => {
      console.log('[Cuckoo Harness] 页面加载完成');
      // 应用纯净模式字号（用户偏好）。CSS zoom 在页面加载后才生效，故放在此。
      try {
        const { readPrefs: readUiPrefs } = require('./ui-prefs.js');
        applyHarnessZoom(hv.webContents, readUiPrefs().harnessZoom);
      } catch (_) { /* ignore */ }
      try { notifyHarnessSession(view.webContents.getURL()); } catch (_) {}
    });
    hv.webContents.on('did-fail-load', (_e: any, code: any, desc: any) => {
      console.error('[Cuckoo Harness] 页面加载失败: ' + code + ' ' + desc);
    });
    hv.webContents.on('console-message', (_e: any, _l: any, msg: any) => {
      console.log('[Harness Console] ' + msg);
    });
    // harness 页面内快捷键：Ctrl+R 重载页面（加载最新 HTML，无需重启）
    hv.webContents.on('before-input-event', (_event: any, input: any) => {
      if (input.control && !input.shift && (input.key === 'r' || input.key === 'R')) {
        hv.webContents.reloadIgnoringCache();
      }
      if (input.type === 'keyDown' && input.key === 'F12') {
        hv.webContents.toggleDevTools();
      }
    });
    return hv;
  };

  // 布局：AI 页面占地址栏下方、Cuckoo 侧边栏右侧区域。
  // 侧边栏可收起（收起时 x=0，AI 页面铺满）。
  const TOOLBAR_HEIGHT = 46; // 地址栏 46（与 shell.css .toolbar height 保持一致）
  const STATUS_HEIGHT = 28;  // 底部状态条（当前上下文 token，与 shell.css .statusbar 一致）
  const SIDEBAR_WIDTH = 460;      // 左侧 Cuckoo 侧边栏展开宽度
  const SIDEBAR_COLLAPSED = 46;   // 收起时仅保留图标栏
  // 平台未选择时：整个侧边栏隐藏 + 地址栏也隐藏（AI 页面从顶部铺满）
  (mainWindow as any).__ckSidebarWidth = providerChosen ? SIDEBAR_COLLAPSED : 0;
  (mainWindow as any).__ckToolbarHeight = providerChosen ? TOOLBAR_HEIGHT : 0;
  const layoutView = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const sbw = (mainWindow as any).__ckSidebarWidth ?? SIDEBAR_WIDTH;
    const tbh = (mainWindow as any).__ckToolbarHeight ?? TOOLBAR_HEIGHT;
    // 宽度：直接用 getContentSize（客户区宽度，实时准确、不受菜单栏影响）。
    // 不再依赖壳页面上报的宽度 —— 窗口放大后上报滞后会让 AI view 偏窄、右侧留白
    // （重启即恢复的症状）。任何视图都不应超过客户区宽度，故以 cw 为基准。
    // 高度：仍需壳页面上报值修正（getContentSize 在 Windows 上会多算菜单栏高度，
    // 导致 AI view 盖住底部状态栏）；未上报时回退 getContentSize。
    const [cw, ch] = mainWindow.getContentSize();
    const w = cw;
    const h = (mainWindow as any).__ckShellHeight || ch;
    // 壳页面全窗口浮层（如提交 diff）打开时：临时隐藏所有原生视图
    // （原生 WebContentsView 永远盖在壳页面之上，不隐藏则浮层右侧被遮挡）。
    // 用 setVisible（setBounds 到 0 不会改变 webContents 视口尺寸，浮层仍被盖）。
    const webviewHidden = !!(mainWindow as any).__ckWebviewHidden;
    const harnessVisible = !!(mainWindow as any).__ckHarnessVisible;
    // modal-guard（壳页面模态框/看图）单独隐藏 AI 视图的标记。
    // 必须纳入 aiVisible：否则 layoutView 在 resize/move 时会抢显 modal-guard 隐藏的 AI 视图。
    const aiHiddenByModal = !!(mainWindow as any).__ckAiHidden;
    const vx = sbw, vy = tbh;
    const vw = Math.max(0, w - sbw), vh = Math.max(0, h - tbh - STATUS_HEIGHT);
    // AI 视图可见性：浮层打开 / modal 隐藏 / harness 可见 → 隐藏；否则显示。
    // setVisible + setBounds 双保险（某些平台 setVisible 偶发不生效，见下方 harness 切换处）。
    const aiVisible = !webviewHidden && !harnessVisible && !aiHiddenByModal;
    try {
      if (view && !view.webContents.isDestroyed()) {
        view.setBounds(aiVisible ? { x: vx, y: vy, width: vw, height: vh } : { x: 0, y: 0, width: 0, height: 0 });
        view.setVisible(aiVisible);
      }
    } catch (_) { /* ignore */ }
    // overlay（独立 BrowserWindow）覆盖整个"网页区域" —— 用屏幕坐标
    const ov = (mainWindow as any).__ckOverlayView;
    if (ov && !ov.isDestroyed()) {
      if (webviewHidden) {
        try { ov.hide(); } catch (_) {}
      } else {
        const cb = mainWindow.getContentBounds();  // 窗口内容区在屏幕上的位置
        ov.setBounds({
          x: cb.x + sbw, y: cb.y + tbh,
          width: vw, height: vh,
        });
        try { if (typeof ov.showInactive === 'function') ov.showInactive(); } catch (_) {}
      }
    }
    // harness 覆盖整个"网页区域"（与 AI view 同位置）
    const hv = (mainWindow as any).__ckHarnessView;
    if (hv && !hv.webContents.isDestroyed()) {
      const hvVisible = !webviewHidden && !aiHiddenByModal && !!(mainWindow as any).__ckHarnessVisible;
      hv.setBounds(hvVisible ? { x: vx, y: vy, width: vw, height: vh } : { x: 0, y: 0, width: 0, height: 0 });
      try { hv.setVisible(hvVisible); } catch (_) {}
    }
  };
  (mainWindow as any).__ckLayout = layoutView;
  layoutView();
  // resize/move 用定时器合并（避免高频重排；主进程无 rAF）
  let layoutTimer: any = null;
  const scheduleLayout = () => {
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => { layoutTimer = null; layoutView(); }, 16);
  };
  mainWindow.on('resize', scheduleLayout);
  mainWindow.on('move', scheduleLayout);
  // 最小化恢复：restore 不触发 show，必须显式重排，否则 WebContentsView 恢复后空白
  mainWindow.on('restore', () => {
    try { layoutView(); } catch (_) {}
    // 恢复瞬间窗口尺寸可能还在变化，延迟再排一次兜底
    setTimeout(() => { try { layoutView(); } catch (_) {} }, 100);
  });
  // 窗口首次显示后必须再排一次：Electron 的 WebContentsView 首次显示时
  // 常需重新 setBounds 才渲染（否则偶发空白，缩放/拖宽触发 resize 才恢复）。
  mainWindow.once('ready-to-show', () => { try { layoutView(); } catch (_) {} });
  mainWindow.on('show', () => { try { layoutView(); } catch (_) {} });
  // 兜底：内容稳定后再排两次（覆盖首次 show 与 WebContentsView 附加的时序竞争）
  setTimeout(() => { try { layoutView(); } catch (_) {} }, 200);
  setTimeout(() => { try { layoutView(); } catch (_) {} }, 600);

  // 覆盖层：把"确保创建"挂到 windowState 的 ctx（供 IPC 调用；IPC 通过 getAllContexts 拿）
  {
    const ctx: any = windowState.getWindowContext(mainWindow.id);
    if (ctx) {
      ctx.__ckEnsureOverlay = () => ensureOverlayView();
      // 同步 overlayView 引用到 ctx（后续 ensure 创建时也会再写一次）
      Object.defineProperty(ctx, 'overlayView', {
        configurable: true,
        get() { return (mainWindow as any).__ckOverlayView; },
      });
    }
  }

  // F12：打开壳页面 DevTools（焦点在壳页面时）。
  // 必须判断 keyDown——before-input-event 对 keyDown/keyUp 都触发，
  // 不判断会"按下开、抬起关"，看起来像没打开。
  mainWindow.webContents.on('before-input-event', (_event: any, input: any) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });
  // 加载地址栏壳页面；壳就绪后主动推一次当前 URL 状态（避免与 view 加载竞态）
  mainWindow.loadFile(resolveSrc('ui/shell.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    // 壳页面重载：复位隐藏标记（防弹框打开期间重载 → AI 区永久隐藏）
    (mainWindow as any).__ckWebviewHidden = false;
    (mainWindow as any).__ckAiHidden = false;
    pushUrlState(view);
    // 平台未选择：通知壳页面隐藏侧边栏 + 项目选择器
    try { mainWindow.webContents.send('shell-platform-mode', { selecting: !providerChosen }); } catch (_) {}
    // 壳就绪后重排（此时尺寸才准，修首次空白）
    try { (mainWindow as any).__ckLayout && (mainWindow as any).__ckLayout(); } catch (_) {}
  });

  // 保存 session 引用（窗口销毁后 webContents 不可访问）
  const winSession = view.webContents.session;

  // 注册窗口上下文（记录 providerId，未确定时为空字符串）
  windowState.addWindow(mainWindow, profileData.id, profileData.providerId || '', sessionStore, view, !!profileData.isSubagent);
  sessionsToFlush.add(winSession);

  // 通知 harness 当前会话已变化（用于按会话隔离历史/目标/计划）
  const notifyHarnessSession = (url: string) => {
    try {
      const c: any = windowState.getContextByWebContents(view.webContents);
      const hv = c && c.harnessView;
      if (!hv || hv.webContents.isDestroyed()) return; // 懒加载下 view 可能尚未创建
      let sid = '';
      const provider = c.providerId ? getProvider(c.providerId) : null;
      if (provider && typeof provider.extractSessionId === 'function') sid = provider.extractSessionId(url) || '';
      hv.webContents.send('harness-event', { type: 'session-changed', sessionId: sid });
    } catch (_) { /* ignore */ }
  };

  // 切换纯净模式（同窗口）：true=显示 harness，false=显示网页
  (mainWindow as any).__ckToggleHarness = (show?: boolean) => {
    if (mainWindow.isDestroyed()) return;
    const next = typeof show === 'boolean' ? show : !(mainWindow as any).__ckHarnessVisible;
    (mainWindow as any).__ckHarnessVisible = next;
    if (next) {
      // 懒加载：首次进入纯净模式才创建 harness 视图
      const hv = ensureHarnessView();
      try { hv.setVisible(true); } catch (_) {}
      // 隐藏 AI 视图（DS 页面）→ harness 透明可透出壳页面壁纸，天然对齐。
      // setVisible + setBounds 双保险：某些平台 WebContentsView 的 setVisible 偶发不生效，
      // 归零 bounds 可确保 AI 页面不残留（否则两层叠加）。
      try {
        if (view && !view.webContents.isDestroyed()) {
          view.setVisible(false);
          view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        }
      } catch (_) {}
      layoutView();
      if (hv && !hv.webContents.isDestroyed()) hv.webContents.focus();
    } else {
      // 切回网页模式：显式隐藏 harness（setVisible + setBounds 双保险，避免盖住工具栏）
      const hv0 = (mainWindow as any).__ckHarnessView;
      if (hv0 && !hv0.webContents.isDestroyed()) {
        try { hv0.setVisible(false); } catch (_) {}
        try { hv0.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch (_) {}
      }
      // 恢复 AI 视图（DS 页面）
      try { if (view && !view.webContents.isDestroyed()) view.setVisible(true); } catch (_) {}
      layoutView();
    }
    // overlay 现在是独立 BrowserWindow（不是 WebContentsView），它本来就浮在主窗口之上，
    // 不会被 harnessView 盖住 —— 无需"提到顶层"。只需重新布局（同步位置）。
    try { layoutView(); } catch (_) {}
    // 注：不再向 AI 页面下发"纯净模式开关"。bridge 侧上报已不设门控
    //（门控一旦判断错就整片静默丢弃，曾导致界面空白 + 状态卡死）；
    // 主进程在没有 harness 视图时自会丢弃事件，无需 bridge 配合。
    // 通知壳页面：更新「纯净模式/原版模式」按钮
    try { mainWindow.webContents.send('shell-harness-mode', { harness: next }); } catch (_) {}
    // 通知 AI 页面（插件运行处）→ 广播 harness/change 给插件
    try { view.webContents.send('harness-mode-changed', { harness: next }); } catch (_) {}
  };

  // 更新主窗口引用
  windowState.setMainWindow(mainWindow);

  // 记录最后活跃的 profile，供下次启动恢复。
  // 子代理窗口跳过（临时 profile，不参与"上次活跃"恢复）。
  if (!profileData.isSubagent) {
    try { profileManager.setLastActiveProfileId(profileData.id); } catch (_) { /* ignore */ }
    mainWindow.on('focus', () => {
      try { profileManager.setLastActiveProfileId(profileData.id); } catch (_) { /* ignore */ }
    });
  }

  // 从后台切回前台：重排一次，修复 WebContentsView 偶发不重绘（对子代理窗口同样生效）
  mainWindow.on('focus', () => {
    try { (mainWindow as any).__ckLayout && (mainWindow as any).__ckLayout(); } catch (_) { /* ignore */ }
  });

  // 初始化自动更新（仅第一个窗口时初始化）
  if (windowState.getAllWindows().length === 1) {
    updater.initAutoUpdater(mainWindow);
  }

  // 转发 AI 页面 console.log 到主进程，并按平台写入独立日志文件
  view.webContents.on('console-message', (_event: any, level: any, message: any, _line: any, _sourceId: any) => {
    console.log('[Renderer Console][' + profileData.name + ']', message);

    // 打包版不进行日志持久化
    if (!RENDERER_LOG_DIR) return;

    // 根据当前窗口上下文确定 providerId，未确定用 default
    let providerId = profileData.providerId || 'default';
    const ctx = windowState.getContextByWebContents(view.webContents);
    if (ctx && ctx.providerId) providerId = ctx.providerId;

    const logFile = path.join(RENDERER_LOG_DIR, providerId + '.log');
    const timeIso = new Date().toISOString();
    fs.appendFileSync(logFile, '[' + timeIso + '][' + profileData.name + '] ' + message + '\n', 'utf-8');
  });

  // 恢复最大化状态（若有记录且曾最大化）
  if (savedBounds && savedBounds.maximized) {
    mainWindow.maximize();
  }

  // 设置普通 Chrome UA（动态取真实内核版本）：
  // 1. 不带 Electron 标识，避免 DeepSeek 识别为第三方客户端
  // 2. 与内核版本一致，避免 Google OAuth 因 UA/sec-ch-ua 不一致报"浏览器不安全"
  view.webContents.setUserAgent(buildChromeUserAgent());

  // 补齐 Chrome 客户端提示请求头（Sec-CH-UA*）：
  // Electron 默认的 sec-ch-ua 缺少 "Google Chrome" 品牌，Google 据此判定
  // "浏览器或应用不安全"而拒绝 OAuth 登录。本会话所有请求统一改写，
  // 只在本窗口 session 上注册（不影响其他窗口）。
  try {
    const hints = buildClientHintsHeaders();
    const ses = view.webContents.session;
    ses.webRequest.onBeforeSendHeaders((details: any, callback: any) => {
      try {
        const h = details.requestHeaders || {};
        for (const k of Object.keys(h)) {
          const lk = k.toLowerCase();
          if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-mobile' || lk === 'sec-ch-ua-platform' ||
              lk === 'sec-ch-ua-full-version' || lk === 'sec-ch-ua-full-version-list') {
            delete h[k];
          }
        }
        Object.assign(h, hints);
        callback({ requestHeaders: h });
      } catch (_) {
        callback({ requestHeaders: details.requestHeaders });
      }
    });
  } catch (err: any) {
    console.error('[Cuckoo Code] 注册客户端提示请求头失败:', err && err.message);
  }

  // 优先恢复上次关闭时的 URL（仅 http/https，且平台已确定）
  const lastUrl = profileData.lastUrl;
  console.log('[Cuckoo Code] 创建窗口: profile=' + profileData.id + ' providerChosen=' + providerChosen + ' lastUrl=' + (lastUrl || '(无)'));
  if (providerChosen && provider && lastUrl && /^https?:\/\//i.test(lastUrl)) {
    view.webContents.loadURL(lastUrl);
  } else if (providerChosen && provider) {
    // 平台已确定且存在，直接进入平台首页
    view.webContents.loadURL(provider.homeUrl);
  } else {
    // 平台未确定（或对应 provider 已缺失），显示平台选择页
    const selectPage = resolveSrc('ui/platform-select.html');
    view.webContents.loadFile(selectPage);
  }

  // 项目目录确定后，异步自动连该项目的 MCP（不阻塞导航/窗口）
  const autoConnectMcp = () => {
    try {
      const dir = (sessionStore && sessionStore.state && sessionStore.state.selectedProjectDir) || null;
      mcpClient.autoConnectForWindow(mainWindow.id, dir);
    } catch (_) {}
  };

  view.webContents.on('did-finish-load', () => {
    if (view.webContents && !view.webContents.isDestroyed()) {
      view.webContents.send('page-loaded');
      sessionStore.tryRestoreSessionFromUrl(view);
      pushUrlState(view);
      autoConnectMcp();
      // AI 内容就绪后重排一次（view 首帧渲染需要正确 bounds，修偶发空白）
      try { (mainWindow as any).__ckLayout && (mainWindow as any).__ckLayout(); } catch (_) {}
    }
  });

  view.webContents.on('did-navigate', (_event: any, url: string) => {
    sessionStore.handleUrlChange(url, view);
    pushUrlState(view);
    // 通知 AI 页面（overlay/看门狗）URL 已变，替代原先的渲染进程轮询
    try { view.webContents.send('cuckoo-url-changed', { url }); } catch (_) {}
    notifyHarnessSession(url);
    // 通知壳页面：网页 URL 变了 → 刷新对话列表高亮
    try { mainWindow.webContents.send('shell-web-url-changed', { url }); } catch (_) {}
    // 通知 harness 页面刷新"需初始化项目"状态（首页 ↔ 会话页）
    try { pushHarnessState(windowState.getContextByWebContents(view.webContents)); } catch (_) {}
    autoConnectMcp();
  });

  view.webContents.on('did-navigate-in-page', (_event: any, url: string) => {
    sessionStore.handleUrlChange(url, view);
    pushUrlState(view);
    // SPA 路由（pushState）变化也在此触发，替代轮询
    try { view.webContents.send('cuckoo-url-changed', { url }); } catch (_) {}
    notifyHarnessSession(url);
    try { mainWindow.webContents.send('shell-web-url-changed', { url }); } catch (_) {}
    // 通知 harness 页面刷新"需初始化项目"状态（首页 ↔ 会话页）
    try { pushHarnessState(windowState.getContextByWebContents(view.webContents)); } catch (_) {}
    autoConnectMcp();
  });

  view.webContents.on('before-input-event', (_event: any, input: any) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      view.webContents.toggleDevTools();
    }
  });

  // 关闭前记录窗口大小/位置（用 getNormalBounds 取"还原后"尺寸；closed 时窗口已销毁取不到）
  mainWindow.on('close', () => {
    if (profileData.isSubagent) return; // 子代理窗口：不记录
    // 直接关闭，无二次确认
    try {
      if (mainWindow.isDestroyed()) return;
      const b = mainWindow.getNormalBounds();
      profileManager.setWindowBounds(profileData.id, {
        x: b.x, y: b.y, width: b.width, height: b.height,
        maximized: mainWindow.isMaximized(),
      });
      // 记录最后 URL（仅 http/https；view 可能已销毁）
      if (view && view.webContents && !view.webContents.isDestroyed()) {
        const curUrl = view.webContents.getURL();
        console.log('[Cuckoo Code] 关闭窗口记录 lastUrl: profile=' + profileData.id + ' url=' + curUrl);
        profileManager.setLastUrl(profileData.id, curUrl);
      } else {
        console.log('[Cuckoo Code] 关闭窗口：view 已销毁，跳过记录 URL (profile=' + profileData.id + ')');
      }
    } catch (_) { /* ignore */ }
  });

  mainWindow.on('closed', () => {
    sessionsToFlush.delete(winSession);
    windowState.removeWindow(mainWindow.id);
    // 释放该窗口持有的 MCP 连接引用 + 清理自动连记录
    try { mcpClient.forgetWindow(mainWindow.id); } catch (_) {}
  });

  return mainWindow.id;
}

// ========== 子代理窗口 ==========
/**
 * 创建子代理窗口（复用父窗口 partition → 免登录 + token 计入同一"窗口"）。
 * @param parentProfileId 父窗口 profile id
 * @param agentName 代理名（用于窗口标题）
 * @returns 子代理窗口的 windowId
 */
function createSubagentWindow(parentProfileId: string, agentName: string): number {
  const parent = profileManager.getProfileById(parentProfileId);
  if (!parent) throw new Error('父 profile 不存在: ' + parentProfileId);
  const sub = profileManager.createSubagentProfile(parent, agentName);
  return createWindow(sub);
}

// ========== 应用菜单 ==========
function setupAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const profiles = profileManager.readProfiles();
            createWindow(profileManager.createProfile('窗口' + (profiles.length + 1), ''));
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '导航',
      submenu: [
        {
          label: '后退',
          accelerator: 'Alt+Left',
          click: (_item: any, focusedWindow: any) => {
            const ctx = focusedWindow ? windowState.getContextByWebContents(focusedWindow.webContents) : null;
            const view = ctx ? ctx.view : null;
            if (view && view.webContents.navigationHistory.canGoBack()) {
              view.webContents.navigationHistory.goBack();
            }
          }
        },
        {
          label: '前进',
          accelerator: 'Alt+Right',
          click: (_item: any, focusedWindow: any) => {
            const ctx = focusedWindow ? windowState.getContextByWebContents(focusedWindow.webContents) : null;
            const view = ctx ? ctx.view : null;
            if (view && view.webContents.navigationHistory.canGoForward()) {
              view.webContents.navigationHistory.goForward();
            }
          }
        },
        { type: 'separator' },
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: (_item: any, focusedWindow: any) => {
            const ctx = focusedWindow ? windowState.getContextByWebContents(focusedWindow.webContents) : null;
            const view = ctx ? ctx.view : null;
            if (view && view.webContents && !view.webContents.isDestroyed()) {
              view.webContents.reload();
            }
          }
        },
        {
          label: '停止加载',
          accelerator: 'Esc',
          click: (_item: any, focusedWindow: any) => {
            const ctx = focusedWindow ? windowState.getContextByWebContents(focusedWindow.webContents) : null;
            const view = ctx ? ctx.view : null;
            if (view && view.webContents && !view.webContents.isDestroyed()) {
              view.webContents.stop();
            }
          }
        },
        { type: 'separator' },
        {
          label: '主页',
          click: (_item: any, focusedWindow: any) => {
            if (!focusedWindow) return;
            const ctx = windowState.getContextByWebContents(focusedWindow.webContents);
            const view = ctx ? ctx.view : null;
            if (ctx && ctx.providerId && view && view.webContents && !view.webContents.isDestroyed()) {
              const provider = getProvider(ctx.providerId);
              if (provider) view.webContents.loadURL(provider.homeUrl);
            }
          }
        }
      ]
    },
    {
      label: '查看',
      submenu: [
        {
          label: '纯净对话模式',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: (_item: any, focusedWindow: any) => {
            if (!focusedWindow) return;
            try { (focusedWindow as any).__ckToggleHarness?.(); } catch (_) {}
          }
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于顶层' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            updater.checkForUpdates();
          }
        },
        { type: 'separator' },
        { role: 'about', label: '关于 Cuckoo Code' }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ========== 子代理依赖注入 ==========
injectSubagentDeps({ createWindow, profileManager });
// 给 runAgent 工具注入执行器（tools 层不依赖 app）
injectAgentRunner(async ({ agent, task, currentWindowId }: any) => {
  const ctx = windowState.getWindowContext(currentWindowId);
  if (!ctx) throw new Error('父窗口上下文不存在');
  return runAgentImpl({
    parentProfileId: ctx.profileId,
    parentWindowId: currentWindowId,
    agentName: agent.name,
    task,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    maxTurns: agent.maxTurns,
  });
});
// 给 runAgent 工具注入"是否子代理窗口"判定（防递归；tools 层不依赖 app）
injectSubagentChecker(isSubagentWindow);

// ========== 网关查询入口（供 ai-gateway 等主进程插件调用）==========
// 插件（providers/*.js）在主进程运行，可通过 globalThis.__cuckooRunGatewayQuery 调用。
// 它在独立隐藏窗口里跑一次问答：工具循环天然正常、不污染用户对话。
(globalThis as any).__cuckooRunGatewayQuery = runGatewayQueryImpl;
// 给 goalDone 工具注入"推送目标完成事件"实现（tools 层不依赖 app）
injectGoalDonePusher(pushGoalDone);
// 给 nameConversation 工具注入"设置当前会话标题"实现
injectSessionTitleSetter(async ({ windowId, title }: any) => {
  const ctx = windowState.getWindowContext(windowId);
  if (!ctx || !ctx.sessionStore) return { success: false, error: '无会话上下文' };
  const r = ctx.sessionStore.setSessionTitle(String(title).trim());
  // 通知壳页面刷新工作区列表（暂存时不刷，等绑定后再刷）
  if (r && r.success && !r.pending) {
    try { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('shell-sessions-changed'); } catch (_) { /* ignore */ }
  }
  return r;
});

// 给 remember/forgetMemory 工具注入记忆存储（tools 层不依赖 app/infra 实现）
injectMemoryStore({
  add: (text: string) => { const m = addMemory(text); return m ? { id: m.id } : null; },
  remove: (id: string) => removeMemory(id),
  list: () => listMemories().map((m) => ({ id: m.id, text: m.text })),
});
// 给 createSnapshot/listSnapshots/restoreSnapshot 工具注入快照存储
injectSnapshotStore({
  create: (projectDir: string, name: string, description?: string) => {
    const m = createSnapshot(projectDir, name, description);
    return { id: m.id, fileCount: m.fileCount, projectDir: m.projectDir };
  },
  list: (projectDir: string) => listSnapshots()
    .filter((s) => !projectDir || s.projectDir === projectDir)
    .map((s) => ({ id: s.id, name: s.name, description: s.description, fileCount: s.fileCount, createdAt: s.createdAt, projectDir: s.projectDir })),
  restore: (id: string) => restoreSnapshot(id),
});

// ========== 窗口组探测 ==========
// 把目标窗口导航到 "首页?cuckoo-probe=1"，等其 bridge 上报探测结果。
// 返回 'ok' | 'limited' | 'timeout' | 'error'
const pendingProbes = new Map<string, { resolve: (r: string) => void; timer: any }>();

ipcMainForProfile.handle('probe-result', async (event: any, { result }: any) => {
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx || !ctx.win) return { success: false };
  const key = String(ctx.win.id);
  const p = pendingProbes.get(key);
  if (p) { pendingProbes.delete(key); clearTimeout(p.timer); p.resolve(result || 'error'); }
  return { success: true };
});

/** 探测指定窗口是否被限流（新开对话发"你好"） */
async function probeWindow(profileId: string): Promise<string> {
  // 打开/复用窗口
  let ctx = windowState.getWindowByProfileId(profileId);
  let windowId: number;
  if (ctx && ctx.win && !ctx.win.isDestroyed()) {
    windowId = ctx.win.id;
  } else {
    const prof = profileManager.getProfileById(profileId);
    if (!prof) return 'error';
    windowId = createWindow(prof);
    ctx = windowState.getWindowContext(windowId);
  }
  if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) return 'error';
  const wc = ctx.view.webContents;
  const provider = ctx.providerId ? getProvider(ctx.providerId) : null;
  const homeUrl = (provider && provider.homeUrl) ? provider.homeUrl : '';
  if (!homeUrl) return 'error';
  const probeUrl = homeUrl + (homeUrl.includes('?') ? '&' : '?') + 'cuckoo-probe=1';

  return await new Promise<string>((resolve) => {
    const key = String(windowId);
    const timer = setTimeout(() => { pendingProbes.delete(key); resolve('timeout'); }, 70000);
    pendingProbes.set(key, { resolve, timer });
    try { wc.loadURL(probeUrl).catch(() => { /* did-fail 由超时兜底 */ }); }
    catch (_) { clearTimeout(timer); pendingProbes.delete(key); resolve('error'); }
  });
}

// ========== 窗口组切换编排 ==========
/** 取窗口显示名（profile.name，回退 profileId） */
function profileDisplayName(profileId: string | null): string {
  if (!profileId) return '窗口';
  try {
    const p = profileManager.getProfileById(profileId);
    return (p && p.name) ? p.name : profileId;
  } catch (_) { return profileId; }
}

/**
 * 窗口组切换提示：系统通知 + 壳页面 toast。
 * 系统通知为主（任何情况可见）；toast 在壳页面右上角，会被 AI WebContentsView 盖住，
 * 仅在 AI 视图未覆盖处可见，故不能只依赖 toast。
 * @param reason 'rate-limit'（自动，账号限流）| 'manual'（手动转移）
 * @param fromName 源窗口名
 * @param toName 目标窗口名（失败时为空）
 * @param ok 是否成功
 * @param detail 失败/成功补充（可选）
 */
function notifyWindowSwitch(reason: string, fromName: string, toName: string, ok: boolean, detail?: string): void {
  const reasonText = reason === 'rate-limit' ? '账号限流自动切换' : '手动转移对话';
  const title = ok ? '窗口组已切换' : '窗口组切换失败';
  const body = ok
    ? (reasonText + '：' + fromName + ' → ' + toName + (detail ? '（' + detail + '）' : ''))
    : (reasonText + '：' + (detail || '切换未完成'));
  // 系统通知（主通道）
  try {
    if (Notification && Notification.isSupported()) {
      const n = new Notification({ title, body });
      n.show();
      // 保持引用防 GC（Electron 已知坑：局部变量会在 show() 后被回收）
      setTimeout(() => { try { n.close(); } catch (_) {} }, 8000);
    }
  } catch (_) { /* ignore */ }
  // 壳页面 toast（辅助，广播给所有窗口）
  try {
    for (const c of windowState.getAllContexts()) {
      try {
        if (c && c.win && !c.win.isDestroyed() && c.win.webContents && !c.win.webContents.isDestroyed()) {
          c.win.webContents.send('shell-window-switch', { ok, reason: reasonText, from: fromName, to: toName, detail: detail || '' });
        }
      } catch (_) { /* 单个窗口失败不影响其它 */ }
    }
  } catch (_) { /* ignore */ }
}

/** 把 fromProfileId 窗口的当前对话分享给组内下一个窗口（返回 { success, ... }） */
async function runSwitchForGroup(groupId: string, fromProfileId: string, closeSource: boolean = false, reasonOverride?: string): Promise<any> {
    // reason 独立于 closeSource：手动转移也可关源窗口，但文案仍是"手动转移"
    const reason = reasonOverride || (closeSource ? 'rate-limit' : 'manual');
    const fromName = profileDisplayName(fromProfileId);
    // 1) 找源窗口上下文
    const allCtx = windowState.getAllContexts().filter((c: any) => c.profileId === fromProfileId && !c.isSubagent);
    const cur: any = allCtx[0];
    if (!cur || !cur.win || cur.win.isDestroyed()) {
      notifyWindowSwitch(reason, fromName, '', false, '源窗口不可用');
      return { success: false, error: '源窗口不可用' };
    }
    const curWindowId = cur.win.id;
    const curProfileId = cur.profileId;

    // 2) 校验：源窗口是否属于该组
    const group = windowGroups.getGroupByWindowId(curProfileId);
    if (!group || group.id !== groupId) {
      return { success: false, error: '当前窗口不属于该组，请先切到组内窗口' };
    }

    // 3) 停掉当前窗口的生成 + 工具调用
    try { await stopGeneration(cur); } catch (_) { /* ignore */ }
    // 3.5) 导出源窗口 harness 状态（历史 + 待发队列），供目标窗口无缝接续
    //      harness 未创建时返回 null，不影响主流程
    let harnessState: any = null;
    try { harnessState = await requestHarnessExport(curWindowId); } catch (_) { /* ignore */ }
    // 源窗口是否处于纯净模式：切换后目标窗口也进入（否则用户从纯净模式被切走，只看到网页，不算无缝）
    const srcWasHarness = !!(cur.win && (cur.win as any).__ckHarnessVisible);

    // 4) 请求源窗口分享当前对话（全量）
    const share = await requestShareFromWindow(curWindowId);
    if (!share || !share.ok || !share.shareId) {
      try { cur.view.webContents.send('harness-resume-retry'); } catch (_) { /* ignore */ }
      notifyWindowSwitch(reason, fromName, '', false, (share && share.error) || '分享失败');
      return { success: false, error: (share && share.error) || '分享失败' };
    }

    // 5) 取源窗口的项目目录
    const projectDir = (cur.sessionStore && cur.sessionStore.state && cur.sessionStore.state.selectedProjectDir) || null;

    // 6) 探测轮换：从"下一个"开始，逐个探测组内窗口，找第一个可用的
    const memberIds: string[] = Array.isArray(group.windowIds) ? group.windowIds : [];
    const startIdx = memberIds.indexOf(curProfileId);
    if (startIdx < 0) return { success: false, error: '当前窗口不在组内' };
    const probeOrder: string[] = [];
    for (let i = 1; i < memberIds.length; i++) {
      probeOrder.push(memberIds[(startIdx + i) % memberIds.length]);
    }
    if (probeOrder.length === 0) return { success: false, error: '组内没有其他窗口' };

    let nextProfileId: string | null = null;
    let skippedBusy = 0;
    let skippedCooldown = 0;
    for (const pid of probeOrder) {
      // 跳过正在跑任务的窗口（避免探测打断它的并行任务）
      if (windowState.isGenerating(pid)) {
        console.log('[窗口组] 跳过忙碌窗口 ' + pid + '（正在生成，不打断）');
        skippedBusy++;
        continue;
      }
      // 跳过仍在限流冷却期的窗口：不必发消息探测（省去垃圾对话 + 大幅缩短退避）
      if (windowGroups.isRateLimited(pid)) {
        console.log('[窗口组] 跳过冷却中窗口 ' + pid + '（近期限流，未恢复）');
        skippedCooldown++;
        continue;
      }
      console.log('[窗口组] 探测窗口 ' + pid + ' …');
      const pr = await probeWindow(pid);
      console.log('[窗口组] 探测结果 ' + pid + ' = ' + pr);
      if (pr === 'ok') { nextProfileId = pid; break; }
      // 仅「真限流」写冷却缓存；超时/错误不写（避免误伤只是加载慢的正常窗口）
      if (pr === 'limited') {
        try { windowGroups.markRateLimit(pid); } catch (_) { /* ignore */ }
      } else {
        console.log('[窗口组] 探测非限流（' + pr + '），不写冷却缓存 ' + pid);
      }
    }
    if (!nextProfileId) {
      // 恢复源窗口的重试（切换开始时被取消了）
      try { cur.view.webContents.send('harness-resume-retry'); } catch (_) { /* ignore */ }
      const msg = (skippedBusy > 0 || skippedCooldown > 0)
        ? '组内其他窗口均不可用（跳过忙 ' + skippedBusy + ' / 冷却 ' + skippedCooldown + ' 个），已退回重试'
        : '组内窗口均不可用（限流/超时），已退回重试';
      notifyWindowSwitch(reason, fromName, '', false, msg);
      return { success: false, error: msg, fallback: true, skippedBusy, skippedCooldown };
    }

    // 7) 打开目标窗口（探测时已开/已建）
    let target = windowState.getWindowByProfileId(nextProfileId);
    let targetWindowId: number;
    if (target && target.win && !target.win.isDestroyed()) {
      targetWindowId = target.win.id;
    } else {
      const prof = profileManager.getProfileById(nextProfileId);
      if (!prof) return { success: false, error: '目标窗口不存在' };
      targetWindowId = createWindow(prof);
    }
    const tctx = windowState.getWindowContext(targetWindowId);
    if (!tctx || !tctx.view || tctx.view.webContents.isDestroyed()) {
      return { success: false, error: '目标窗口视图不可用' };
    }
    const twc = tctx.view.webContents;

    // 8) 导航到分享链接；加载完成后初始化项目
    const shareUrl = 'https://chat.deepseek.com/share/' + share.shareId;
    // 目标就绪信号：initProject 成功 → true；失败/超时 → false（供"关源窗口"前置校验）
    let targetReadyResolve: (v: boolean) => void = () => {};
    const targetReady = new Promise<boolean>((res) => { targetReadyResolve = res; });
    const onLoad = () => {
      try { twc.off('did-finish-load', onLoad); } catch (_) { /* ignore */ }
      setTimeout(async () => {
        let ready = false;
        try {
          // 指定项目目录；不追加"请继续"（isCompaction=false, extraPrompt=''）
          await initProject(false, tctx, projectDir, false, '', false);
          ready = true;
        } catch (_) { /* ignore */ }
        try { targetReadyResolve(ready); } catch (_) { /* ignore */ }
        // 源窗口若在纯净模式 → 目标窗口也进入（无缝接续的必要条件）
        try {
          if (srcWasHarness && tctx.win && !tctx.win.isDestroyed()) {
            (tctx.win as any).__ckToggleHarness?.(true);
          }
        } catch (_) { /* ignore */ }
        // 迁移源窗口 harness 状态（历史 + 队列）到目标窗口，实现无缝接续。
        // 放在 initProject 之后：等目标 harness 就绪（若懒加载则等其创建）。
        try {
          // 暂存状态：目标 harness 可能尚未加载完（监听器未注册），
          // 由 harness-ready 信号触发推送（window-groups.ts 的 onHarnessReady）。
          if (harnessState) stageHarnessImport(targetWindowId, harnessState);
        } catch (_) { /* ignore */ }
      }, 2500);
    };
    try { twc.on('did-finish-load', onLoad); } catch (_) { /* ignore */ }
    try { await twc.loadURL(shareUrl); } catch (err: any) {
      try { twc.off('did-finish-load', onLoad); } catch (_) { /* ignore */ }
      try { cur.view.webContents.send('harness-resume-retry'); } catch (_) { /* ignore */ }
      return { success: false, error: err.message };
    }

    // 9) 焦点切到新窗口
    try { if (tctx.win && !tctx.win.isDestroyed()) tctx.win.focus(); } catch (_) { /* ignore */ }

    // 10) 记录"最后一次继续"
    try {
      setTimeout(() => {
        const sid = (tctx.sessionStore && tctx.sessionStore.state && tctx.sessionStore.state.currentSessionId) || null;
        windowGroups.setLastContinue(groupId, nextProfileId, sid);
      }, 5000);
    } catch (_) { /* ignore */ }

    // 11) 关闭限流的源窗口（避免窗口累积）。
    //     仅在"限流自动切换"时关闭；手动转移对话保留源窗口。
    //     前置校验：等目标窗口 initProject 成功后才关；失败/超时（60s）则保留源窗口，
    //     避免"目标没接上、源已关"导致对话真丢。
    if (closeSource) {
      // 不阻塞 switch 主流程返回：后台等目标就绪后再关
      Promise.race([
        targetReady,
        new Promise<boolean>((res) => setTimeout(() => res(false), 60000)),
      ]).then((ready) => {
        if (!ready) {
          console.warn('[窗口组] 目标窗口未就绪，保留源窗口（不关闭） ' + curProfileId);
          return;
        }
        setTimeout(() => {
          try {
            if (cur && cur.win && !cur.win.isDestroyed()) {
              cur.win.close();
              console.log('[窗口组] 已关闭限流的源窗口 ' + curProfileId);
            }
          } catch (err: any) {
            console.warn('[窗口组] 关闭源窗口失败:', err.message);
          }
        }, 1500); // 等焦点切到新窗口后再关，避免闪烁
      });
    }

    notifyWindowSwitch(reason, fromName, profileDisplayName(nextProfileId), true, closeSource ? '源窗口待目标就绪后关闭' : '');
    return { success: true, toProfileId: nextProfileId };
}

// 注入给 ipc 层（避免 ipc 直接依赖 entry 的 createWindow）
injectWindowGroupDeps({
  runSwitch: async (groupId: string, sender: any) => {
    const cur = (sender && windowState.getContextByWebContents(sender)) || windowState.getMainContext();
    if (!cur || !cur.win || cur.win.isDestroyed()) return { success: false, error: '无活跃窗口' };
    // 手动转移也关闭源窗口（closeSource=true），但文案保持"手动转移"
    return runSwitchForGroup(groupId, cur.profileId, true, 'manual');
  },
});

// ========== 限流触发自动切换 ==========
// 待确认的自动切换（倒计时期间可被用户取消）
const pendingAutoSwitch = new Map<number, { cancel: () => void }>();
// 正在切换中的 profileId：限流会连续触发多次 rate-limit-hit，
// 用此守卫避免并发倒计时 / 双切换（同一窗口同一时刻只处理一次）
const switchingProfiles = new Set<string>();

ipcMainForProfile.handle('harness-cancel-switch', async (event: any) => {
  const ctx = windowState.getContextByWebContents(event.sender);
  const winId = ctx && ctx.win ? ctx.win.id : null;
  if (winId != null && pendingAutoSwitch.has(winId)) {
    const p = pendingAutoSwitch.get(winId)!;
    pendingAutoSwitch.delete(winId);
    p.cancel();
    console.log('[窗口组] 用户取消自动切换');
    return { success: true, cancelled: true };
  }
  return { success: true, cancelled: false };
});

/** 自动切换前给源窗口 3s 倒计时（用户可取消）。返回是否被取消。 */
function countdownBeforeAutoSwitch(ctx: any, seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const hv = ctx && ctx.harnessView;
    const wc = hv && !hv.webContents.isDestroyed() ? hv.webContents : null;
    if (!wc || !ctx.win || ctx.win.isDestroyed()) { resolve(false); return; }
    let cancelled = false;
    const winId = ctx.win.id;
    pendingAutoSwitch.set(winId, { cancel: () => { cancelled = true; } });
    try { wc.send('harness-switch-countdown', { seconds }); } catch (_) { /* ignore */ }
    setTimeout(() => {
      if (pendingAutoSwitch.has(winId)) pendingAutoSwitch.delete(winId);
      resolve(cancelled);
    }, seconds * 1000);
  });
}

// bridge 检测到限流（429 / rate_limit）→ 上报 → 若该窗口属于某组，则触发自动切换
ipcMainForProfile.handle('rate-limit-hit', async (event: any) => {
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return { success: false };
  const profileId = ctx.profileId;
  const group = windowGroups.getGroupByWindowId(profileId);
  if (!group) {
    console.log('[窗口组] 限流，但该窗口不在任何组，不切换');
    return { success: true, switched: false, reason: 'not-in-group' };
  }
  // 去重：同一窗口已在切换流程中（倒计时/切换）→ 忽略后续重复触发
  if (switchingProfiles.has(profileId)) {
    console.log('[窗口组] 该窗口已在切换流程中，忽略重复触发 ' + profileId);
    return { success: true, switched: false, reason: 'in-progress' };
  }
  switchingProfiles.add(profileId);
  console.log('[窗口组] 限流触发自动切换，组=' + group.name);
  // 自动切换：先给源窗口 3s 倒计时（突兀切换改为可见倒计时，可取消）
  const cancelled = await countdownBeforeAutoSwitch(ctx, 3);
  if (cancelled) { switchingProfiles.delete(profileId); return { success: true, switched: false, reason: 'cancelled' }; }
  // 触发切换（复用 P2 的编排）
  try {
    const res = await runSwitchForGroup(group.id, profileId, true);
    switchingProfiles.delete(profileId);
    return { success: true, switched: !!(res && res.success), result: res };
  } catch (err: any) {
    switchingProfiles.delete(profileId);
    return { success: false, error: err.message };
  }
});

// ========== IPC 处理器 ==========
registerIpcHandlers();

// ========== 飞书同步（若已配置启用则自动连接）==========
try { initFeishu(); } catch (err: any) { console.error('[Feishu] 初始化失败:', err.message); }

// 覆盖层"新建窗口"按钮触发
ipcMainForProfile.handle('create-profile-window', async (_event: any, { providerId }: any = {}) => {
  const profiles = profileManager.readProfiles();
  // 不指定平台时创建"未确定平台"的 profile，窗口会显示平台选择页
  const pid = providerId || '';
  createWindow(profileManager.createProfile('窗口' + (profiles.length + 1), pid));
  return { success: true };
});

// 列出所有 profiles
ipcMainForProfile.handle('list-profiles', async () => {
  return { success: true, profiles: profileManager.readProfiles() };
});

// 删除指定 profile（会关闭其窗口）
ipcMainForProfile.handle('delete-profile', async (_event: any, { profileId }: any) => {
  if (!profileId) return { success: false, error: '缺少窗口ID' };
  // 关掉该 profile 的**全部**窗口（含子代理分身）
  const all = windowState.getAllWindowsByProfileId(profileId);
  for (const c of all) {
    if (c && c.win && !c.win.isDestroyed()) {
      c.win.close();
    }
  }
  const ok = profileManager.deleteProfile(profileId);
  // 清理限流缓存记录（窗口已删，缓存无意义）
  try { windowGroups.clearRateLimit(profileId); } catch (_) { /* ignore */ }
  return { success: ok, error: ok ? null : '窗口不存在' };
});

// 列出所有内置平台
ipcMainForProfile.handle('list-providers', async () => {
  const { getAllProviders } = await import('../providers/registry.js');
  return {
    success: true,
    providers: getAllProviders().map(p => ({
      id: p.id,
      name: p.name,
      custom: !!p._customPath,
      path: p._customPath || null,
    })),
  };
});

// 导入自定义 Provider（弹文件选择框，复制到 userData，并处理重名）
ipcMainForProfile.handle('import-provider', async (event: any, { replace = false }: any = {}) => {
  const win = windowState.getMainWindow();
  const result = dialog.showOpenDialogSync(win, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    title: '选择自定义 Provider 文件',
  });
  if (!result || result.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result[0];
  const { importCustomProvider } = await import('../providers/custom/loader.js');
  try {
    const res = importCustomProvider(filePath, { replace });
    if (res.exists && !replace) {
      // 同名 provider 已存在，询问是否替换
      const confirmRes = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
        title: 'Provider 已存在',
        message: '已导入过 id 为 "' + res.provider.id + '" 的 Provider，是否替换？',
      });
      if (confirmRes.response !== 1) {
        return { success: false, canceled: true };
      }
      // 用户确认替换，重新导入
      const finalRes = importCustomProvider(filePath, { replace: true });
      return { success: true, provider: { id: finalRes.provider.id, name: finalRes.provider.name, path: finalRes.targetPath } };
    }
    return { success: true, provider: { id: res.provider.id, name: res.provider.name, path: res.targetPath } };
  } catch (err: any) {
    return { success: false, error: '加载失败: ' + err.message };
  }
});

// 删除自定义 Provider（先检查是否有窗口在使用）
ipcMainForProfile.handle('remove-provider', async (_event: any, { path: filePath, providerId }: any) => {
  if (!filePath) return { success: false, error: '缺少文件路径' };

  // 检查是否有窗口正在使用该 provider
  const usingContexts = windowState.getAllContexts().filter(
    (ctx) => ctx.providerId === providerId
  );

  if (usingContexts.length > 0) {
    const profileNames = usingContexts
      .map((ctx) => {
        const profile = profileManager.getProfileById(ctx.profileId);
        return profile ? profile.name : ctx.profileId;
      })
      .join('、');
    return {
      success: false,
      error: '以下窗口正在使用此 Provider，请先在窗口管理中更换这些窗口的平台再删除：' + profileNames,
    };
  }

  const { removeCustomProviderPath } = await import('../providers/custom/loader.js');
  removeCustomProviderPath(filePath);
  return { success: true };
});

// 替换自定义 Provider（弹文件选择框，校验 id 一致后覆盖）
ipcMainForProfile.handle('replace-provider', async (event: any, { providerId }: any) => {
  if (!providerId) return { success: false, error: '缺少 providerId' };
  const win = windowState.getMainWindow();
  const result = dialog.showOpenDialogSync(win, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    title: '选择新的 Provider 文件（id 必须为 ' + providerId + '）',
  });
  if (!result || result.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result[0];
  const { replaceCustomProvider } = await import('../providers/custom/loader.js');
  try {
    const res = replaceCustomProvider(providerId, filePath);
    return { success: true, provider: { id: res.provider.id, name: res.provider.name, path: res.targetPath } };
  } catch (err: any) {
    return { success: false, error: '替换失败: ' + err.message };
  }
});

// 用户在平台选择页选择平台后，绑定 profile 并重建窗口（partition 必须随 profile 更新）
ipcMainForProfile.handle('select-platform', async (event: any, { providerId }: any) => {
  if (!providerId) return { success: false, error: '缺少平台ID' };
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '窗口上下文不存在' };

  const provider = getProvider(providerId);
  if (!provider) return { success: false, error: '平台不存在: ' + providerId };

  // 更新该窗口 profile 的 providerId 和 partition
  const updatedProfile = profileManager.updateProfileProvider(ctx.profileId, providerId);
  if (!updatedProfile) return { success: false, error: '更新 profile 失败' };
  // 切换平台：清掉旧平台的 lastUrl，避免用旧 URL 打开新平台
  profileManager.clearLastUrl(ctx.profileId);

  // 关闭旧窗口（其 session 仍是旧 partition）
  // 注意：这里销毁最后一个窗口会触发 window-all-closed，
  // 但紧接着会 createWindow 重建，故 window-all-closed 采用延迟确认避免误退。
  console.log('[Cuckoo Code] 切换平台: ' + ctx.providerId + ' -> ' + providerId + '，重建窗口');
  const oldWin = ctx.win;
  if (oldWin && !oldWin.isDestroyed()) {
    oldWin.destroy();
  }

  // 用新 profile（含新 partition）重建窗口
  createWindow(updatedProfile);
  console.log('[Cuckoo Code] 切换平台完成，当前窗口数=' + windowState.getAllWindows().length);
  return { success: true };
});

// 设置某 profile 是否"启动时默认打开"
ipcMainForProfile.handle('set-profile-auto-open', async (_event: any, { profileId, autoOpen }: any) => {
  if (!profileId) return { success: false, error: '缺少 profileId' };
  const p = profileManager.setAutoOpen(profileId, !!autoOpen);
  if (!p) return { success: false, error: '窗口不存在' };
  return { success: true };
});

// 打开指定 profile 的窗口（若已存在则聚焦）
ipcMainForProfile.handle('open-profile-window', async (_event: any, { profileId }: any) => {
  const existing = windowState.getWindowByProfileId(profileId);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    const win = existing.win;
    if (win.isMinimized()) win.restore();
    win.focus();
    return { success: true, focused: true };
  }
  const profile = profileManager.getProfileById(profileId);
  if (!profile) return { success: false, error: '窗口不存在' };
  createWindow(profile);
  return { success: true, focused: false };
});

// 更新窗口名称（提取到 DeepSeek 用户信息后）
ipcMainForProfile.handle('update-window-name', async (event: any, { displayName }: any) => {
  if (!displayName || !displayName.trim()) return { success: false };
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '窗口上下文不存在' };
  const updated = profileManager.updateProfileName(ctx.profileId, displayName);
  if (updated && ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.setTitle('Cuckoo Code Pro - ' + updated.name);
    // 同步推给壳页面状态栏（窗口名实时更新）
    try { ctx.win.webContents.send('shell-window-name-updated', updated.name); } catch (_) {}
  }
  return { success: !!updated, name: updated ? updated.name : null };
});

// ========== MCP 相关 IPC ==========

// 取事件来源窗口的 projectDir
function getProjectDirOfEvent(event: any): string | null {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    return (ctx && ctx.sessionStore && ctx.sessionStore.state.selectedProjectDir) || null;
  } catch (_) { return null; }
}

// 列出所有 MCP server（含启用状态）。scope='user' 时只返回用户级（供 UI JSON 编辑框）
ipcMainForProfile.handle('list-mcp-servers', async (event: any, opts: any = {}) => {
  if (opts && opts.scope === 'user') {
    return { success: true, servers: mcpConfig.getUserServers() };
  }
  const projectDir = getProjectDirOfEvent(event);
  const servers = mcpClient.listConfiguredServers(projectDir);
  return { success: true, servers };
});

// 添加或更新 MCP server 配置（固定写用户级）
ipcMainForProfile.handle('upsert-mcp-server', async (_event: any, { server }: any) => {
  if (!server || !server.name || !server.type) {
    return { success: false, error: 'server 配置不完整（需要 name 和 type）' };
  }
  mcpConfig.upsertServer(server);
  return { success: true };
});

// 删除 MCP server
ipcMainForProfile.handle('remove-mcp-server', async (event: any, { name }: any) => {
  const projectDir = getProjectDirOfEvent(event);
  // 断开可能存在的连接
  await mcpClient.disconnectAll().catch(() => {});
  mcpConfig.removeServer(name);
  return { success: true };
});

// 启用 MCP server（连接并拉取工具）
ipcMainForProfile.handle('enable-mcp-server', async (event: any, { name }: any) => {
  try {
    const projectDir = getProjectDirOfEvent(event);
    mcpConfig.setServerEnabled(name, true, projectDir);
    await mcpClient.connectServerByName(name, projectDir, null);
    return { success: true };
  } catch (err: any) {
    console.error('[MCP] enable 失败:', err);
    return { success: false, error: err.message };
  }
});

// 禁用 MCP server（断开连接）
ipcMainForProfile.handle('disable-mcp-server', async (event: any, { name }: any) => {
  const projectDir = getProjectDirOfEvent(event);
  mcpConfig.setServerEnabled(name, false, projectDir);
  // 简单处理：断开该 server 可能存在的连接（引用清零后由空闲计时断开）
  await mcpClient.disconnectAll().catch(() => {});
  return { success: true };
});

// 获取已启用 server 的工具列表（用于注入提示词）
ipcMainForProfile.handle('get-mcp-tools', async (event: any) => {
  const projectDir = getProjectDirOfEvent(event);
  const servers = mcpClient.listConfiguredServers(projectDir);
  const tools: any[] = [];
  for (const s of servers) {
    if (!s.connected) continue;
    try {
      const list = await mcpClient.getToolsByServer(s.name, projectDir);
      for (const t of list) tools.push({ server: s.name, ...t });
    } catch (_) {}
  }
  return { success: true, tools };
});

// ========== 单实例锁 ==========
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWindow = windowState.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 更新进行中门禁：静默安装期间用户若再次双击旧 exe，会与安装程序争用文件。
    // 命中标记 → 提示并退出，等新版本启动后自动放行（见 updater.isUpdatePending）。
    try {
      if (updater.isUpdatePending()) {
        dialog.showMessageBoxSync({
          type: 'info',
          title: '更新进行中',
          message: 'Cuckoo Code 正在更新，请稍候…',
          detail: '更新完成后应用会自动重启，无需手动操作。',
          buttons: ['知道了'],
        });
        app.quit();
        return;
      }
    } catch (_) { /* ignore */ }
    setupAppMenu();
    // 首次启动写入默认全局规则（用户已有规则则不覆盖）
    try { seedDefaultRules(); } catch (_) { /* ignore */ }
    // MCP 配置首次迁移（旧 userData/mcp.json → ~/.cuckoo/mcp.json，旧文件保留）
    try { mcpConfig.migrateLegacy(); } catch (_) { /* ignore */ }
    // 加载已启用的 Cuckoo 插件（DSH 兼容；注册其工具到全局工具表）
    import('../plugins/cuckoo-plugins/index.js').then((m: any) => {
      import('../tools/index.js').then((t: any) => {
        import('./cuckoo-host.js').then((h: any) => {
        m.loadEnabledPlugins(t.registry, h.buildCuckooHost()).then((r: any) => {
          if (r.loaded.length || r.failed.length) {
            console.log('[Cuckoo Plugin] 已加载: ' + (r.loaded.join(' | ') || '(无)') +
              (r.failed.length ? '；失败: ' + r.failed.map((f: any) => f.id + ':' + f.error).join(' | ') : ''));
          }
        }).catch((e: any) => console.error('[Cuckoo Plugin] 加载失败:', e && e.message));
        }).catch(() => {});
      });
    }).catch(() => {});
    // 清理子代理窗口遗留的 session 存储文件（历史 bug：子代理不需要持久化）
    try { profileManager.cleanupSubagentStores(); } catch (_) { /* ignore */ }
    // 启动时打开所有"默认打开"的窗口；若一个都没勾，回退默认（上次活跃的或第一个）
    const autoOpen = profileManager.getAutoOpenProfiles();
    if (autoOpen.length > 0) {
      console.log('[Cuckoo Code] 启动默认打开 ' + autoOpen.length + ' 个窗口');
      for (const p of autoOpen) createWindow(p);
    } else {
      createWindow(null);
    }

    });
}

app.on('window-all-closed', () => {
  // 切换平台时会先销毁旧窗口（select-platform）再创建新窗口，
  // 这个间隙窗口数会短暂为 0，若直接 quit 会导致闪退。
  // 延迟确认：稍后仍无窗口才真正退出。
  setTimeout(() => {
    if (windowState.getAllWindows().length === 0) {
      app.quit();
    }
  }, 500);
});

// 退出前刷新所有 session 数据 + 断开所有 MCP 连接
let quitFlushed = false;
app.on('before-quit', (event: any) => {
  if (quitFlushed) return;
  event.preventDefault();
  quitFlushed = true;
  // 杀掉所有后台任务进程树，防孤儿进程
  try { taskManager.dispose(); } catch (_) { /* ignore */ }
  Promise.all([
    flushAllSessions().catch(() => {}),
    mcpClient.disconnectAll().catch(() => {}),
  ]).finally(() => {
    app.quit();
  });
});

app.on('activate', () => {
  if (windowState.getAllWindows().length === 0) {
    createWindow(null);
  }
});
