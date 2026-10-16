/**
 * 新建对话 loading 遮罩
 *
 * 为什么需要：点顶部「+」后，主进程要导航到首页 + 等 2s + 注入系统提示词，
 * 期间页面停留在空白首页，无任何反馈。此遮罩给出"正在新建"的明确状态。
 *
 * 实现要点：用 `.ck-modal-mask`（复用 modal-guard：其可见时会自动隐藏 AI WebContentsView，
 * 否则壳页面 DOM 遮罩会被原生视图盖住看不见）。
 *
 * 生命周期：点「+」→ 显示；主进程完成（initProject 结束 / 导航完成 / 出错）→ 隐藏；
 * 另有 15s 安全兜底防卡死。
 */
import { api } from './shared.js';

let maskEl: HTMLElement | null = null;
let safetyTimer: any = null;

function ensure(): HTMLElement | null {
  if (!maskEl) maskEl = document.getElementById('newconv-mask');
  return maskEl;
}

export function showNewConvLoading(): void {
  const el = ensure();
  if (el) el.classList.remove('cuckoo-hidden');
  if (safetyTimer) clearTimeout(safetyTimer);
  safetyTimer = setTimeout(hideNewConvLoading, 15000);
}

export function hideNewConvLoading(): void {
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  const el = ensure();
  if (el) el.classList.add('cuckoo-hidden');
}

export function initNewConvLoading(): void {
  // 主进程完成新建对话（成功/失败/无项目导航完）→ 隐藏
  const anyApi = api as any;
  if (typeof anyApi.onNewConvDone === 'function') {
    anyApi.onNewConvDone(() => hideNewConvLoading());
  }
}
