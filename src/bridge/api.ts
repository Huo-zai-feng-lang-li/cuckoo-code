/**
 * 暴露给 Cuckoo preload/overlay 隔离世界的 API。
 * 由原 preload.js 拆分而来；页面主世界不应获得这些 IPC 能力。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ipcRenderer, contextBridge } = require('electron');

// ========== 暴露给 preload/overlay 隔离世界的 API ==========
let electronAPI: any = {
  executeCommand: (command: any, id: any) => {
    return ipcRenderer.invoke('execute-command', { command, id });
  },
  initProject: (projectDir: any, isCompaction: any, extraPrompt: any, noDialog: any, parentSessionId: any) => {
    return ipcRenderer.invoke('init-project', {
      skipPrompt: false,
      projectDir: projectDir || null,
      isCompaction: !!isCompaction,
      extraPrompt: extraPrompt || '',
      noDialog: !!noDialog,
      parentSessionId: parentSessionId || null,
    });
  },
  updateProjectDir: () => {
    return ipcRenderer.invoke('init-project', { skipPrompt: true });
  },
  getPluginWebScripts: () => {
    return ipcRenderer.invoke('get-plugin-web-scripts');
  },
  executeTool: (toolName: any, params: any, callId: any) => {
    return ipcRenderer.invoke('execute-tool', { toolName, params, callId });
  },
  /** 取消当前窗口下所有运行中的子代理（停止按钮 → 真杀隐藏窗口） */
  cancelSubagents: () => ipcRenderer.invoke('subagent-cancel'),
  // 正文标记触发：AI 回复里的 [记忆]xxx / [快照]xxx
  createMemoryFromMarker: (text: any) => {
    return ipcRenderer.invoke('create-memory-marker', { text });
  },
  createSnapshotFromMarker: (name: any) => {
    return ipcRenderer.invoke('create-snapshot-marker', { name });
  },
  executeJs: (code: any, callId: any) => {
    let ssrfGuard = false;
    try {
      ssrfGuard = localStorage.getItem('cuckoo-ssrf-guard') === '1';
    } catch (_) {}
    return ipcRenderer.invoke('execute-js', { code, callId, ssrfGuard });
  },
  sendEnterToChat: () => {
    return ipcRenderer.invoke('chat-send-enter');
  },
  insertTextToChat: (text: string) => {
    return ipcRenderer.invoke('chat-insert-text', { text });
  },
  /** 长文本走附件通道（需求 115）；失败时调用方回退 insertTextToChat */
  sendAsFile: (text: string, fileName: string) => {
    return ipcRenderer.invoke('chat-send-as-file', { text, fileName });
  },
  contextLimitHit: () => ipcRenderer.invoke('context-limit-hit'),
  simulateMouse: (action: any, x: any, y: any) => {
    return ipcRenderer.invoke('simulate-mouse', { action, x, y });
  },
  listSessions: () => {
    return ipcRenderer.invoke('list-sessions');
  },
  /** 拉取已启用插件的 DSH 风格插件源码 */
  getDshPluginSources: () => {
    return ipcRenderer.invoke('plugin-sources');
  },
  /** 拉取已启用插件的 UI 扩展源码 */
  getUiPluginSources: () => {
    return ipcRenderer.invoke('plugin-ui-sources');
  },
  // ========== 插件注入壳页面 CSS（对标 DSH styles.insert）==========
  shellStyleAdd: (pluginId: string, css: string) => ipcRenderer.invoke('plugin-shell-style-add', { pluginId, css }),
  shellStyleRemove: (pluginId: string) => ipcRenderer.invoke('plugin-shell-style-remove', { pluginId }),
  setWebViewVisible: (visible: boolean) => ipcRenderer.invoke('plugin-set-webview-visible', { visible }),
  setWindowMaterial: (material: string) => ipcRenderer.invoke('plugin-set-window-material', { material }),
  onHarnessModeChanged: (cb: (data: any) => void) => { ipcRenderer.on('harness-mode-changed', (_e: any, d: any) => cb(d)); },
  slotRegister: (info: any) => ipcRenderer.invoke('plugin-slot-register', info),
  slotUnregister: (info: any) => ipcRenderer.invoke('plugin-slot-unregister', info),
  shellBackground: (pluginId: string, url: string | null, overlay?: string) => ipcRenderer.invoke('plugin-shell-background', { pluginId, url, overlay }),
  // ========== 主题（IPC 代理到主进程权威） ==========
  themeGet: () => ipcRenderer.invoke('theme-get'),
  themeSet: (id: string) => ipcRenderer.invoke('theme-set', { id }),
  themeList: () => ipcRenderer.invoke('theme-list'),
  themeRegister: (definition: any) => ipcRenderer.invoke('theme-register', { definition }),
  themeOverride: (source: string, tokens: any) => ipcRenderer.invoke('theme-override', { source, tokens }),
  themeDispose: (token: string) => ipcRenderer.invoke('theme-dispose', { token }),
  themeSubscribe: () => ipcRenderer.invoke('theme-subscribe'),
  onThemeChanged: (cb: (snapshot: any) => void) => {
    ipcRenderer.on('theme-changed', (_e: any, snap: any) => cb(snap));
  },
  /** 注册插件工具到主进程 */
  registerPluginTool: (info: any) => {
    return ipcRenderer.invoke('plugin-tool-register', info);
  },
  /** 注销插件工具 */
  unregisterPluginTool: (toolId: string) => {
    return ipcRenderer.invoke('plugin-tool-unregister', { toolId });
  },
  /** 监听"主进程调用插件工具" */
  onPluginToolInvoke: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('plugin-tool-invoke', handler);
    return () => ipcRenderer.removeListener('plugin-tool-invoke', handler);
  },
  /** 回传插件工具执行结果 */
  pluginToolResult: (callId: string, result: any) => {
    return ipcRenderer.send('plugin-tool-result', { callId, result });
  },
  /** 取系统总累计 token（主进程） */
  getTokenTotal: () => {
    return ipcRenderer.invoke('plugin-token-total');
  },
  /** 插件配置：取 schema + 当前值 */
  pluginConfigGet: (pluginId: string) => ipcRenderer.invoke('plugin-config-get', { pluginId }),
  /** 插件配置：保存 */
  pluginConfigSet: (pluginId: string, values: any) => ipcRenderer.invoke('plugin-config-set', { pluginId, values }),
  /** 插件命令：注册 */
  commandRegister: (info: any) => ipcRenderer.invoke('plugin-command-register', info),
  /** 插件命令：注销 */
  commandUnregister: (commandId: string) => ipcRenderer.invoke('plugin-command-unregister', { commandId }),
  /** 插件命令：列表 */
  commandList: () => ipcRenderer.invoke('plugin-command-list'),
  /** 插件命令：触发 */
  commandInvoke: (commandId: string) => ipcRenderer.invoke('plugin-command-invoke', { commandId }),
  /** 插件命令：回传执行结果 */
  commandResult: (runId: string, result: any) => ipcRenderer.send('plugin-command-result', { runId, result }),
  /** 插件命令：订阅触发（渲染进程收到后执行） */
  onCommandInvoke: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('plugin-command-invoke', handler);
    return () => ipcRenderer.removeListener('plugin-command-invoke', handler);
  },
  /** 插件界面挂载：往 Cuckoo 壳页面（侧边栏/状态栏/工具栏）挂 UI */
  shellMount: (pluginId: string, target: string, id: string, spec: any) => {
    return ipcRenderer.invoke('plugin-shell-mount', { pluginId, target, id, spec });
  },
  /** 插件提示词段：转发到主进程的提示词表（渲染进程与主进程内存不共享） */
  pluginPromptSection: (pluginId: string, sec: any) => ipcRenderer.invoke('plugin-prompt-section', { pluginId, sec }),
  pluginPromptSectionRemove: (pluginId: string, name: string) => ipcRenderer.invoke('plugin-prompt-section-remove', { pluginId, name }),
  /** 插件 webServer：注册静态路由（暴露插件目录为 HTTP） */
  webServerServe: (pluginId: string, prefix: string, dir: string) => {
    return ipcRenderer.invoke('plugin-webserver-serve', { pluginId, prefix, dir });
  },
  /** 插件 webServer：取服务端口/基础 URL */
  webServerInfo: () => {
    return ipcRenderer.invoke('plugin-webserver-info');
  },
  /** 插件覆盖层：初始化（创建透明置顶视图） */
  overlayInit: () => ipcRenderer.invoke('plugin-overlay-init'),
  /** 插件覆盖层：在覆盖层内执行 JS */
  overlayEval: (code: string) => ipcRenderer.invoke('plugin-overlay-eval', { code }),
  /** 插件覆盖层：设置覆盖层 HTML */
  overlayHtml: (html: string) => ipcRenderer.invoke('plugin-overlay-html', { html }),
  /** 注入代码到主世界（主进程 webContents.executeJavaScript） */
  injectMainWorld: (code: string) => {
    return ipcRenderer.invoke('plugin-inject-main-world', { code });
  },
  /** 写插件调试日志（渲染进程 → 主进程文件） */
  pluginDebugLog: (msg: string) => {
    try { ipcRenderer.send('plugin-debug-log', { msg }); } catch (_) {}
  },
  /** 读插件资源文件（返回 base64） */
  readPluginAsset: (pluginId: string, relPath: string) => {
    return ipcRenderer.invoke('plugin-read-asset', { pluginId, relPath });
  },
  /** 监听"插件需要重载"通知 */
  onPluginReloadNeeded: (cb: () => void) => {
    const handler = () => { try { cb(); } catch (_) {} };
    ipcRenderer.on('plugin-reload-needed', handler);
    return () => ipcRenderer.removeListener('plugin-reload-needed', handler);
  },
  navigateSession: (sessionId: any) => {
    return ipcRenderer.invoke('navigate-session', { sessionId });
  },
  // 暂存压缩续接标题（AI 生成）：会话 ID 未出现时先存，出现后自动绑定
  setPendingSessionTitle: (title: any) => {
    return ipcRenderer.invoke('set-pending-session-title', { title });
  },
  createProfileWindow: () => {
    return ipcRenderer.invoke('create-profile-window');
  },
  listProfiles: () => {
    return ipcRenderer.invoke('list-profiles');
  },
  openProfileWindow: (profileId: any) => {
    return ipcRenderer.invoke('open-profile-window', { profileId });
  },
  setProfileAutoOpen: (profileId: any, autoOpen: any) => {
    return ipcRenderer.invoke('set-profile-auto-open', { profileId, autoOpen });
  },
  deleteProfileWindow: (profileId: any) => {
    return ipcRenderer.invoke('delete-profile', { profileId });
  },
  updateWindowName: (displayName: any) => {
    return ipcRenderer.invoke('update-window-name', { displayName });
  },
  showAiNotification: (summary: any) => {
    return ipcRenderer.invoke('show-ai-notification', { summary: summary || '' });
  },
  updateTokenUsage: (context: any, cumulative: any, windowCumulative: any, todayCumulative: any, daily: any) => {
    return ipcRenderer.invoke('update-token-usage', { context, cumulative, windowCumulative, todayCumulative, daily });
  },
  // 输出速度（TPS）展示文本；空串表示本轮已结束/无数据
  updateTps: (text: any) => {
    return ipcRenderer.invoke('update-tps', { text });
  },
  // ========== 技能相关 API ==========
  refreshSkills: () => {
    return ipcRenderer.invoke('refresh-skills');
  },
  // ========== MCP 相关 API ==========
  listMcpServers: (opts: any) => {
    return ipcRenderer.invoke('list-mcp-servers', opts || {});
  },
  upsertMcpServer: (server: any) => {
    return ipcRenderer.invoke('upsert-mcp-server', { server });
  },
  removeMcpServer: (name: any) => {
    return ipcRenderer.invoke('remove-mcp-server', { name });
  },
  enableMcpServer: (name: any) => {
    return ipcRenderer.invoke('enable-mcp-server', { name });
  },
  disableMcpServer: (name: any) => {
    return ipcRenderer.invoke('disable-mcp-server', { name });
  },
  getMcpTools: () => {
    return ipcRenderer.invoke('get-mcp-tools');
  },
  // ========== 平台相关 API ==========
  listProviders: () => {
    return ipcRenderer.invoke('list-providers');
  },
  selectPlatform: (providerId: any) => {
    return ipcRenderer.invoke('select-platform', { providerId });
  },
  createProfileWindowWithProvider: (providerId: any) => {
    return ipcRenderer.invoke('create-profile-window', { providerId });
  },
  importProvider: () => {
    return ipcRenderer.invoke('import-provider');
  },
  removeProvider: (filePath: any, providerId: any) => {
    return ipcRenderer.invoke('remove-provider', { path: filePath, providerId });
  },
  replaceProvider: (providerId: any) => {
    return ipcRenderer.invoke('replace-provider', { providerId });
  },
  // ========== 全局设置 ==========
  // overlay 设置面板保存后必须同步到主进程（agent-settings.json 是唯一真相源）。
  // 只写 localStorage 的话，主进程任何一次 cuckoo-sync-settings 广播都会把
  // 它自己的旧值（默认 6/36）写回来，覆盖用户刚改的值 —— 实测「设置过会自己恢复」。
  saveSettingsGlobal: (data: any) => {
    return ipcRenderer.invoke('save-settings', { data });
  },
};

// contextIsolation=true 时，这个赋值只存在于 preload 的隔离世界（供 overlay / bridge 内部用）。
(window as any).electronAPI = electronAPI;

// 主世界暴露：**仅限本地页面**（file:// 协议）。
//  - platform-select.html / proxy-error.html 等应用自带页面运行在主世界，脚本直接读
//    window.electronAPI；没有这层桥接，页面会报「API 未就绪」（实测踩过）。
//  - 远程 AI 页面（https://）一律不暴露：它们是不可信内容，拿到 execute-command /
//    execute-js / execute-tool 等于把本机命令执行能力交给外部站点。
// 判据用协议而非域名白名单：新增本地页面无需维护名单，也不会误放行远程页面。
const isLocalPage = (() => {
  try { return window.location.protocol === 'file:'; } catch (_) { return false; }
})();
if (isLocalPage) {
  try { contextBridge.exposeInMainWorld('electronAPI', electronAPI); } catch (_) { /* 已存在或环境不支持 */ }
}
