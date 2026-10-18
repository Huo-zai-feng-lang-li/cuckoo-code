/**
 * 窗口切回时自动跟随到底部（智能版）。
 *
 * 背景：AI 对话在 WebContentsView 里渲染，滚动完全由 AI 网页自己管，
 * 主进程看不到 DOM。用户切到别的窗口后 AI 继续回复，切回来时往往停在
 * 离开时的位置，看不到新回复。
 *
 * 本模块在页面内（preload 环境）监听可见性变化：
 *  - 离开：记录主滚动容器的 scrollTop / scrollHeight，以及是否在底部附近
 *  - 回来：若内容变高（有新消息）且离开时在底部附近 → 平滑滚到底
 *  - 若离开时在翻历史（不在底部）→ 不动，避免打断阅读
 *
 * 兼容性：所有平台通用（不依赖具体类名），通过 overflowY + scrollHeight 探测主滚动容器。
 */

/** 容器最小溢出量（低于此不认为是主滚动区） */
const MIN_OVERFLOW = 80;
/** 距底部多少像素内算"在底部附近" */
const BOTTOM_THRESHOLD = 80;

/** Cuckoo 自身注入到 body 的根节点 id（扫描主滚动容器时必须排除，否则短会话时会选错设置面板等） */
const CUCKOO_ROOT_IDS = ['cuckoo-root', 'cuckoo-toast', 'cuckoo-confirm-dialog', 'cuckoo-retry-countdown'];
/** 插件 UI 根节点 id 前缀（ui-runtime.ts 的 UI_ROOT_PREFIX） */
const CUCKOO_PLUGIN_PREFIX = 'cuckoo-plugin-ui-';

/** 收集当前页面所有 Cuckoo 注入的根节点 */
function collectCuckooRoots(): HTMLElement[] {
  const roots: HTMLElement[] = [];
  for (const id of CUCKOO_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el) roots.push(el);
  }
  const plugins = document.querySelectorAll<HTMLElement>('[id^="' + CUCKOO_PLUGIN_PREFIX + '"]');
  for (let i = 0; i < plugins.length; i++) roots.push(plugins[i]);
  return roots;
}

/** 某元素是否在任一 Cuckoo 根节点内 */
function isInsideAny(el: HTMLElement, roots: HTMLElement[]): boolean {
  for (let i = 0; i < roots.length; i++) {
    if (roots[i].contains(el)) return true;
  }
  return false;
}

/** 离开时的滚动快照 */
export interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  /** 离开时是否在底部附近（决定回来后是否跟随） */
  nearBottom: boolean;
}

/**
 * 决策：是否应该跟随到底部。
 * 纯函数，便于单测；不含任何 DOM 依赖。
 * @param snap 离开时的快照（null 表示从未离开或无可滚动容器）
 * @param currentScrollHeight 回来时的内容总高度
 */
export function shouldFollowToBottom(snap: ScrollSnapshot | null, currentScrollHeight: number): boolean {
  if (!snap || !snap.nearBottom) return false;
  return currentScrollHeight > snap.scrollHeight + 1;
}

/** 找当前页面的主滚动容器：scrollHeight 超出最多且 overflowY 可滚动的元素 */
function findScrollContainer(): HTMLElement | null {
  const roots = collectCuckooRoots();
  let best: HTMLElement | null = null;
  let bestDiff = 0;
  const all = document.querySelectorAll<HTMLElement>('body *');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    // 排除 Cuckoo 自己注入的 DOM（设置面板/历史列表/MCP 列表等也有 overflow:auto，
    // 会话很短时它们的溢出量可能大于主对话区，导致选错容器滚错地方）
    if (roots.length > 0 && isInsideAny(el, roots)) continue;
    const diff = el.scrollHeight - el.clientHeight;
    if (diff <= MIN_OVERFLOW) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    if (diff > bestDiff) { bestDiff = diff; best = el; }
  }
  // 回退：文档级滚动
  if (!best) {
    const se = document.scrollingElement as HTMLElement | null;
    if (se && se.scrollHeight > se.clientHeight) best = se;
  }
  return best;
}

/** 容器是否接近底部 */
function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
}

/** 平滑滚到底部（不支持 smooth 的环境回退为瞬时） */
function scrollToBottom(el: HTMLElement): void {
  try {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  } catch (_) {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * 页面初次载入或会话切换后，多次尝试寻找主滚动容器并平滑滚到底部。
 * 针对打开窗口时 AI 官方网页（如 ChatGPT, Claude, DeepSeek）停留在顶部的问题进行平滑矫正。
 */
export function scheduleInitialScrollToBottom(onDone?: () => void): () => void {
  let attempts = 0;
  const maxAttempts = 4;
  const delays = [150, 450, 900, 1800];
  let timer: any = null;
  let canceled = false;

  function tryScroll(): void {
    if (canceled) return;
    attempts++;
    const el = findScrollContainer();
    if (el && el.scrollHeight > el.clientHeight + MIN_OVERFLOW) {
      scrollToBottom(el);
    }
    if (attempts < maxAttempts && !canceled) {
      timer = setTimeout(tryScroll, delays[attempts] || 1000);
    } else if (onDone && !canceled) {
      onDone();
    }
  }

  timer = setTimeout(tryScroll, delays[0]);
  return () => {
    canceled = true;
    if (timer) clearTimeout(timer);
  };
}

/** 当前活动实例的状态重置函数（startScrollFollow 挂载时设置） */
let resetScrollFollowState: (() => void) | null = null;

/**
 * 页面 URL/会话切换时调用：清空滚动容器缓存与离开快照，并重新调度滚底。
 * 避免 SPA 切会话后缓存仍指向旧容器（旧节点可能以 visibility:hidden 保留在 DOM 中）。
 */
export function resetScrollFollow(): void {
  if (resetScrollFollowState) resetScrollFollowState();
}

/**
 * 启动滚动跟随（幂等：重复调用只挂一次监听）。
 * @returns cleanup 函数：解绑全部监听并复位幂等标志（测试用；生产环境无需调用）
 */
let started = false;
export function startScrollFollow(): () => void {
  if (started) return () => { /* 已被占用，无操作 */ };
  started = true;

  let snapshot: ScrollSnapshot | null = null;
  let cached: HTMLElement | null = null;
  let hidden = false;

  // 初次启动：调度初始滚底，让打开窗口后的历史会话直达最新回复
  let cancelInitScroll = scheduleInitialScrollToBottom();

  // 供 URL/会话变化时清空缓存与快照并重新寻底：SPA 切会话后旧容器可能仍 connected（visibility:hidden 保留），
  // 缓存会指向旧容器，导致回来时判据失真。由 entry.ts 的 handleUrlChanged 调用。
  resetScrollFollowState = () => {
    cached = null;
    snapshot = null;
    if (cancelInitScroll) cancelInitScroll();
    cancelInitScroll = scheduleInitialScrollToBottom();
  };

  function container(): HTMLElement | null {
    // 缓存的容器仍连接且仍可滚动 → 复用；否则重新探测
    if (cached && cached.isConnected && cached.scrollHeight > cached.clientHeight) return cached;
    cached = findScrollContainer();
    return cached;
  }

  function onHide(): void {
    const el = container();
    if (!el) { snapshot = null; return; }
    snapshot = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      nearBottom: isNearBottom(el),
    };
  }

  function onShow(): void {
    const snap = snapshot;
    snapshot = null;
    if (!snap || !snap.nearBottom) return;
    // 两帧后再判断：让新内容先完成布局（scrollHeight 更新）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = container();
      if (!el) return;
      if (shouldFollowToBottom(snap, el.scrollHeight)) scrollToBottom(el);
    }));
  }

  // 去重：visibilitychange 与 window blur/focus 可能同时触发
  function markHidden(): void {
    if (hidden) return;
    hidden = true;
    onHide();
  }
  function markVisible(): void {
    if (!hidden) return;
    hidden = false;
    onShow();
  }

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') markHidden();
    else markVisible();
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Electron 里 backgroundThrottling:false 时，窗口失焦不触发 visibilitychange，
  // 必须补 window blur/focus（窗口级失焦，不含页面内元素失焦）
  window.addEventListener('blur', markHidden);
  window.addEventListener('focus', markVisible);

  return () => {
    if (cancelInitScroll) cancelInitScroll();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', markHidden);
    window.removeEventListener('focus', markVisible);
    resetScrollFollowState = null;
    started = false;
  };
}
