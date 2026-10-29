/**
 * 纯净对话模式（Harness）页面 preload
 * 暴露 window.harnessAPI：发送用户消息、接收事件、切回网页模式。
 * 独立于 bridge/shell，不依赖官方内部模块（与官方解耦）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const harnessAPI = {
  /** 发送用户消息到 AI（转由 bridge 侧 sendToChat 发出） */
  sendMessage: (text: string) => ipcRenderer.invoke('harness-send', { text }),
  /** 退出纯净模式，返回网页模式 */
  exitToWeb: () => ipcRenderer.invoke('harness-exit'),
  /** 停止生成 */
  stop: () => ipcRenderer.invoke('harness-stop'),
  /** 列出可用技能与工具 */
  listTools: () => ipcRenderer.invoke('harness-list-tools'),
  getUiPrefs: () => ipcRenderer.invoke('get-ui-prefs'),
  /** 上传附件（{ name, mime, data(base64) }[]） */
  attach: (files: any) => ipcRenderer.invoke('harness-attach', { files }),
  /** 重载 harness 页面（加载最新 HTML） */
  reload: () => ipcRenderer.invoke('harness-reload'),
  /** 提示词增强：{ text, history } → { success, text, error } */
  enhancePrompt: (payload: { text: string; history?: any[] }) => ipcRenderer.invoke('harness-enhance-prompt', payload),
  /** 停止增强（abort 在途请求） */
  cancelEnhance: () => ipcRenderer.invoke('harness-cancel-enhance'),
  /** 读增强配置 */
  getEnhancerConfig: () => ipcRenderer.invoke('harness-get-enhancer-config'),
  /** 列出可用的增强背景图 */
  listEnhanceImages: () => ipcRenderer.invoke('harness-list-enhance-images'),
  /** 存增强配置（部分覆盖）→ 全局广播 */
  setEnhancerConfig: (config: any) => ipcRenderer.invoke('harness-set-enhancer-config', { config }),
  /** 订阅增强配置变化（其他窗口改动时同步） */
  onEnhancerConfig: (cb: (config: any) => void) => {
    ipcRenderer.on('harness-enhancer-config', (_e: any, cfg: any) => cb(cfg));
  },
  /** 新对话：在 AI 网页中开新会话 */
  newConversation: () => ipcRenderer.invoke('harness-new-conversation'),
  /** 真截断：从指定网页消息处开新会话（{ webMsgId, newText }） */
  truncate: (payload: { webMsgId: number; newText: string }) => ipcRenderer.invoke('harness-truncate', payload),
  /** 查询状态：是否需初始化项目（首页且未选目录） */
  getState: () => ipcRenderer.invoke('harness-get-state'),
  /** 初始化项目（弹目录选择框，复用官方逻辑） */
  initProject: () => ipcRenderer.invoke('harness-init-project'),
  /** 订阅状态变化（首页/已选目录） */
  onState: (cb: (payload: any) => void) => {
    ipcRenderer.on('harness-state', (_e: any, payload: any) => cb(payload));
  },
  /** 订阅对话事件（user/assistant/tool-start/tool-end/status/reset/subagents） */
  onEvent: (cb: (payload: any) => void) => {
    ipcRenderer.on('harness-event', (_e: any, payload: any) => cb(payload));
  },
  /** 取消指定子代理（纯净模式 runAgent 卡片上的「停止」按钮） */
  cancelSubagent: (windowId: number) => ipcRenderer.invoke('subagent-cancel', { windowId }),
  /** 追加文本到输入框末尾；autoSend=true 时回显后直接发送——供壳页面"最近"快捷项 */
  onAppendInput: (cb: (text: string, autoSend?: boolean) => void) => {
    ipcRenderer.on('harness-append-input', (_e: any, d: any) => cb((d && d.text) || '', !!(d && d.autoSend)));
  },
  /** 忙状态通知（生成中= true，用于禁用侧栏对话切换） */
  setBusy: (busy: boolean) => ipcRenderer.send('harness-set-busy', { busy: !!busy }),
  /** 页面就绪通知（可选，用于同步初始状态） */
  ready: () => ipcRenderer.send('harness-ready'),
  // ========== 窗口组切换 ==========
  /** 自动切换倒计时（限流触发前 3s 提示，用户可取消） */
  onSwitchCountdown: (cb: (data: any) => void) => {
    ipcRenderer.on('harness-switch-countdown', (_e: any, data: any) => cb(data));
  },
  /** 取消本次自动切换 */
  cancelSwitch: () => ipcRenderer.invoke('harness-cancel-switch'),
  /** 收到「导出状态」请求（主进程切换前拉取）——页面回传后调 exportStateReply */
  onExportStateReq: (cb: (data: any) => void) => {
    ipcRenderer.on('harness-export-state-req', (_e: any, data: any) => cb(data));
  },
  /** 回传导出的状态 */
  exportStateReply: (reqId: string, state: any) => ipcRenderer.send('harness-export-state-reply', { reqId, state }),
  /** 导入源窗口状态（切换后目标窗口重建界面） */
  onImportState: (cb: (data: any) => void) => {
    ipcRenderer.on('harness-import-state', (_e: any, data: any) => cb(data));
  },
  // ========== 主题（跟随 Cuckoo 主题系统）==========
  themeGet: () => ipcRenderer.invoke('theme-get'),
  themeSubscribe: () => ipcRenderer.invoke('theme-subscribe'),
  onThemeChanged: (cb: (snapshot: any) => void) => {
    ipcRenderer.on('theme-changed', (_e: any, snap: any) => cb(snap));
  },
  // 插件注入壳页面 CSS（harness 也是 Cuckoo 界面，一起跟随）
  onPluginStyle: (cb: (data: any) => void) => {
    ipcRenderer.on('harness-plugin-style', (_e: any, data: any) => cb(data));
  },
  onPluginStyleRemove: (cb: (data: any) => void) => {
    ipcRenderer.on('harness-plugin-style-remove', (_e: any, data: any) => cb(data));
  },
  listPluginStyles: () => ipcRenderer.invoke('plugin-shell-style-list'),
  // 插件背景图（基座对齐：带 offset 补偿）
  onHarnessBackground: (cb: (data: any) => void) => {
    ipcRenderer.on('harness-background', (_e: any, data: any) => cb(data));
  },
  getHarnessBackground: () => ipcRenderer.invoke('plugin-shell-background-list'),
};

try {
  contextBridge.exposeInMainWorld('harnessAPI', harnessAPI);
} catch (err) {
  console.error('[Cuckoo Harness] contextBridge 失败:', err);
}
(window as any).harnessAPI = harnessAPI;

export {};
