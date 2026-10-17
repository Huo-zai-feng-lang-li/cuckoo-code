/**
 * 壳页面共享模块：API、通用弹框、HTML 转义、格式化。
 */
import type { ShellAPI } from './shell-api.js';

/** 暴露的壳页面 API（preload 注入） */
export const api: ShellAPI = (window as any).shellAPI || {};

// ===== 通用弹框（替代原生 alert/confirm）=====
export function ckDialog(opts: { title?: string; message?: string; confirm?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.getElementById('ck-dialog');
    const titleEl = document.getElementById('ck-dialog-title');
    const msgEl = document.getElementById('ck-dialog-msg');
    const okBtn = document.getElementById('ck-dialog-ok') as any;
    const cancelBtn = document.getElementById('ck-dialog-cancel') as any;
    if (!mask || !okBtn || !cancelBtn) { resolve(true); return; }
    if (titleEl) titleEl.textContent = opts.title || '提示';
    if (msgEl) msgEl.textContent = opts.message || '';
    cancelBtn.classList.toggle('cuckoo-hidden', !opts.confirm);
    function cleanup() {
      mask!.classList.add('cuckoo-hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      mask!.removeEventListener('click', onMask);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onMask(e: any) { if (e.target === mask) { cleanup(); resolve(false); } }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    mask.classList.remove('cuckoo-hidden');
  });
}

export function ckConfirm(message: string, title?: string): Promise<boolean> {
  return ckDialog({ title: title || '确认', message, confirm: true });
}

/**
 * 三选一弹框（用于冲突场景）。
 * @returns 'primary' | 'alt' | 'cancel'
 *  - primary：主按钮（如"采用外部版"）
 *  - alt：次按钮（如"查看差异"）
 *  - cancel：取消（如"保留我的"）
 */
export function ckDialog3(opts: { title?: string; message?: string; primary?: string; alt?: string; cancel?: string }): Promise<'primary' | 'alt' | 'cancel'> {
  return new Promise((resolve) => {
    const mask = document.getElementById('ck-dialog');
    const titleEl = document.getElementById('ck-dialog-title');
    const msgEl = document.getElementById('ck-dialog-msg');
    const okBtn = document.getElementById('ck-dialog-ok') as any;
    const altBtn = document.getElementById('ck-dialog-alt') as any;
    const cancelBtn = document.getElementById('ck-dialog-cancel') as any;
    if (!mask || !okBtn || !altBtn || !cancelBtn) { resolve('cancel'); return; }
    if (titleEl) titleEl.textContent = opts.title || '提示';
    if (msgEl) msgEl.textContent = opts.message || '';
    okBtn.textContent = opts.primary || '确定';
    altBtn.textContent = opts.alt || '查看差异';
    altBtn.classList.remove('cuckoo-hidden');
    cancelBtn.textContent = opts.cancel || '取消';
    cancelBtn.classList.remove('cuckoo-hidden');
    function cleanup() {
      mask!.classList.add('cuckoo-hidden');
      okBtn.removeEventListener('click', onOk);
      altBtn.removeEventListener('click', onAlt);
      cancelBtn.removeEventListener('click', onCancel);
      mask!.removeEventListener('click', onMask);
      altBtn.classList.add('cuckoo-hidden');
    }
    function onOk() { cleanup(); resolve('primary'); }
    function onAlt() { cleanup(); resolve('alt'); }
    function onCancel() { cleanup(); resolve('cancel'); }
    function onMask(e: any) { if (e.target === mask) { cleanup(); resolve('cancel'); } }
    okBtn.addEventListener('click', onOk);
    altBtn.addEventListener('click', onAlt);
    cancelBtn.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    mask.classList.remove('cuckoo-hidden');
  });
}

export function ckAlert(message: string, title?: string): Promise<boolean> {
  return ckDialog({ title: title || '提示', message, confirm: false });
}

/**
 * 通用输入弹窗。返回输入值（取消/关闭返回 null）。
 * @param opts.multiline 多行模式（textarea）：Enter 换行，Ctrl/Cmd+Enter 提交
 */
export function ckPrompt(opts: { title?: string; placeholder?: string; value?: string; multiline?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = document.getElementById('input-modal');
    const titleEl = document.getElementById('input-modal-title');
    const inputEl = document.getElementById('input-modal-value') as any;
    const areaEl = document.getElementById('input-modal-textarea') as any;
    const okBtn = document.getElementById('input-modal-ok') as any;
    const cancelBtn = document.getElementById('input-modal-cancel') as any;
    if (!mask || !okBtn || !cancelBtn || !inputEl) { resolve(null); return; }
    const multi = !!opts.multiline && !!areaEl;
    // 按模式互斥显示单行 input / 多行 textarea
    const fieldEl = multi ? areaEl : inputEl;
    inputEl.classList.toggle('cuckoo-hidden', multi);
    if (areaEl) areaEl.classList.toggle('cuckoo-hidden', !multi);
    if (titleEl) titleEl.textContent = opts.title || '输入';
    fieldEl.placeholder = opts.placeholder || '';
    fieldEl.value = opts.value || '';
    function cleanup() {
      mask!.classList.add('cuckoo-hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      mask!.removeEventListener('click', onMask);
      fieldEl.removeEventListener('keydown', onKey);
    }
    function onOk() { const v = String(fieldEl.value || '').trim(); cleanup(); resolve(v || null); }
    function onCancel() { cleanup(); resolve(null); }
    function onMask(e: any) { if (e.target === mask) { cleanup(); resolve(null); } }
    function onKey(e: any) {
      if (multi) {
        // 多行：Ctrl/Cmd+Enter 提交，Esc 取消，普通 Enter 换行
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onOk(); }
        else if (e.key === 'Escape') { onCancel(); }
      } else {
        if (e.key === 'Enter') { e.preventDefault(); onOk(); }
        else if (e.key === 'Escape') { onCancel(); }
      }
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    fieldEl.addEventListener('keydown', onKey);
    mask.classList.remove('cuckoo-hidden');
    setTimeout(() => { fieldEl.focus(); try { fieldEl.select(); } catch (_) {} }, 50);
  });
}

// ===== HTML 转义 =====
// E-002/E-005：统一引用 overlay/sanitizer.ts 真源，不手维护第二份转义逻辑。
export { escapeHtml, escapeAttr } from '../../../overlay/sanitizer.js';

// ===== 数字格式化 =====
export function formatTokenCount(n: number): string {
  if (!isFinite(n) || n < 0) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(2) + '万';
  return String(Math.round(n));
}

export function formatTokenCountHTML(n: number): string {
  if (!isFinite(n) || n < 0) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(2) + '<span class="ck-token-unit-char">亿</span>';
  if (n >= 10000) return (n / 10000).toFixed(2) + '<span class="ck-token-unit-char">万</span>';
  return String(Math.round(n));
}

export function formatShort(n: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(Math.round(n));
}
