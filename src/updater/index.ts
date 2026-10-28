/**
 * Cuckoo Code 自动更新模块
 * 使用 electron-updater + generic provider（GitHub Releases）检查并下载更新。
 * 职责：检查更新、下载进度提示、下载完成提醒、网络错误友好提示。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import updaterPkg from 'electron-updater';
import { showSystemNotification } from '../app/notification-window.js';
// electron 特殊：其 index.js 导出字符串，须用 createRequire（见 P3a 手册 1.5）
const require = createRequire(import.meta.url);
const { app, dialog } = require('electron');
const { autoUpdater } = updaterPkg;

// ========== 日志配置 ==========
// 打包版禁用文件日志持久化：不加载 electron-log，也不写文件
if (app.isPackaged) {
  autoUpdater.logger = console;
} else {
  const { default: log } = await import('electron-log');
  autoUpdater.logger = log;
  (autoUpdater.logger as any).transports.file.level = 'info';
}
autoUpdater.autoDownload = false; // 检测到更新后不自动下载，等用户确认
autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装（支持 NSIS）

// ========== 状态标志 ==========
let updateDownloaded = false;    // 是否已下载完成
let isDownloading = false;       // 是否正在下载（防并发锁）
let isChecking = false;          // 是否正在检查更新（防并发锁）
let isInstalling = false;        // 是否正在发起安装（防并发）
let downloadedVersion = '';      // 已下载的新版本号（供安装时写标记）
let isManualCheck = false;       // 是否是用户手动触发的检查
let autoInstallAfterDownload = false; // 下载完成后是否自动重启安装（用户选了"立即更新"）
let mainWindowRef: any = null;   // 主窗口引用（用于弹出对话框）
let lastProgressTime = 0;        // 最近一次下载进度时间（防误判）

/** 设置主窗口引用，用于对话框定位 */
function setMainWindow(win: any): void {
  mainWindowRef = win;
}

// ========== 更新进行中标记（并发保护） ==========
// 静默安装期间应用会退出、文件正被替换，若用户此时再双击旧图标启动，
// 会与安装程序争用文件锁 → 安装失败 / 版本混乱。用标记文件做"门禁"。
const UPDATE_PENDING_TTL_MS = 10 * 60 * 1000; // 标记有效期 10 分钟（安装远超此值视为异常，放行）

function updatePendingPath(): string {
  try { return path.join(app.getPath('userData'), 'update-pending.json'); }
  catch (_) { return ''; }
}

/** 安装前写标记：记录目标版本，供下次启动判断更新是否已完成 */
function markUpdatePending(targetVersion?: string): void {
  const p = updatePendingPath();
  if (!p) return;
  try {
    // 记录「安装前版本」fromVersion + 「目标版本」targetVersion。
    // 启动时以 fromVersion 为准判断版本是否已变（比单看 target 更稳，
    // 即使 target 为空/缺失也能正确放行）。
    const payload = JSON.stringify({
      fromVersion: app.getVersion(),
      targetVersion: targetVersion || '',
      at: Date.now(),
    });
    // 原子写：先写临时文件再 rename，避免崩溃残留半截 JSON
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err: any) {
    console.error('[Updater] 写更新标记失败:', err && err.message);
  }
}

/**
 * 启动时检查是否有"未完成的更新"。
 * 放行条件（任一）：标记不存在 / 已过期 / 当前版本与「安装前版本」不同（说明更新已发生）/
 *                  当前版本已达目标版本 / 标记数据不完整（!from 且 !target，避免锁死）。
 * 命中（未完成）返回 true（调用方提示并退出）；否则清理标记并返回 false。
 */
function isUpdatePending(): boolean {
  const p = updatePendingPath();
  if (!p || !fs.existsSync(p)) return false;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw);
    const from: string = String(data && data.fromVersion || '');
    const target: string = String(data && data.targetVersion || '');
    const at: number = Number(data && data.at || 0);
    const current = app.getVersion();
    const expired = !at || (Date.now() - at > UPDATE_PENDING_TTL_MS);
    // 版本已变（安装前 → 现在）说明更新已发生：放行
    const versionChanged = !!from && current !== from;
    // 已达目标版本：放行
    const reachedTarget = !!target && current === target;
    // 数据不完整（既无 from 又无 target）：无法判断 → 放行，避免锁死
    const incomplete = !from && !target;
    // 如果标记还在，且版本没变，但已经过了 3 分钟：
    // 正常静默安装只需十几秒，超过 3 分钟通常是因为用户拒绝了 UAC 授权。
    // 此时不应将用户锁死 10 分钟，直接判定为安装失败并放行。
    const installFailed = !!from && current === from && (Date.now() - at > 180000);
    if (expired || versionChanged || reachedTarget || incomplete || installFailed) {
      try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
      return false;
    }
    return true;
  } catch (_) {
    // 标记损坏：清理并放行，避免卡死启动
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    return false;
  }
}

/** 清理更新标记（更新成功后由新版本启动时也可主动调用） */
function clearUpdatePending(): void {
  const p = updatePendingPath();
  if (!p) return;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

/**
 * 统一的"安装并重启"入口：写标记（并发保护）+ 静默安装。
 * isSilent=true 传 /S 跳过 NSIS 向导；isForceRunAfter=true 装完自动重启。
 */
function installAndRestart(targetVersion?: string): void {
  if (isInstalling) return;
  isInstalling = true;
  markUpdatePending(targetVersion);
  try { 
    autoUpdater.quitAndInstall(true, true); 
  } catch (err: any) {
    console.error('[Updater] quitAndInstall 失败:', err && err.message);
    clearUpdatePending(); // 安装没发起，清标记避免误拦下次启动
    isInstalling = false;
  }
}

/** 判断错误是否为网络连接类问题 */
function isNetworkError(error: any): boolean {
  const msg = String(error && (error.message || error.stack) || '').toLowerCase();
  const networkKeywords = [
    'net::err',
    'err_connection',
    'err_name_not_resolved',
    'err_internet_disconnected',
    'err_network_changed',
    'err_proxy_connection_failed',
    'err_tunnel_connection_failed',
    'enotfound',
    'etimedout',
    'econnrefused',
    'econnreset',
    'cert_authority_invalid',
    'cert_common_name_invalid',
    'cert_date_invalid',
    'unable to resolve',
    'connect timeout',
    'network is unreachable',
    'socket hang up',
    'tls handshake',
  ];
  return networkKeywords.some((kw) => msg.includes(kw));
}

/** 判断错误是否为 GitHub 访问受限类问题 */
function isGitHubAccessError(error: any): boolean {
  const msg = String(error && (error.message || error.stack) || '').toLowerCase();
  const githubKeywords = [
    '403',
    '404',
    'rate limit',
    'api.github.com',
    'github',
    'forbidden',
    'unauthorized',
  ];
  return githubKeywords.some((kw) => msg.includes(kw));
}

/** 把更新进度推送给壳页面（状态栏进度条） */
function sendProgress(data: any): void {
  try {
    if (mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
      mainWindowRef.webContents.send('shell-update-progress', data);
    }
  } catch (_) { /* ignore */ }
}

/** 显示系统通知浮窗（自绘，右下角，沿用限流浮窗视觉；不打断用户） */
function showNotification(title: string, body: string, kind: 'info' | 'update' = 'info'): void {
  try {
    showSystemNotification({ kind, title, body, durationMs: 4200 });
  } catch (_) { /* ignore */ }
}

/**
 * 弹出原生模态对话框（屏幕中央，跟随父窗口）。
 *
 * 需求 068 已定边界：dialog.showMessageBox 属"要求用户选择的模态决策"，
 * 保持系统原生，不做自绘（自绘只用于被动通知）。需求 077 曾把它一并改成
 * 自绘浮窗，此处回退到原生，符合 068 原始设计。
 *
 * @returns 用户点击的按钮索引（0 = 主按钮）
 */
async function showNativeDialog(opts: {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}): Promise<number> {
  const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  const options = {
    type: opts.type || 'info',
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    buttons: opts.buttons,
    defaultId: opts.defaultId ?? 0,
    cancelId: opts.cancelId ?? opts.buttons.length - 1,
  };
  // macOS 上必须传 parent，否则弹窗可能被隐藏
  const res = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return typeof res === 'object' && res ? res.response : (opts.cancelId ?? opts.buttons.length - 1);
}

/** 弹出更新失败对话框，提供重试/取消选项 */
async function showUpdateErrorDialog(error: any, isManual: boolean): Promise<boolean> {
  // 自动检查失败时，静默提示即可，不弹对话框打扰用户
  if (!isManual) {
    const detail = isNetworkError(error) || isGitHubAccessError(error)
      ? '无法连接到更新服务器（GitHub），请检查网络连接。'
      : '发生未知错误，请稍后重试。';
    showNotification('检查更新失败', detail);
    return false; // 自动检查失败不弹对话框
  }

  // 手动检查失败时，弹出对话框并给出详细原因
  let message = '检查更新失败';
  let detail = '';
  if (isNetworkError(error)) {
    message = '无法连接到更新服务器';
    detail = '请检查网络连接。更新服务器位于 GitHub，可能需要代理或 VPN 才能访问。\n\n错误信息：' + (error.message || '');
  } else if (isGitHubAccessError(error)) {
    message = '无法访问 GitHub 更新服务器';
    detail = 'GitHub 访问受限或更新资源不存在。请确认仓库名称和发布版本正确。\n\n错误信息：' + (error.message || '');
  } else {
    detail = '发生未知错误。\n\n错误信息：' + (error.message || '');
  }

  // 原生模态对话框：主按钮=重试
  const idx = await showNativeDialog({
    type: 'error',
    title: '更新失败',
    message,
    detail,
    buttons: ['重试', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  return idx === 0;
}

/** 手动检查更新入口 */
async function checkForUpdates(): Promise<void> {
  if (isChecking) {
    showNotification('检查中', '正在检查更新，请稍候…');
    return;
  }
  if (isDownloading) {
    if (lastProgressTime && Date.now() - lastProgressTime > 15 * 60 * 1000) {
      console.warn('[Updater] 下载疑似死锁超时（15分钟无进展），重置状态放行');
      isDownloading = false;
    } else {
      showNotification('正在下载', '更新正在下载中，请稍候…');
      return;
    }
  }
  if (updateDownloaded) {
    // 已有下载完成的更新，直接提示安装（原生模态对话框）
    const idx = await showNativeDialog({
      type: 'info',
      title: '更新已就绪',
      message: '新版本已下载完成',
      detail: '是否立即重启应用并安装更新？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (idx === 0) {
      // 静默安装（/S 跳过 NSIS 向导）+ 装完自动重启（带并发保护标记）
      installAndRestart(downloadedVersion);
    }
    return;
  }

  isManualCheck = true;
  isChecking = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error: any) {
    console.error('[Updater] 检查更新异常:', error);
    isChecking = false; // 兜底复位，防止 error 事件未触发导致永久卡死
    // 错误统一由 autoUpdater.on('error') 处理，这里不重复弹窗
  }
}

// ========== 注册 autoUpdater 事件 ==========

autoUpdater.on('checking-for-update', () => {
  console.log('[Updater] 正在检查更新...');
  if (isManualCheck) {
    showNotification('检查更新', '正在检查是否有新版本...');
  }
});

autoUpdater.on('update-available', async (info: any) => {
  console.log('[Updater] 发现新版本:', info.version);
  isChecking = false;
  if (isDownloading) {
    console.log('[Updater] 已在下载中，忽略重复的 update-available 事件');
    return;
  }
  // 先上锁，避免弹窗等待期间触发二次检查或二次下载
  isDownloading = true;
  lastProgressTime = Date.now();
  // 原生模态对话框（屏幕中央）。下载进度由壳页面状态栏展示，不在此弹窗内。
  const idx = await showNativeDialog({
    type: 'info',
    title: '发现新版本',
    message: '发现新版本 v' + info.version,
    detail: '是否立即更新？将自动下载并重启安装。',
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (idx === 0) {
    // 用户选「立即更新」→ 自动下载，下载完自动重启安装（见 update-downloaded）
    autoInstallAfterDownload = true;
    lastProgressTime = Date.now();
    showNotification('开始更新', '正在下载 v' + info.version + '…', 'update');
    sendProgress({ state: 'downloading', percent: 0, version: info.version });
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[Updater] 下载失败:', err);
      autoInstallAfterDownload = false;
      isDownloading = false;
    });
  } else {
    // 用户选「稍后」→ 不下载
    isManualCheck = false;
    isDownloading = false; // 释放锁
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] 已是最新版本');
  isChecking = false;
  if (isManualCheck) {
    showNotification('已是最新版本', '当前已是最新版本。');
  }
  isManualCheck = false;
});

autoUpdater.on('download-progress', (progressObj: any) => {
  lastProgressTime = Date.now();
  const percent = Math.round(progressObj.percent);
  console.log('[Updater] 下载进度:', percent + '%');
  // 只推给壳页面状态栏（实时进度条），不弹系统通知——
  // 进度每几秒变化一次，频繁弹通知会打扰用户；状态栏已实时展示，足够。
  sendProgress({
    state: 'downloading',
    percent,
    transferred: progressObj.transferred || 0,
    total: progressObj.total || 0,
    bytesPerSecond: progressObj.bytesPerSecond || 0,
  });
});

autoUpdater.on('update-downloaded', (info: any) => {
  isDownloading = false;
  isChecking = false;
  updateDownloaded = true;
  downloadedVersion = (info && info.version) || '';
  console.log('[Updater] 新版本已下载:', info.version);
  sendProgress({ state: 'done', percent: 100, version: info.version });

  // 用户在"发现新版本"时选了"立即更新" → 自动重启安装，不再二次询问
  if (autoInstallAfterDownload) {
    autoInstallAfterDownload = false;
    console.log('[Updater] 自动安装并重启');
    setTimeout(() => {
      // 静默安装（/S 跳过 NSIS 向导）+ 装完自动重启
      installAndRestart(info && info.version);
    }, 800);
    return;
  }

  // 否则（后台自动检查下载完成）弹原生对话框询问是否立即安装
  showNativeDialog({
    type: 'info',
    title: '更新已就绪',
    message: '新版本 v' + info.version + ' 已下载完成',
    detail: '是否立即重启应用并安装更新？',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then((idx) => {
    isManualCheck = false;
    if (idx === 0) {
      // 静默安装（/S 跳过 NSIS 向导）+ 装完自动重启
      installAndRestart(info && info.version);
    }
  });
});

autoUpdater.on('error', async (error: any) => {
  isDownloading = false;
  isChecking = false;
  isInstalling = false;
  console.error('[Updater] 更新错误:', error);
  sendProgress({ state: 'error', error: (error && error.message) || '更新出错' });
  const shouldRetry = await showUpdateErrorDialog(error, isManualCheck);
  if (shouldRetry) {
    // 用户点击重试
    isManualCheck = true;
    isChecking = true;
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[Updater] 重试检查更新失败:', err);
        isManualCheck = false;
        isChecking = false;
      });
    }, 1000);
  } else {
    isManualCheck = false;
  }
});

// ========== 启动时自动检查 ==========
function initAutoUpdater(win: any): void {
  setMainWindow(win);

  // 仅在生产环境（打包后）才检查更新
  if (!app.isPackaged) {
    console.log('[Updater] 开发环境，跳过自动检查更新');
    return;
  }

  // 应用启动后延迟 5 秒检查，避免影响启动速度
  setTimeout(() => {
    console.log('[Updater] 启动自动检查更新');
    if (isChecking || isDownloading || updateDownloaded) {
      console.log('[Updater] 正在检查/下载/已下载，跳过启动自动检查');
      return;
    }
    isChecking = true;
    autoUpdater.checkForUpdates().catch((error: any) => {
      isChecking = false;
      console.error('[Updater] 启动检查更新失败:', error);
    });
  }, 5000);
}

export {
  initAutoUpdater,
  checkForUpdates,
  setMainWindow,
  isNetworkError,
  isGitHubAccessError,
  isUpdatePending,
  clearUpdatePending,
};
