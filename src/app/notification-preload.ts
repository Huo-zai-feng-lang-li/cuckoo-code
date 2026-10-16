/**
 * 通用通知浮窗的 preload
 * 暴露 window.notificationAPI：接收初始化数据 + 回传用户操作。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const notificationAPI = {
  /** 主进程推送初始化数据（kind/title/body/durationMs） */
  onInit: (cb: (data: any) => void) => {
    ipcRenderer.on('notification-init', (_e: any, data: any) => cb(data));
  },
  /** 回传用户操作：'click'（点击卡片）| 'close'（关闭） */
  action: (a: string) => ipcRenderer.send('notification-action', a),
};

contextBridge.exposeInMainWorld('notificationAPI', notificationAPI);
