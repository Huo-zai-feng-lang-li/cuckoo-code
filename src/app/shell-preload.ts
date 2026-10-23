/**
 * 地址栏壳页面 preload（与 AI 页面 preload 分离）
 * 暴露 window.shellAPI：导航控制 + 地址变化订阅。不能有顶层 await（P3a 教训）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

// 平台（主进程经 additionalArguments 传入）：mac 上保留系统红绿灯、隐藏自绘窗口按钮
const platformArg = (process.argv || []).find((a) => a.startsWith('--cuckoo-platform='));
const platform = platformArg ? platformArg.slice('--cuckoo-platform='.length) : process.platform;

const shellAPI = {
  platform,
  navigate: (url: string) => ipcRenderer.invoke('shell-navigate', { url }),
  back: () => ipcRenderer.invoke('shell-back'),
  forward: () => ipcRenderer.invoke('shell-forward'),
  reload: () => ipcRenderer.invoke('shell-reload'),
  home: () => ipcRenderer.invoke('shell-home'),
  onWindowSwitch: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-window-switch', (_e: any, data: any) => cb(data));
  },
  onUpdateProgress: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-update-progress', (_e: any, data: any) => cb(data));
  },
  onUrlUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-url-updated', (_e: any, data: any) => cb(data));
  },
  onTokenUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-token-updated', (_e: any, data: any) => cb(data));
  },
  onTpsUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-tps-updated', (_e: any, data: any) => cb(data));
  },
  onTotalUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-total-updated', (_e: any, data: any) => cb(data));
  },
  getSystemTotal: () => ipcRenderer.invoke('get-system-total'),
  getWindowUsage: () => ipcRenderer.invoke('get-window-usage'),
  onWindowUsage: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-window-usage', (_e: any, data: any) => cb(data));
  },
  getWindowName: () => ipcRenderer.invoke('shell-get-window-name'),
  onWindowNameUpdated: (cb: (name: string) => void) => {
    ipcRenderer.on('shell-window-name-updated', (_e: any, name: any) => cb(name));
  },
  getProjectDir: () => ipcRenderer.invoke('get-project-dir'),
  // 点击"项目目录" → 弹目录选择框 + 重新初始化（复用 init-project 通道）
  initProject: () => ipcRenderer.invoke('init-project', {}),
  onProjectDir: (cb: (dir: string | null) => void) => {
    ipcRenderer.on('shell-project-dir', (_e: any, dir: any) => cb(dir));
  },
  toggleSidebar: (width: number) => ipcRenderer.invoke('shell-toggle-sidebar', { width }),
  // 临时隐藏 AI 视图（WebContentsView 是原生视图，CSS z-index 盖不住它）
  // 用途：壳页面开全屏 Lightbox / 模态框时，避免被 AI 页面挡住
  setWebViewVisible: (visible: boolean) => ipcRenderer.invoke('plugin-set-webview-visible', { visible }),

  // 侧边栏拖拽调宽（AI 视图会临时移出，鼠标事件全落在壳页面；主进程轮询算宽度后推回）
  startSidebarDrag: () => ipcRenderer.send('shell-sidebar-drag-start'),
  endSidebarDrag: () => ipcRenderer.send('shell-sidebar-drag-end'),
  onSidebarDrag: (cb: (width: number) => void) => {
    ipcRenderer.on('shell-sidebar-drag', (_e: any, width: any) => cb(width));
  },
  // ========== 侧栏「对话」分页：读网页会话列表 + 导航 ==========
  listWebSessions: () => ipcRenderer.invoke('web-list-sessions'),
  navigateWebSession: (url: string) => ipcRenderer.invoke('web-navigate-session', { url }),
  newWebConversation: () => ipcRenderer.invoke('web-new-conversation'),
  onWebUrlChanged: (cb: () => void) => { ipcRenderer.on('shell-web-url-changed', () => cb()); },
  onHarnessBusy: (cb: (busy: boolean) => void) => { ipcRenderer.on('shell-harness-busy', (_e: any, d: any) => cb(!!(d && d.busy))); },
  // 新建对话完成（成功/失败/无项目导航完）→ 隐藏 loading 遮罩
  onNewConvDone: (cb: () => void) => { ipcRenderer.on('shell-newconv-done', () => cb()); },
  // 应用菜单动作（新对话 / 选目录新对话）
  onMenuAction: (cb: (data: { action: string }) => void) => {
    ipcRenderer.on('shell-menu-action', (_e: any, data: any) => cb(data || {}));
  },
  // 纯净对话模式（Harness）切换 + 状态订阅
  toggleHarness: () => ipcRenderer.invoke('shell-toggle-harness'),
  setWebviewHidden: (hidden: boolean) => ipcRenderer.invoke('shell-set-webview-hidden', { hidden }),
  onHarnessMode: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-harness-mode', (_e: any, data: any) => cb(data));
  },
  // 插件界面挂载（主进程 → 壳页面）
  onPluginShellMount: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-plugin-mount', (_e: any, data: any) => cb(data));
  },
  // 拉取"已缓存的插件挂载"（壳页面就绪后补渲染）
  listPluginShellMounts: () => ipcRenderer.invoke('plugin-shell-list'),
  // 插件注入壳页面 CSS
  onPluginShellStyle: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-plugin-style', (_e: any, data: any) => cb(data));
  },
  onPluginShellStyleRemove: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-plugin-style-remove', (_e: any, data: any) => cb(data));
  },
  listPluginShellStyles: () => ipcRenderer.invoke('plugin-shell-style-list'),
  // 插件背景图（基座对齐）
  onShellBackground: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-background', (_e: any, data: any) => cb(data));
  },
  getShellBackground: () => ipcRenderer.invoke('plugin-shell-background-list'),
  // 命令（插件命令，工具栏按钮等触发）
  commandInvoke: (commandId: string) => ipcRenderer.invoke('plugin-command-invoke', { commandId }),
  commandList: () => ipcRenderer.invoke('plugin-command-list'),
  // 通用槽位
  onPluginSlotRegister: (cb: (m: any) => void) => { ipcRenderer.on('shell-slot-register', (_e: any, m: any) => cb(m)); },
  onPluginSlotUnregister: (cb: (m: any) => void) => { ipcRenderer.on('shell-slot-unregister', (_e: any, m: any) => cb(m)); },
  listPluginSlots: () => ipcRenderer.invoke('plugin-slot-list'),
  // 插件配置
  pluginConfigGet: (pluginId: string) => ipcRenderer.invoke('plugin-config-get', { pluginId }),
  pluginConfigSet: (pluginId: string, values: any) => ipcRenderer.invoke('plugin-config-set', { pluginId, values }),
  // 插件主进程函数调用（插件注册 globalThis.__cuckooPluginHostFns[pluginId + ':' + fn]）
  // 用途：壳页面是 file://，fetch http://127.0.0.1 会被代理/CORS 拦；走 IPC 拿插件运行时数据。
  pluginHostCall: (pluginId: string, fn: string, args?: any) => ipcRenderer.invoke('plugin-host-call', { pluginId, fn, args }),
  // 壳页面上报真实可视尺寸（供主进程精确布局 WebContentsView，避免菜单栏高度误差）
  reportShellSize: (w: number, h: number) => ipcRenderer.send('shell-report-size', { w, h }),
  // ========== 窗口组 ==========
  wgList: () => ipcRenderer.invoke('wg-list'),
  wgCreate: (name?: string) => ipcRenderer.invoke('wg-create', { name }),
  wgAddWindow: (groupId: string, windowId: string) => ipcRenderer.invoke('wg-add-window', { groupId, windowId }),
  wgRemoveWindow: (groupId: string, windowId: string) => ipcRenderer.invoke('wg-remove-window', { groupId, windowId }),
  wgRename: (groupId: string, name: string) => ipcRenderer.invoke('wg-rename', { groupId, name }),
  wgDelete: (groupId: string) => ipcRenderer.invoke('wg-delete', { groupId }),
  wgSwitch: (groupId: string) => ipcRenderer.invoke('wg-switch', { groupId }),
  // ========== 窗口管理 ==========
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  listProviders: () => ipcRenderer.invoke('list-providers'),
  createProfileWindow: (providerId?: string) => ipcRenderer.invoke('create-profile-window', { providerId }),
  openProfileWindow: (profileId: string) => ipcRenderer.invoke('open-profile-window', { profileId }),
  deleteProfileWindow: (profileId: string) => ipcRenderer.invoke('delete-profile', { profileId }),
  setProfileAutoOpen: (profileId: string, autoOpen: boolean) => ipcRenderer.invoke('set-profile-auto-open', { profileId, autoOpen }),
  renameProfile: (profileId: string, name: string) => ipcRenderer.invoke('rename-profile', { profileId, name }),
  // ========== 会话（侧边栏「工作区」页）==========
  listAllSessions: () => ipcRenderer.invoke('list-all-sessions'),
  navigateSession: (sessionId: string) => ipcRenderer.invoke('navigate-session', { sessionId }),
  setSessionArchived: (sessionId: string, archived: boolean) => ipcRenderer.invoke('set-session-archived', { sessionId, archived }),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('delete-session', { sessionId }),
  getDirInfo: (dir: string) => ipcRenderer.invoke('get-dir-info', { dir }),
  // 项目文件树（只读浏览）
  listProjectTree: () => ipcRenderer.invoke('list-project-tree'),
  readProjectFile: (relPath: string) => ipcRenderer.invoke('read-project-file', { relPath }),
  writeProjectFile: (relPath: string, content: string) => ipcRenderer.invoke('write-project-file', { relPath, content }),
  watchProjectFile: (relPath: string) => ipcRenderer.invoke('watch-project-file', { relPath }),
  unwatchProjectFile: () => ipcRenderer.invoke('unwatch-project-file'),
  onProjectFileChanged: (cb: (data: any) => void) => {
    ipcRenderer.on('project-file-changed', (_e: any, data: any) => cb(data));
  },
  openFileExternal: (relPath: string) => ipcRenderer.invoke('open-project-file-external', { relPath }),
  createProjectEntry: (parentRel: string, name: string, isDir: boolean) => ipcRenderer.invoke('create-project-entry', { parentRel, name, isDir }),
  renameProjectEntry: (relPath: string, newName: string) => ipcRenderer.invoke('rename-project-entry', { relPath, newName }),
  deleteProjectEntry: (relPath: string) => ipcRenderer.invoke('delete-project-entry', { relPath }),
  gitShowFile: (relPath: string) => ipcRenderer.invoke('git-show-file', { relPath }),
  gitStatus: () => ipcRenderer.invoke('git-status'),
  gitStage: (relPath: string) => ipcRenderer.invoke('git-stage', { relPath }),
  gitUnstage: (relPath: string) => ipcRenderer.invoke('git-unstage', { relPath }),
  gitStageAll: () => ipcRenderer.invoke('git-stage-all'),
  gitUnstageAll: () => ipcRenderer.invoke('git-unstage-all'),
  gitRestore: (relPath: string) => ipcRenderer.invoke('git-restore', { relPath }),
  gitDiscardAll: () => ipcRenderer.invoke('git-discard-all'),
  gitDiscardUntracked: (relPath: string) => ipcRenderer.invoke('git-discard-untracked', { relPath }),
  gitCommit: (message: string) => ipcRenderer.invoke('git-commit', { message }),
  gitCurrentBranch: () => ipcRenderer.invoke('git-current-branch'),
  gitListBranches: () => ipcRenderer.invoke('git-list-branches'),
  gitCheckout: (branch: string, force?: boolean) => ipcRenderer.invoke('git-checkout', { branch, force }),
  gitLog: (limit?: number) => ipcRenderer.invoke('git-log', { limit }),
  gitShowCommit: (hash: string) => ipcRenderer.invoke('git-show-commit', { hash }),
  gitShowCommitDiff: (hash: string) => ipcRenderer.invoke('git-show-commit-diff', { hash }),
  gitWatchStart: () => ipcRenderer.invoke('git-watch-start'),
  gitWatchStop: () => ipcRenderer.invoke('git-watch-stop'),
  /** 项目文件变化 → 壳页面自动刷新 Git 状态 */
  onGitChanged: (cb: () => void) => { ipcRenderer.on('shell-git-changed', () => cb()); },
  // ========== 后台任务 ==========
  taskStart: (command: string, label?: string, source?: string) => ipcRenderer.invoke('task-start', { command, label, source }),
  taskStop: (id: string) => ipcRenderer.invoke('task-stop', { id }),
  taskList: () => ipcRenderer.invoke('task-list'),
  taskOutput: (id: string, from?: number) => ipcRenderer.invoke('task-output', { id, from }),
  taskRemove: (id: string) => ipcRenderer.invoke('task-remove', { id }),
  taskClearExited: () => ipcRenderer.invoke('task-clear-exited'),
  taskReadScripts: () => ipcRenderer.invoke('task-read-scripts'),
  onTasksChanged: (cb: () => void) => { ipcRenderer.on('shell-tasks-changed', () => cb()); },
  setProjectArchived: (dir: string, archived: boolean) => ipcRenderer.invoke('set-project-archived', { dir, archived }),
  deleteProjectWorkspace: (dir: string) => ipcRenderer.invoke('delete-project-workspace', { dir }),
  setSessionTitle: (sessionId: string, title: string) => ipcRenderer.invoke('set-session-title', { sessionId, title }),
  newConversationForProject: (projectDir: string) => ipcRenderer.invoke('new-conversation-for-project', { projectDir }),
  // 左上角项目选择器：弹目录选择框，选定后新开对话（不在当前对话里改绑）
  pickDirAndNewConversation: () => ipcRenderer.invoke('pick-dir-and-new-conversation'),
  // ========== 快捷提示词 ==========
  listSnippets: () => ipcRenderer.invoke('list-snippets'),
  saveSnippets: (snippets: any) => ipcRenderer.invoke('save-snippets', { snippets }),
  triggerSnippet: (content: string, autoSend: boolean) => ipcRenderer.invoke('trigger-snippet', { content, autoSend }),
  onSnippetsChanged: (cb: () => void) => {
    ipcRenderer.on('shell-snippets-changed', () => cb());
  },
  onPlatformMode: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-platform-mode', (_e: any, data: any) => cb(data));
  },
  onSessionsChanged: (cb: () => void) => {
    ipcRenderer.on('shell-sessions-changed', () => cb());
  },
  // ========== 子代理 ==========
  listRunningSubagents: (parentWindowId?: number) => ipcRenderer.invoke('subagent-list', { parentWindowId }),
  onSubagentsChanged: (cb: () => void) => {
    ipcRenderer.on('shell-subagents-changed', () => cb());
  },
  // ========== 自绘标题栏：窗口控制 ==========
  windowMinimize: () => ipcRenderer.invoke('shell-window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('shell-window-maximize'),
  windowClose: () => ipcRenderer.invoke('shell-window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('shell-window-is-maximized'),
  // ========== 主题 ==========
  themeGet: () => ipcRenderer.invoke('theme-get'),
  themeSet: (id: string) => ipcRenderer.invoke('theme-set', { id }),
  themeList: () => ipcRenderer.invoke('theme-list'),
  themeSubscribe: () => ipcRenderer.invoke('theme-subscribe'),
  onThemeChanged: (cb: (snapshot: any) => void) => {
    ipcRenderer.on('theme-changed', (_e: any, snap: any) => cb(snap));
  },
  // ========== 技能 ==========
  listSkills: () => ipcRenderer.invoke('list-skills'),
  // ========== 子代理 ==========
  listAgents: () => ipcRenderer.invoke('list-agents'),
  createAgentFile: (name: string, scope: string) => ipcRenderer.invoke('create-agent-file', { name, scope }),
  openAgentFile: (agentPath: string) => ipcRenderer.invoke('open-agent-file', { agentPath }),
  renameAgent: (agentPath: string, newName: string) => ipcRenderer.invoke('rename-agent', { agentPath, newName }),
  deleteAgentFile: (agentPath: string) => ipcRenderer.invoke('delete-agent-file', { agentPath }),
  // ========== MCP ==========
  listMcpServers: () => ipcRenderer.invoke('list-mcp-servers', {}),
  enableMcpServer: (name: string) => ipcRenderer.invoke('enable-mcp-server', { name }),
  disableMcpServer: (name: string) => ipcRenderer.invoke('disable-mcp-server', { name }),
  appendSnippet: (text: string) => ipcRenderer.invoke('append-to-input', { text }),
  // ========== 底部「最近使用」（全局存储，跨窗口同步）==========
  recentList: () => ipcRenderer.invoke('recent-list'),
  recentAdd: (type: string, name: string, extra?: { payload?: string; autoSend?: boolean }) => ipcRenderer.invoke('recent-add', { type, name, payload: extra && extra.payload, autoSend: extra && extra.autoSend }),
  recentRemove: (type: string, name: string) => ipcRenderer.invoke('recent-remove', { type, name }),
  onRecentChanged: (cb: () => void) => {
    ipcRenderer.on('shell-recent-changed', () => cb());
  },
  // ========== 插件 ==========
  // 市场列表（topic:cuckoo-plugin；force=true 跳过本地缓存）。
  // 返回 { items, installed }，installed 为 repo → 已安装摘要（用于隐藏安装按钮 / 显示更新）
  pluginMarketList: (opts?: any) => ipcRenderer.invoke('plugin-market-list', opts || {}),
  pluginMarketCurated: (opts?: any) => ipcRenderer.invoke('plugin-market-curated', opts || {}),
  pluginMarketStateGet: () => ipcRenderer.invoke('plugin-market-state-get'),
  pluginMarketStateSet: (payload: any) => ipcRenderer.invoke('plugin-market-state-set', payload || {}),
  pluginMarketCheckUpdates: (opts?: any) => ipcRenderer.invoke('plugin-market-check-updates', opts || {}),
  pluginMarketAutoUpdate: (opts?: any) => ipcRenderer.invoke('plugin-market-auto-update', opts || {}),
  pluginMarketConfigGet: () => ipcRenderer.invoke('plugin-market-config-get'),
  pluginMarketConfigSet: (config: any) => ipcRenderer.invoke('plugin-market-config-set', { config }),
  // 远端 plugin.json（版本 / 最低应用版本）。搜索接口不返回这些，需单独拉取
  pluginMarketRemote: (targets: any) => ipcRenderer.invoke('plugin-market-remote', { targets }),
  // 安装 / 更新：upgrade=true 时覆盖已安装的同 id 插件
  pluginInstall: (repo: string, branch: string, upgrade: boolean) =>
    ipcRenderer.invoke('plugin-install', { repo, branch, upgrade }),
  pluginUninstall: (id: string) => ipcRenderer.invoke('plugin-uninstall', { id }),
  listInstalledPlugins: () => ipcRenderer.invoke('plugin-list-installed'),
  // 启用 / 禁用开关（插件总开关）：开启后技能/代理/规则/MCP/可执行内容全部生效
  pluginSetEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('plugin-set-enabled', { id, enabled }),
  pluginOpenDir: () => ipcRenderer.invoke('plugin-open-dir'),
  // ===== Cuckoo 插件（DSH 兼容）=====
  cuckooPluginList: () => ipcRenderer.invoke('cuckoo-plugin-list'),
  cuckooPluginInstall: (pkgName: string) => ipcRenderer.invoke('cuckoo-plugin-install', { pkgName }),
  cuckooPluginUninstall: (id: string) => ipcRenderer.invoke('cuckoo-plugin-uninstall', { id }),
  cuckooPluginToggle: (id: string, enabled: boolean) => ipcRenderer.invoke('cuckoo-plugin-toggle', { id, enabled }),
  cuckooPluginOpenDir: () => ipcRenderer.invoke('cuckoo-plugin-open-dir'),
  // ========== 关于 ==========
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getAssetUrl: (rel: string) => ipcRenderer.invoke('get-asset-url', { rel }),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', { url }),
  openCurrentExternal: () => ipcRenderer.invoke('open-current-external'),
  // ========== 远程控制 ==========
  getRemoteConfig: () => ipcRenderer.invoke('remote-get-config'),
  saveRemoteConfig: (data: any) => ipcRenderer.invoke('remote-save-config', { data }),
  resetRemoteToken: () => ipcRenderer.invoke('remote-reset-token'),
  restartRemote: () => ipcRenderer.invoke('remote-restart'),
  // ========== 自动压缩 ==========
  getAutoCompact: () => ipcRenderer.invoke('get-autocompact'),
  saveAutoCompact: (data: any) => ipcRenderer.invoke('save-autocompact', { data }),
  triggerCompact: () => ipcRenderer.invoke('trigger-compact'),
  // ========== 记忆 ==========
  listMemories: () => ipcRenderer.invoke('list-memories'),
  saveMemories: (memories: any) => ipcRenderer.invoke('save-memories', { memories }),
  addMemory: (text: string) => ipcRenderer.invoke('add-memory', { text }),
  deleteMemory: (id: string) => ipcRenderer.invoke('delete-memory', { id }),
  onMemoriesChanged: (cb: () => void) => {
    ipcRenderer.on('shell-memories-changed', () => cb());
  },
  // ========== 快照 ==========
  listSnapshots: (projectDir?: string) => ipcRenderer.invoke('list-snapshots', { projectDir }),
  createSnapshot: (projectDir: string, name: string, description?: string) =>
    ipcRenderer.invoke('create-snapshot', { projectDir, name, description }),
  restoreSnapshot: (id: string) => ipcRenderer.invoke('restore-snapshot', { id }),
  deleteSnapshot: (id: string) => ipcRenderer.invoke('delete-snapshot', { id }),
  // ========== 全局规则（用户级 ~/.cuckoo/rules/）==========
  listRules: () => ipcRenderer.invoke('rules-list'),
  createRule: (fileName: string, content: string) => ipcRenderer.invoke('rules-create', { fileName, content }),
  saveRule: (fileName: string, content: string, expectedHash: string) => ipcRenderer.invoke('rules-save', { fileName, content, expectedHash }),
  deleteRule: (fileName: string, expectedHash: string) => ipcRenderer.invoke('rules-delete', { fileName, expectedHash }),
  openRulesDir: () => ipcRenderer.invoke('rules-open-dir'),
  // ========== 设置 ==========
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data: any) => ipcRenderer.invoke('save-settings', { data }),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  getUiPrefs: () => ipcRenderer.invoke('get-ui-prefs'),
  setUiPrefs: (data: any) => ipcRenderer.invoke('set-ui-prefs', { data }),
  // ========== 安全 / 执行策略（X-001 第三层 + 工作区信任列表）==========
  getExecutionPolicy: () => ipcRenderer.invoke('get-execution-policy'),
  setExecutionPolicy: (mode: string) => ipcRenderer.invoke('set-execution-policy', { mode }),
  getTrustedWorkspaces: () => ipcRenderer.invoke('get-trusted-workspaces'),
  revokeWorkspaceTrust: (dir: string) => ipcRenderer.invoke('revoke-workspace-trust', { dir }),
};

try {
  contextBridge.exposeInMainWorld('shellAPI', shellAPI);
} catch (err) {
  console.error('[Cuckoo Shell] contextBridge 失败:', err);
}
(window as any).shellAPI = shellAPI;
