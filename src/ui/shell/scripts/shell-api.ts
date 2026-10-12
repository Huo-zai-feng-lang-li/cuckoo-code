/**
 * 壳页面 API 类型（preload 经 contextBridge 注入的 window.shellAPI）。
 * 全部方法可选——用防御式调用（if (api.xxx) api.xxx()）。
 */
export interface ShellAPI {
  /** 运行平台（darwin/win32/linux） */
  platform?: string;
  navigate?: (url: string) => void;
  back?: () => void;
  forward?: () => void;
  reload?: () => void;
  home?: () => void;
  onUrlUpdated?: (cb: (data: any) => void) => void;
  /** 自动更新进度（状态栏进度条） */
  onUpdateProgress?: (cb: (data: any) => void) => void;
  toggleSidebar?: (width: number) => void;
  startSidebarDrag?: () => void;
  endSidebarDrag?: () => void;
  onSidebarDrag?: (cb: (width: number) => void) => void;
  /** 网页端会话列表（DOM 读取，实时同步网页） */
  listWebSessions?: () => Promise<any>;
  navigateWebSession?: (url: string) => Promise<any>;
  newWebConversation?: () => Promise<any>;
  onWebUrlChanged?: (cb: () => void) => void;
  /** harness 生成中（busy=true → 禁用对话切换） */
  onHarnessBusy?: (cb: (busy: boolean) => void) => void;
  // 插件市场 / 安装
  pluginMarketList?: (opts?: any) => Promise<any>;
  pluginMarketRemote?: (targets: any) => Promise<any>;
  pluginInstall?: (repo: string, branch: string, upgrade: boolean) => Promise<any>;
  pluginUninstall?: (id: string) => Promise<any>;
  listInstalledPlugins?: () => Promise<any>;
  pluginSetEnabled?: (id: string, enabled: boolean) => Promise<any>;
  pluginOpenDir?: () => Promise<any>;
  // ===== Cuckoo 插件（DSH 兼容）=====
  cuckooPluginList?: () => Promise<any>;
  cuckooPluginInstall?: (pkgName: string) => Promise<any>;
  cuckooPluginUninstall?: (id: string) => Promise<any>;
  cuckooPluginToggle?: (id: string, enabled: boolean) => Promise<any>;
  cuckooPluginOpenDir?: () => Promise<any>;
  // 窗口组
  wgList?: () => Promise<any>;
  wgCreate?: (name?: string) => Promise<any>;
  wgAddWindow?: (groupId: string, windowId: string) => Promise<any>;
  wgRemoveWindow?: (groupId: string, windowId: string) => Promise<any>;
  wgRename?: (groupId: string, name: string) => Promise<any>;
  wgDelete?: (groupId: string) => Promise<any>;
  wgSwitch?: (groupId: string) => Promise<any>;
  // 记忆
  listMemories?: () => Promise<any>;
  saveMemories?: (memories: any[]) => Promise<any>;
  addMemory?: (text: string) => Promise<any>;
  deleteMemory?: (id: string) => Promise<any>;
  onMemoriesChanged?: (cb: () => void) => void;
  // 快照
  listSnapshots?: (projectDir?: string) => Promise<any>;
  createSnapshot?: (projectDir: string, name: string, description?: string) => Promise<any>;
  restoreSnapshot?: (id: string) => Promise<any>;
  deleteSnapshot?: (id: string) => Promise<any>;
  // 全局规则（用户级 ~/.cuckoo/rules/）
  listRules?: () => Promise<any>;
  createRule?: (fileName: string, content: string) => Promise<any>;
  saveRule?: (fileName: string, content: string, expectedHash: string) => Promise<any>;
  deleteRule?: (fileName: string, expectedHash: string) => Promise<any>;
  openRulesDir?: () => Promise<any>;
  /** 切换纯净对话模式（Harness） */
  toggleHarness?: () => Promise<any>;
  /** 纯净模式状态变化（harness=true 表示已进入纯净模式） */
  onHarnessMode?: (cb: (data: { harness: boolean }) => void) => void;
  reportShellSize?: (w: number, h: number) => void;
  initProject?: (dir?: string | null, isCompaction?: boolean, extraPrompt?: string, noDialog?: boolean) => Promise<any>;
  pluginMarketCurated?: (opts?: any) => Promise<any>;
  /** 临时隐藏 AI 视图（WebContentsView 挡不住 CSS，全屏弹层需要它） */
  setWebViewVisible?: (visible: boolean) => Promise<any>;
  pluginMarketStateGet?: () => Promise<any>;
  pluginMarketStateSet?: (payload: any) => Promise<any>;
  pluginMarketCheckUpdates?: (opts?: any) => Promise<any>;
  pluginMarketAutoUpdate?: (opts?: any) => Promise<any>;
  pluginMarketConfigGet?: () => Promise<any>;
  pluginMarketConfigSet?: (config: any) => Promise<any>;
  updateProjectDir?: () => Promise<any>;
  onProjectDir?: (cb: (dir: string | null) => void) => void;
  getProjectDir?: () => Promise<any>;
  onPlatformMode?: (cb: (data: any) => void) => void;
  /** 会话标题/归档变化（如 AI 命名对话）→ 刷新工作区列表 */
  onSessionsChanged?: (cb: () => void) => void;
  // ===== 主题 =====
  themeGet?: () => Promise<any>;
  themeSet?: (id: string) => Promise<any>;
  themeList?: () => Promise<any>;
  themeSubscribe?: () => Promise<any>;
  onThemeChanged?: (cb: (snapshot: any) => void) => void;
  // 会话（侧边栏「工作区」页）
  listAllSessions?: () => Promise<any>;
  navigateSession?: (sessionId: string) => Promise<any>;
  setSessionArchived?: (sessionId: string, archived: boolean) => Promise<any>;
  deleteSession?: (sessionId: string) => Promise<any>;
  getDirInfo?: (dir: string) => Promise<{ success: boolean; dir?: string; createdAt?: string | null; error?: string }>;
  listProjectTree?: () => Promise<{ success: boolean; root?: string; tree?: any[]; truncated?: boolean; error?: string }>;
  readProjectFile?: (relPath: string) => Promise<any>;
  writeProjectFile?: (relPath: string, content: string) => Promise<any>;
  watchProjectFile?: (relPath: string) => Promise<any>;
  unwatchProjectFile?: () => Promise<any>;
  onProjectFileChanged?: (cb: (data: { relPath: string }) => void) => void;
  openFileExternal?: (relPath: string) => Promise<any>;
  createProjectEntry?: (parentRel: string, name: string, isDir: boolean) => Promise<any>;
  renameProjectEntry?: (relPath: string, newName: string) => Promise<any>;
  deleteProjectEntry?: (relPath: string) => Promise<any>;
  gitShowFile?: (relPath: string) => Promise<any>;
  /** 源代码管理：改动列表 / 暂存 / 取消暂存 / 撤销 / 提交 */
  gitStatus?: () => Promise<any>;
  gitStage?: (relPath: string) => Promise<any>;
  gitUnstage?: (relPath: string) => Promise<any>;
  gitRestore?: (relPath: string) => Promise<any>;
  gitDiscardUntracked?: (relPath: string) => Promise<any>;
  gitCommit?: (message: string) => Promise<any>;
  gitCurrentBranch?: () => Promise<any>;
  gitListBranches?: () => Promise<any>;
  gitCheckout?: (branch: string, force?: boolean) => Promise<any>;
  setProjectArchived?: (dir: string, archived: boolean) => Promise<any>;
  deleteProjectWorkspace?: (dir: string) => Promise<any>;
  setSessionTitle?: (sessionId: string, title: string) => Promise<any>;
  newConversationForProject?: (projectDir: string) => Promise<any>;
  // 提示词
  listSnippets?: () => Promise<any>;
  getSnippets?: () => Promise<any>;
  saveSnippets?: (list: any[]) => Promise<any>;
  triggerSnippet?: (content: string, autoSend?: boolean) => Promise<any>;
  appendSnippet?: (text: string) => Promise<any>;
  onSnippetsChanged?: (cb: () => void) => void;
  // 技能 / 子代理
  listSkills?: () => Promise<any>;
  listAgents?: () => Promise<any>;
  listRunningSubagents?: (parentWindowId?: number) => Promise<any>;
  onSubagentsChanged?: (cb: () => void) => void;
  createAgentFile?: (name: string, scope: string) => Promise<any>;
  openAgentFile?: (agentPath: string) => Promise<any>;
  renameAgent?: (agentPath: string, newName: string) => Promise<any>;
  deleteAgentFile?: (agentPath: string) => Promise<any>;
  // MCP
  listMcpServers?: () => Promise<any>;
  enableMcpServer?: (name: string) => Promise<any>;
  disableMcpServer?: (name: string) => Promise<any>;
  // 窗口
  listProfiles?: () => Promise<any>;
  createProfileWindow?: () => Promise<any>;
  openProfileWindow?: (id: string) => Promise<any>;
  deleteProfileWindow?: (id: string) => Promise<any>;
  setProfileAutoOpen?: (id: string, on: boolean) => Promise<any>;
  // 窗口名（状态栏显示）
  getWindowName?: () => Promise<any>;
  onWindowNameUpdated?: (cb: (name: string) => void) => void;
  // Token / 自动压缩
  getAutoCompact?: () => Promise<any>;
  saveAutoCompact?: (data: any) => Promise<any>;
  triggerCompact?: () => Promise<any>;
  // 设置
  getSettings?: () => Promise<any>;
  saveSettings?: (data: any) => Promise<any>;
  resetSettings?: () => Promise<any>;
  getUiPrefs?: () => Promise<any>;
  setUiPrefs?: (data: any) => Promise<any>;
  // 关于
  getAppInfo?: () => Promise<any>;
  checkUpdate?: () => Promise<any>;
  getAssetUrl?: (rel: string) => Promise<any>;
  openExternal?: (url: string) => Promise<any>;
  openCurrentExternal?: () => Promise<any>;
  openFeishuSetup?: () => Promise<any>;
  // 飞书
  getFeishuConfig?: () => Promise<any>;
  saveFeishuConfig?: (data: any) => Promise<any>;
  reconnectFeishu?: () => Promise<any>;
  disconnectFeishu?: () => Promise<any>;
  listFeishuChats?: () => Promise<any>;
  getFeishuBinding?: () => Promise<any>;
  bindFeishuChat?: (chatId: string, chatName: string) => Promise<any>;
}
