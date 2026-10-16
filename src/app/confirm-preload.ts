/**
 * 通用确认对话框浮窗的 preload
 * 暴露 window.confirmAPI：接收初始化数据 + 回传用户操作。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const confirmAPI = {
  /** 主进程推送初始化数据（kind/title/body/detail/primaryText/secondaryText） */
  onInit: (cb: (data: any) => void) => {
    ipcRenderer.on('confirm-init', (_e: any, data: any) => cb(data));
  },
  /** 回传用户操作：'primary'（主按钮）| 'secondary'（次按钮/关闭） */
  action: (a: string) => ipcRenderer.send('confirm-action', a),
};

contextBridge.exposeInMainWorld('confirmAPI', confirmAPI);
