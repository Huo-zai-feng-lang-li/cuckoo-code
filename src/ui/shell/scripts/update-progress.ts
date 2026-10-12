/**
 * 自动更新进度：接收主进程推送的 'shell-update-progress'，
 * 在状态栏显示下载进度条（百分比 + 进度条），完成/失败后自动隐藏。
 */
import { api } from './shared.js';

const HIDE_DELAY = 4000; // 完成/失败后停留多久再隐藏

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function show(): void {
  const box = el('sb-update');
  if (box) box.style.display = '';
}

function hide(): void {
  const box = el('sb-update');
  if (box) box.style.display = 'none';
}

function setBar(percent: number): void {
  const fill = el('sb-update-fill');
  const pct = el('sb-update-pct');
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  if (fill) (fill as any).style.width = p + '%';
  if (pct) pct.textContent = p + '%';
}

function setLabel(text: string): void {
  const l = el('sb-update-label');
  if (l) l.textContent = text;
}

let hideTimer: any = null;
function scheduleHide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { hide(); hideTimer = null; }, HIDE_DELAY);
}

export function initUpdateProgress(): void {
  if (!api.onUpdateProgress) return;
  api.onUpdateProgress((data: any) => {
    if (!data || !data.state) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (data.state === 'downloading') {
      show();
      setLabel('更新中');
      setBar(typeof data.percent === 'number' ? data.percent : 0);
    } else if (data.state === 'done') {
      show();
      setLabel('更新已就绪');
      setBar(100);
      scheduleHide();
    } else if (data.state === 'error') {
      show();
      setLabel('更新失败');
      scheduleHide();
    }
  });
}
