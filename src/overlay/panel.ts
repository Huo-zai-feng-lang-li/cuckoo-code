/**
 * 覆盖层 UI 基础能力：注入、提示、工具提示条、首次引导框
 * 由原 preload.js 拆分而来。
 *
 * 注：原注入式面板 / 悬浮球 / 命令历史 / 状态徽章等 UI 已随迁移到壳页面而废弃
 * （见 commit 92c5abc），本文件只保留仍在用的能力。
 */
import { OVERLAY_HTML, OVERLAY_CSS } from './template.generated.js';
import { getProviderByUrl } from '../providers/registry.js';
import { state } from './state.js';

// ========== 注入样式 ==========
/**
 * 注入覆盖层 CSS 样式到页面头部
 */
function injectCSS(): void {
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
}

// ========== 注入覆盖层 HTML ==========
/**
 * 注入覆盖层 HTML 到页面 body
 * 创建 cuckoo-root 容器并填充 OVERLAY_HTML 内容
 */
function injectOverlay(): void {
  const container = document.createElement('div');
  container.id = 'cuckoo-root';
  // ChatGPT/Google 页面启用 Trusted Types，应用内置模板需要先转成 TrustedHTML。
  setTrustedHtml(container, OVERLAY_HTML);
  document.body.appendChild(container);
}

// ========== 覆盖层逻辑 ==========

/**
 * 截断文本到指定长度，超出部分以 ... 结尾
 * @param text - 要截断的文本
 * @param maxLen - 最大长度，默认 50
 * @returns 截断后的文本
 */
function truncate(text: any, maxLen: number = 50): string {
  if (!text || text.length <= maxLen) return text || '';
  return text.substring(0, maxLen) + '...';
}

/**
 * HTML 转义，防止 XSS 攻击
 * @param text - 要转义的文本
 * @returns 转义后的 HTML 字符串
 */
function escapeHtml(text: any): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

let trustedHtmlPolicy: any = null;

/**
 * 将应用自有模板交给 Trusted Types；普通网页没有该 API 时保持原有行为。
 * 模板不包含网页输入，动态文本在进入模板前仍由 escapeHtml 转义。
 */
function toTrustedHtml(value: string): any {
  const trustedTypes = (window as any).trustedTypes;
  if (!trustedTypes || typeof trustedTypes.createPolicy !== 'function') return value;
  try {
    if (!trustedHtmlPolicy) {
      trustedHtmlPolicy = trustedTypes.createPolicy('cuckoo-overlay', {
        createHTML: (input: string) => input,
      });
    }
    return trustedHtmlPolicy.createHTML(value);
  } catch (_) {
    // CSP 可能禁止创建自定义策略；保留字符串让非强制 Trusted Types 页面继续工作。
    return value;
  }
}

function setTrustedHtml(element: HTMLElement, value: string): void {
  (element as any).innerHTML = toTrustedHtml(value);
}

/**
 * 显示浮动提示弹窗
 * @param text - 提示文本
 * @param duration - 显示时长（毫秒），默认 2200
 */
function showToast(text: string, duration: number = 2200): void {
  let toast = document.getElementById('cuckoo-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cuckoo-toast';
    toast.className = 'cuckoo-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  requestAnimationFrame(() => toast!.classList.add('show'));
  clearTimeout((showToast as any)._timer);
  (showToast as any)._timer = setTimeout(() => {
    toast!.classList.remove('show');
  }, duration);
}

/**
 * 显示带确认/取消按钮的持久提示框（不点击就一直存在）
 * @param text - 提示文本
 * @param options - 可选配置
 * @returns 用户点确定 resolve(true)，点取消 resolve(false)
 */
function showConfirmDialog(text: string, options?: { okText?: string; showCancel?: boolean; cancelText?: string }): Promise<boolean> {
  const opts = options || {};
  const okText = opts.okText || '确定';
  const showCancel = !!opts.showCancel;
  const cancelText = opts.cancelText || '取消';

  // 移除旧弹窗
  const old = document.getElementById('cuckoo-confirm-dialog');
  if (old) old.remove();

  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.id = 'cuckoo-confirm-dialog';
    dialog.style.cssText = `
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483648;
      min-width: 280px; max-width: 380px;
      background: rgba(22, 24, 44, 0.96);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(139, 147, 255, 0.35);
      border-radius: 14px;
      padding: 20px 18px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      color: #dde1ff; font-size: 13px; line-height: 1.6;
      box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55);
      text-align: center;
    `;
    const cancelBtnHtml = showCancel
      ? `<button id="cuckoo-confirm-cancel" style="
          padding: 9px 24px; border: 1px solid rgba(139,147,255,0.4); border-radius: 10px;
          background: transparent; color: #aab0ff;
          font-size: 13px; font-weight: 600; cursor: pointer;
          margin-right: 10px; transition: all 0.2s;
        ">${escapeHtml(cancelText)}</button>`
      : '';
    setTrustedHtml(dialog, `
      <div style="margin-bottom:16px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</div>
      <div>${cancelBtnHtml}
        <button id="cuckoo-confirm-ok" style="
          padding: 9px 28px; border: none; border-radius: 10px;
          background: linear-gradient(135deg, #8b93ff, #6d76ff); color: #fff;
          font-size: 13px; font-weight: 600; cursor: pointer;
          transition: all 0.2s;
        ">${escapeHtml(okText)}</button>
      </div>
    `);
    document.body.appendChild(dialog);

    const cleanup = () => dialog.remove();
    dialog.querySelector('#cuckoo-confirm-ok')!.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });
    if (showCancel) {
      dialog.querySelector('#cuckoo-confirm-cancel')!.addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
    }
  });
}

// ========== 工具调用提示条（非阻塞）==========

/**
 * 显示工具调用提示条
 * @param onCancel 传入时显示「停止」按钮，点击触发该回调
 */
function showToolMask(onCancel?: () => void): void {
  const el = document.getElementById('cuckoo-tool-mask');
  if (el) el.classList.remove('cuckoo-hidden');
  const btn = document.getElementById('cuckoo-tool-mask-cancel') as any;
  if (btn) {
    if (onCancel) {
      btn.classList.remove('cuckoo-hidden');
      btn.onclick = () => { try { onCancel(); } catch (_) { /* ignore */ } };
    } else {
      btn.classList.add('cuckoo-hidden');
      btn.onclick = null;
    }
  }
}

/**
 * 隐藏工具调用提示条
 */
function hideToolMask(): void {
  const el = document.getElementById('cuckoo-tool-mask');
  if (el) el.classList.add('cuckoo-hidden');
  const btn = document.getElementById('cuckoo-tool-mask-cancel') as any;
  if (btn) { btn.classList.add('cuckoo-hidden'); btn.onclick = null; }
}

// ========== 首页模式 / 首次引导框 ==========

// 抑制首页模式（子代理窗口用：它在"新对话"页，但需要显示完整面板）
let suppressHomeMode = false;

/** 设置是否抑制首页模式（子代理窗口调用） */
function setSuppressHomeMode(v: boolean): void {
  suppressHomeMode = !!v;
}

/**
 * 根据当前 URL 切换首次引导框显隐
 * 首页（未初始化/新对话）→ 显示；其他 → 隐藏
 */
function updateHomeMode(): void {
  const url = window.location.href;
  const provider = getProviderByUrl(url);
  const isHome = !suppressHomeMode && provider && provider.homeUrlPattern ? provider.homeUrlPattern.test(url) : false;
  if (isHome) {
    showFirstTimeDialog();
  } else {
    hideFirstTimeDialog();
  }
}

/**
 * 显示首次使用提示浮窗（居中）
 */
function showFirstTimeDialog(): void {
  if (state.currentProjectDir) {
    hideFirstTimeDialog();
    return;
  }
  const dialog = document.getElementById('cuckoo-first-time-dialog');
  if (dialog) dialog.classList.remove('cuckoo-hidden');
}

/**
 * 隐藏首次使用提示浮窗
 */
function hideFirstTimeDialog(): void {
  const dialog = document.getElementById('cuckoo-first-time-dialog');
  if (dialog) dialog.classList.add('cuckoo-hidden');
}

export {
  injectCSS,
  injectOverlay,
  truncate,
  escapeHtml,
  showToast,
  showConfirmDialog,
  showToolMask,
  hideToolMask,
  updateHomeMode,
  setSuppressHomeMode,
  showFirstTimeDialog,
  hideFirstTimeDialog,
};
