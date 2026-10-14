/**
 * 模态守护：壳页面的全屏覆盖层（模态框 / Lightbox）会被 AI 视图挡住。
 *
 * 根因：AI 页面是 WebContentsView（**原生视图**），永远压在 DOM 之上，
 * CSS z-index 对它无效。所以只要壳页面有全屏覆盖层可见，就必须临时隐藏 AI 视图。
 *
 * 做法：MutationObserver 监听 body 子树（class 变化 + 新节点），
 * 统计可见覆盖层数量 —— 有则隐藏、无则恢复（幂等 + rAF 防抖）。
 *
 * 覆盖：所有 .ck-modal-mask（通用确认框 / 各页弹窗）+ #ck-lightbox（图片全屏）
 */
import { api } from './shared.js';

const OVERLAY_SELECTORS = [
  '.ck-modal-mask:not(.cuckoo-hidden)',
  '#ck-lightbox',
];

/** 上一次的"AI 视图是否可见"状态（初始可见） */
let lastVisible = true;
let pending = false;

function anyOverlayVisible(): boolean {
  for (const sel of OVERLAY_SELECTORS) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        // #git-diff-modal 由 git.ts 的 setWebviewHidden 单独处理（能同时隐藏 AI/harness/overlay），
        // 此处排除，避免两套机制并存：关闭时 modal-guard 会把 git 弹框隐藏的视图抢显。
        if ((el as any).id === 'git-diff-modal') continue;
        return true;
      }
    } catch (_) { /* ignore */ }
  }
  return false;
}

function sync(): void {
  const shouldShowAi = !anyOverlayVisible();
  if (shouldShowAi === lastVisible) return;
  lastVisible = shouldShowAi;
  try { (api as any).setWebViewVisible?.(shouldShowAi); } catch (_) { /* ignore */ }
}

function schedule(): void {
  if (pending) return;
  pending = true;
  try {
    requestAnimationFrame(() => { pending = false; sync(); });
  } catch (_) {
    pending = false;
    sync();
  }
}

export function initModalGuard(): void {
  try {
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true,
      childList: true,
    });
    sync();
  } catch (_) { /* ignore */ }
}
