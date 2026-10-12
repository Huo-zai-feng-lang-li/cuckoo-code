/**
 * 窗口组切换提示：接收主进程推送的 'shell-window-switch'，
 * 在界面右上角弹 toast（含原因、来源 → 目标、结果）。
 * 成功后 6 秒自动消失；失败停留 10 秒。
 */
import { api } from './shared.js';

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement | null {
  if (host && host.isConnected) return host;
  host = document.getElementById('ck-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ck-toast-host';
    host.className = 'ck-toast-host';
    document.body.appendChild(host);
  }
  return host;
}

function showToast(data: any): void {
  const h = ensureHost();
  if (!h) return;
  const ok = !!(data && data.ok);
  const reason = (data && data.reason) || '';
  const from = (data && data.from) || '窗口';
  const to = (data && data.to) || '';
  const detail = (data && data.detail) || '';
  const title = ok ? '窗口组已切换' : '窗口组切换失败';
  const body = ok
    ? (reason + '：' + from + ' → ' + to)
    : (reason + '：' + (detail || '切换未完成'));

  const el = document.createElement('div');
  el.className = 'ck-toast' + (ok ? '' : ' ck-toast-error');
  const icon = ok ? '✓' : '✕';
  el.innerHTML = '<span class="ck-toast-icon">' + icon + '</span>' +
    '<div class="ck-toast-body"><div class="ck-toast-title"></div><div class="ck-toast-msg"></div></div>';
  (el.querySelector('.ck-toast-title') as any).textContent = title;
  (el.querySelector('.ck-toast-msg') as any).textContent = body;
  el.addEventListener('click', () => { try { el.remove(); } catch (_) {} });
  h.appendChild(el);

  const life = ok ? 6000 : 10000;
  setTimeout(() => {
    el.classList.add('ck-toast-hide');
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 300);
  }, life);
}

export function initWindowSwitchToast(): void {
  if (!api.onWindowSwitch) return;
  api.onWindowSwitch((data: any) => { try { showToast(data); } catch (_) {} });
}
