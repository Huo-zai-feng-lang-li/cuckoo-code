/**
 * 桌面宠物浮窗的 preload
 * 暴露 window.petWindowAPI：接收初始化数据 + 状态更新。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const petWindowAPI = {
  /** 主进程推送初始化数据（尺寸档） */
  onInit: (cb: (data: any) => void) => {
    ipcRenderer.on('pet-window-init', (_e: any, data: any) => cb(data));
  },
  /** 主进程推送状态：{ state, text, sticky } */
  onState: (cb: (data: any) => void) => {
    ipcRenderer.on('pet-window-state', (_e: any, data: any) => cb(data));
  },
  /** 主进程推送尺寸变更（设置页改大小 / 别的窗口同步） */
  onSize: (cb: (data: any) => void) => {
    ipcRenderer.on('pet-window-size', (_e: any, data: any) => cb(data));
  },
  /** 窗口内滚轮改大小 → 落盘偏好（由主进程写 ui-prefs.json 并回推 onSize） */
  setSize: (size: number) => ipcRenderer.send('pet-window-set-size', size),
  /** 拖动宠物本体时移动窗口（传增量 dx/dy） */
  dragBy: (dx: number, dy: number) => ipcRenderer.send('pet-window-drag-by', { dx, dy }),
  /** 点击宠物 → 恢复主窗口（多窗口时回到最近活跃的那个） */
  activate: () => ipcRenderer.send('pet-window-activate'),
  /** 上报宠物本体命中矩形（窗口内 CSS 像素）：主进程据此决定是否让鼠标穿透 */
  setHitRect: (r: { x: number; y: number; w: number; h: number } | null) =>
    ipcRenderer.send('pet-window-hit-rect', r),
  /** 拖动开始/结束（true=锁定接收鼠标事件，防止指针捕获被穿透打断） */
  dragLock: (locked: boolean) => ipcRenderer.send('pet-window-drag-lock', !!locked),
  /** 关闭桌面宠物（保留通道：由设置开关控制显隐，窗口内不再暴露按钮） */
  close: () => ipcRenderer.send('pet-window-close'),
};

contextBridge.exposeInMainWorld('petWindowAPI', petWindowAPI);
