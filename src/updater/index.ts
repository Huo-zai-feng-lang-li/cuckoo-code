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
import { showConfirmDialog, updateConfirmProgress, closeConfirmDialog } from '../app/confirm-window.js';

// electron 特殊：其 index.js 导出字符串，须用 createRequire（见 P3a 手册 1.5）
const require = createRequire(import.meta.url);
const { app } = require('electron');
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
let updateChecked = false;       // 是否已执行过检查
let updateDownloaded = false;    // 是否已下载完成
let downloadedVersion = '';      // 已下载的新版本号（供安装时写标记）
let isManualCheck = false;       // 是否是用户手动触发的检查
let autoInstallAfterDownload = false; // 下载完成后是否自动重启安装（用户选了"立即更新"）
let mainWindowRef: any = null;   // 主窗口引用（用于弹出对话框）

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
    if (expired || versionChanged || reachedTarget || incomplete) {
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
  markUpdatePending(targetVersion);
  try { autoUpdater.quitAndInstall(true, true); } catch (err: any) {
    console.error('[Updater] quitAndInstall 失败:', err && err.message);
    clearUpdatePending(); // 安装没发起，清标记避免误拦下次启动
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

/** HTML 转义（渲染端用 innerHTML 显示日志，防注入） */
function escapeHtml(s: string): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * GitHub 的 releaseNotes 实为 HTML 片段（atom feed 的 content 字段），
 * 也可能被替换为纯 Markdown。统一转纯文本：
 * 块级标签 → 换行，剥其余标签，解码常见实体（&amp; 放最后，防二次解码）。
 */
function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*(p|div|li|ul|ol|h[1-6]|tr|section|article|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#0*39|#x27|apos);/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&');
}

/** 从 UpdateInfo 提取更新日志条目（最多 5 条；兼容 HTML/Markdown，剥前缀、截断过长行） */
function extractReleaseNotes(info: any): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const t = String(raw || '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .trim();
    if (t) out.push(escapeHtml(t));
  };
  try {
    const rn = info && info.releaseNotes;
    if (typeof rn === 'string') {
      htmlToText(rn).split(/\r?\n/).forEach(push);
    } else if (Array.isArray(rn)) {
      rn.forEach((item) => {
        const note = item && item.note;
        if (typeof note === 'string') htmlToText(note).split(/\r?\n/).forEach(push);
      });
    }
  } catch (_) { /* ignore */ }
  return out.slice(0, 5).map((s) => (s.length > 80 ? s.slice(0, 78) + '…' : s));
}

/** 从 UpdateInfo 的文件列表算总体积（MB）；拿不到返回空串 */
function formatSize(info: any): string {
  try {
    const files = (info && info.files) || [];
    let total = 0;
    files.forEach((f: any) => { if (f && typeof f.size === 'number') total += f.size; });
    if (total <= 0) return '';
    const mb = total / (1024 * 1024);
    return mb >= 100 ? Math.round(mb) + ' MB' : mb.toFixed(1) + ' MB';
  } catch (_) { return ''; }
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

  // 自绘确认框（取代 dialog.showMessageBox）：主按钮=重试
  return await showConfirmDialog({
    kind: 'error',
    title: '更新失败',
    body: message,
    detail,
    primaryText: '重试',
    secondaryText: '取消',
  });
}

/** 手动检查更新入口 */
async function checkForUpdates(): Promise<void> {
  if (updateDownloaded) {
    // 已有下载完成的更新，直接提示安装（自绘确认框）
    const ok = await showConfirmDialog({
      kind: 'update',
      title: '更新已就绪',
      body: '新版本已下载完成，是否立即重启应用并安装？',
      primaryText: '立即重启',
      secondaryText: '稍后',
    });
    if (ok) {
      // 静默安装（/S 跳过 NSIS 向导）+ 装完自动重启（带并发保护标记）
      installAndRestart(downloadedVersion);
    }
    return;
  }

  isManualCheck = true;
  updateChecked = false;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error: any) {
    console.error('[Updater] 检查更新异常:', error);
    await showUpdateErrorDialog(error, true);
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
  const curVersion = app.getVersion();
  const notes = extractReleaseNotes(info);
  const sizeText = formatSize(info);
  const ok = await showConfirmDialog({
    kind: 'update',
    title: '发现新版本 v' + info.version,
    body: '是否立即更新？将自动下载并重启安装。',
    primaryText: '立即更新',
    secondaryText: '稍后',
    version: curVersion,
    newVersion: info.version,
    notes,
    sizeText,
    keepOpenOnPrimary: true,   // 点「立即更新」后保留窗口实时显示下载进度
  });
  if (ok) {
    // 用户选「立即更新」→ 自动下载，下载完自动重启安装（见 update-downloaded）
    autoInstallAfterDownload = true;
    showNotification('开始更新', '正在下载 v' + info.version + '…', 'update');
    sendProgress({ state: 'downloading', percent: 0, version: info.version });
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[Updater] 下载失败:', err);
      autoInstallAfterDownload = false;
      try { closeConfirmDialog(); } catch (_) { /* ignore */ }
    });
  } else {
    // 用户选「稍后」→ 不下载
    isManualCheck = false;
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] 已是最新版本');
  if (isManualCheck) {
    showNotification('已是最新版本', '当前已是最新版本。');
  }
  isManualCheck = false;
});

autoUpdater.on('download-progress', (progressObj: any) => {
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
  // 同步到更新确认弹窗（如果窗口还开着）
  updateConfirmProgress(percent);
});

autoUpdater.on('update-downloaded', (info: any) => {
  updateDownloaded = true;
  downloadedVersion = (info && info.version) || '';
  console.log('[Updater] 新版本已下载:', info.version);
  sendProgress({ state: 'done', percent: 100, version: info.version });

  // 用户在"发现新版本"时选了"立即更新" → 自动重启安装，不再二次询问
  if (autoInstallAfterDownload) {
    autoInstallAfterDownload = false;
    console.log('[Updater] 自动安装并重启');
    try { closeConfirmDialog(); } catch (_) { /* ignore */ }
    setTimeout(() => {
      // 静默安装（/S 跳过 NSIS 向导）+ 装完自动重启
      installAndRestart(info && info.version);
    }, 800);
    return;
  }

  // 否则（后台自动检查下载完成）弹确认框询问是否立即安装
  showConfirmDialog({
    kind: 'update',
    title: '更新已就绪',
    body: '新版本 v' + info.version + ' 已下载完成，是否立即重启应用并安装？',
    primaryText: '立即重启',
    secondaryText: '稍后',
  }).then((ok) => {
    isManualCheck = false;
    if (ok) {
      // 静默安装（/S 跳过 NSIS 向导）+ 装完自动重启
      installAndRestart(info && info.version);
    }
  });
});

autoUpdater.on('error', async (error: any) => {
  console.error('[Updater] 更新错误:', error);
  sendProgress({ state: 'error', error: (error && error.message) || '更新出错' });
  const shouldRetry = await showUpdateErrorDialog(error, isManualCheck);
  if (shouldRetry) {
    // 用户点击重试
    isManualCheck = true;
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[Updater] 重试检查更新失败:', err);
        isManualCheck = false;
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
    autoUpdater.checkForUpdates().catch((error: any) => {
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
