/**
 * 活动栏图标显隐：用户在设置页逐个开关，控制左侧活动栏显示哪些图标。
 *
 * 存储：localStorage['cuckoo-activitybar-hidden'] = 隐藏的 tab key 数组。
 * 与「溢出」（activitybar-overflow）区分：
 *   - 用户隐藏（本模块）：`.ck-ab-user-hidden`（display:none），**不进**「⋯」弹框。
 *   - 溢出隐藏：`.ck-ab-of-hidden`，仍可在「⋯」弹框里点。
 *
 * settings 不可隐藏（否则用户无法再打开设置恢复，形成死锁）。
 */
import { refreshActivitybarOverflow } from './activitybar-overflow.js';

const STORAGE_KEY = 'cuckoo-activitybar-hidden';
const USER_HIDDEN_CLS = 'ck-ab-user-hidden';
/** 不可隐藏的 tab（防死锁）：设置页本身 */
const PROTECTED = ['settings'];

export function getHiddenTabs(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x: any) => typeof x === 'string') : [];
  } catch (_) {
    return [];
  }
}

function setHiddenTabs(list: string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
}

/** 把隐藏列表应用到 DOM（幂等），并重算溢出。 */
export function applyActivitybarVisibility(): void {
  const bar = document.querySelector('.ck-activitybar');
  if (!bar) return;
  const hidden = new Set(getHiddenTabs());
  bar.querySelectorAll('.ck-ab-item').forEach((el: any) => {
    const tab = el.dataset ? el.dataset.tab : '';
    if (!tab) return; // 「⋯」按钮等无 data-tab
    const shouldHide = hidden.has(tab) && !PROTECTED.includes(tab);
    el.classList.toggle(USER_HIDDEN_CLS, shouldHide);
  });
  // 隐藏项不再占主区名额 → 重算溢出
  try { refreshActivitybarOverflow(); } catch (_) { /* ignore */ }
}

/** 切换某个 tab 的显隐（设置页开关调用）。 */
export function toggleTab(tab: string, visible: boolean): void {
  if (!tab || PROTECTED.includes(tab)) return;
  const list = new Set(getHiddenTabs());
  if (visible) list.delete(tab); else list.add(tab);
  setHiddenTabs([...list]);
  applyActivitybarVisibility();
}

export function initActivitybarVisibility(): void {
  applyActivitybarVisibility();
}
