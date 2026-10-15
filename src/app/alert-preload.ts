/**
 * 限流自动切换告警浮窗的 preload
 * 暴露 window.alertAPI：接收初始化数据 + 回传用户操作。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const alertAPI = {
  /** 主进程推送初始化数据（当前/目标窗口名、倒计时秒数） */
  onInit: (cb: (data: any) => void) => {
    ipcRenderer.on('alert-init', (_e: any, data: any) => cb(data));
  },
  /** 回传用户操作：'cancel'（取消切换）| 'switch-now'（立即切换） */
  action: (a: string) => ipcRenderer.send('alert-action', a),
};

contextBridge.exposeInMainWorld('alertAPI', alertAPI);
