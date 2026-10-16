/**
 * tooltip 独立窗口的 preload
 * 暴露 window.tooltipAPI：接收内容 + 回传测量尺寸。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const tooltipAPI = {
  /** 主进程推送内容 */
  onContent: (cb: (data: any) => void) => {
    ipcRenderer.on('tooltip-content', (_e: any, data: any) => cb(data));
  },
  /** 渲染完成后回传真实尺寸 + 代次（主进程据此精调位置；gen 用于忽略迟到的旧测量） */
  measure: (gen: number, w: number, h: number) => ipcRenderer.send('tooltip-measure', { gen, w, h }),
};

contextBridge.exposeInMainWorld('tooltipAPI', tooltipAPI);
