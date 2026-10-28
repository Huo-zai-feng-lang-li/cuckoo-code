/**
 * 壳页面布局跨窗口同步（侧栏宽度 / 活动栏顺序 / 活动栏显隐）。
 *
 * 背景：壳页面 localStorage 按 partition 隔离，不同 profile 的窗口互不相通，
 * 导致"A 窗口拖宽侧栏，B 窗口不知道"。本模块把布局变更上报主进程（ui-prefs.json），
 * 主进程广播给所有壳页面，各页面写回自己的 localStorage 并重新应用。
 *
 * 依赖方向：本模块只依赖 shared.js（api），不反向依赖具体页面模块。
 */
import { api } from './shared.js';

type Applier = (value: string) => void;

const appliers: Record<string, Applier> = {};

/**
 * 注册某个布局键的应用函数。
 * @param key localStorage 键
 * @param apply 收到新值时的应用逻辑（需幂等）
 */
export function registerLayoutKey(key: string, apply: Applier): void {
  appliers[key] = apply;
}

/**
 * 正在应用远端布局：为 true 时 pushLayout 直接返回。
 * 否则"收到广播 → 写 localStorage → 应用函数触发保存 → 再次上报 → 再次广播"会无限回环。
 */
let applying = false;

/** 把布局变更上报主进程（由主进程广播到所有窗口，含本窗口） */
export function pushLayout(key: string, value: string): void {
  if (applying) return; // 防回环
  if (!api.setUiPrefs) return;
  const patch: any = {};
  patch[key] = value;
  try {
    api.setUiPrefs({ shellLayout: patch }).catch(() => { /* ignore */ });
  } catch (_) { /* ignore */ }
}

/** 应用一份布局（写入本窗口 localStorage + 调用注册的应用函数） */
function applyLayout(layout: any): void {
  if (!layout || typeof layout !== 'object') return;
  applying = true;
  try {
    for (const key of Object.keys(layout)) {
      const apply = appliers[key];
      const value = layout[key];
      if (!apply || typeof value !== 'string') continue;
      // 值未变 → 本窗口已是该状态，跳过 apply。
      // 避免"本窗口刚改完，广播回来又重排一次 AI 视图"以及启动时的无谓重排。
      let same = false;
      try { same = localStorage.getItem(key) === value; } catch (_) { /* ignore */ }
      try {
        localStorage.setItem(key, value);
      } catch (_) { /* ignore */ }
      if (same) continue;
      try { apply(value); } catch (_) { /* ignore */ }
    }
  } finally {
    applying = false;
  }
}

/**
 * 启动同步：
 *  1) 从主进程拉一次全局布局，覆盖本窗口 localStorage（新窗口/首次启动对齐）
 *  2) 订阅后续变更广播
 */
export function initLayoutSync(): void {
  if (api.getUiPrefs) {
    try {
      api.getUiPrefs().then((r: any) => {
        if (r && r.success && r.data) applyLayout(r.data.shellLayout);
      }).catch(() => { /* ignore */ });
    } catch (_) { /* ignore */ }
  }
  if (api.onShellLayoutChanged) {
    try { api.onShellLayoutChanged((layout: any) => applyLayout(layout)); } catch (_) { /* ignore */ }
  }
}
