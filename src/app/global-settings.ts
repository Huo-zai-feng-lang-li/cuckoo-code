/**
 * 全局 Agent 设置（主进程权威源，跨窗口统一）。
 * 存储：<userDir>/agent-settings.json（CUCKOO_HOME 可覆盖）。
 *
 * 设计要点：
 *  - 主进程是唯一真相源；AI 页面 localStorage 仅作运行时缓存（hook/loop 同步读）。
 *  - 保存时主进程写文件 + 广播 cuckoo-sync-settings 到所有 AI 页面。
 *  - AI 页面 did-finish-load 时主动下发一次（新窗口/刷新后立即生效）。
 *  - 首次启动（文件不存在）从当前 AI 页面 localStorage 迁移，保留用户自定义；
 *    未自定义的字段由默认值填充，从而应用防封新默认。
 *
 * 时间字段单位：**秒**（与壳页面 UI / IPC 契约一致；hook/loop 内部存储为毫秒）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomicSync, readJsonRobustSync } from '../infra/atomic-json.js';

/** 与 overlay/panels/settings.ts 的 SettingsData 保持一致（UI 单位：秒） */
export interface AgentSettings {
  retryEnabled: boolean;
  retryDelayMin: number;
  retryDelayMax: number;
  retryCount: number;
  retry429Delay: number;
  retry429Count: number;
  retryPrompt: string;
  xhrIdleTimeout: number;
  watchdogPrompt: string;
  watchdogCount: number;
  sendDelayMin: number;
  sendDelayMax: number;
  attachDelayMin: number;
  attachDelayMax: number;
  goalMaxIterations: number;
  ssrfGuard: boolean;
  /** 子代理并发上限（1~10；默认 3） */
  maxConcurrentAgents: number;
  /** 子代理启动间隔区间（秒；0 = 不等待，默认 0） */
  agentStartIntervalMin: number;
  agentStartIntervalMax: number;
  /** 自动压缩上下文（默认 false） */
  autoCompactEnabled: boolean;
  /** 自动压缩阈值（单位：万 token，默认 80） */
  autoCompactThreshold: number;
}

/**
 * 防封优化后的默认值（相比旧默认收紧了节奏）：
 *  - retryCount: 10 → 3          失败连发从 10 次降到 3 次
 *  - retryDelay: 4~10s → 15~30s  重发间隔更像人
 *  - sendDelay: 1~10s → 6~16s    工具循环节奏降低（旧真值是 1~10s，见 LEGACY_DEFAULTS 注）
 *  - 其余（429/看门狗/附件间隔）保持原值，已合理
 */
export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
  retryEnabled: true,
  retryDelayMin: 15,
  retryDelayMax: 30,
  retryCount: 3,
  retry429Delay: 120,
  retry429Count: 1,
  retryPrompt: '刚才的回复似乎中断了，请重新完整回答上一个问题。',
  xhrIdleTimeout: 300,
  watchdogPrompt: '请继续',
  watchdogCount: 1,
  sendDelayMin: 6,
  sendDelayMax: 16,
  attachDelayMin: 1,
  attachDelayMax: 10,
  goalMaxIterations: 50,
  ssrfGuard: false,
  maxConcurrentAgents: 3,
  agentStartIntervalMin: 0,
  agentStartIntervalMax: 0,
  autoCompactEnabled: false,
  autoCompactThreshold: 80,
};

function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

export function getAgentSettingsFile(): string {
  return path.join(getUserDir(), 'agent-settings.json');
}

export function hasAgentSettingsFile(): boolean {
  try { return fs.existsSync(getAgentSettingsFile()); } catch (_) { return false; }
}

/** 规整：缺字段回退默认、时间/次数非负、文本非空、布尔严格 */
function normalize(raw: any): AgentSettings {
  const d = { ...AGENT_SETTINGS_DEFAULTS };
  if (!raw || typeof raw !== 'object') return d;
  const num = (v: any, def: number): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : def;
  };
  const nonNeg = (v: any, def: number): number => {
    const n = num(v, def);
    return n < 0 ? 0 : n;
  };
  const int = (v: any, def: number): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : def;
  };
  const str = (v: any, def: string): string => {
    if (typeof v !== 'string') return def;
    const t = v.trim();
    return t ? t : def;
  };
  let dmin = nonNeg(raw.retryDelayMin, d.retryDelayMin);
  let dmax = nonNeg(raw.retryDelayMax, d.retryDelayMax);
  if (dmax < dmin) dmax = dmin;
  let smin = nonNeg(raw.sendDelayMin, d.sendDelayMin);
  let smax = nonNeg(raw.sendDelayMax, d.sendDelayMax);
  if (smax < smin) smax = smin;
  // 先压上限再修关系：否则 amin=100 会产出 min=100 > max=60 的不合法区间
  let amin = Math.min(60, nonNeg(raw.attachDelayMin, d.attachDelayMin));
  let amax = Math.min(60, nonNeg(raw.attachDelayMax, d.attachDelayMax));
  if (amax < amin) amax = amin;
  // 子代理启动间隔：非负；max < min 时抬到 min
  const intervalMin = nonNeg(raw.agentStartIntervalMin, d.agentStartIntervalMin);
  let intervalMax = nonNeg(raw.agentStartIntervalMax, d.agentStartIntervalMax);
  if (intervalMax < intervalMin) intervalMax = intervalMin;
  return {
    // 严格布尔：只认 true / false，避免文件被手改成 'false'/'0' 时误判为开。
    // 缺字段时回退默认（不能用表达式兜底，否则 undefined 会被判成 false）。
    retryEnabled: raw.retryEnabled === undefined ? d.retryEnabled
      : (raw.retryEnabled === true || raw.retryEnabled === 'true'),
    retryDelayMin: dmin,
    retryDelayMax: dmax,
    retryCount: int(raw.retryCount, d.retryCount),
    retry429Delay: nonNeg(raw.retry429Delay, d.retry429Delay),
    retry429Count: int(raw.retry429Count, d.retry429Count),
    retryPrompt: str(raw.retryPrompt, d.retryPrompt),
    xhrIdleTimeout: nonNeg(raw.xhrIdleTimeout, d.xhrIdleTimeout),
    watchdogPrompt: str(raw.watchdogPrompt, d.watchdogPrompt),
    watchdogCount: int(raw.watchdogCount, d.watchdogCount),
    sendDelayMin: smin,
    sendDelayMax: smax,
    attachDelayMin: amin,
    attachDelayMax: amax,
    goalMaxIterations: (() => {
      const v = int(raw.goalMaxIterations, d.goalMaxIterations);
      return v > 0 ? v : d.goalMaxIterations;
    })(),
    ssrfGuard: raw.ssrfGuard === true,
    // 子代理并发：1~10（<1 或非数字回退默认 3；>10 压到 10）
    maxConcurrentAgents: (() => {
      const v = int(raw.maxConcurrentAgents, d.maxConcurrentAgents);
      if (v < 1) return d.maxConcurrentAgents;
      if (v > 10) return 10;
      return v;
    })(),
    agentStartIntervalMin: intervalMin,
    agentStartIntervalMax: intervalMax,
    autoCompactEnabled: raw.autoCompactEnabled === undefined ? d.autoCompactEnabled
      : (raw.autoCompactEnabled === true || raw.autoCompactEnabled === 'true'),
    autoCompactThreshold: nonNeg(raw.autoCompactThreshold, d.autoCompactThreshold),
  };
}

/** 旧版默认值：迁移时用于判断"用户是否真的自定义过" */
const LEGACY_DEFAULTS = {
  retryDelayMin: 4,
  retryDelayMax: 10,
  retryCount: 10,
  // 注意：旧版 state.ts / getSettingsData 的 sendDelay 默认是 1000/10000 **毫秒**，
  // 换算为 SettingsData 的秒单位即 1 / 10 秒。需求文档里写的「4-12」是目标值，
  // 不是旧默认；若此处误写成 4/12，老用户（localStorage 存 1000/10000 → 1/10 秒）
  // 将不被 migrateLegacy 命中，防封新默认对其完全失效。
  sendDelayMin: 1,
  sendDelayMax: 10,
};

/**
 * 首次从 AI 页面 localStorage 迁移时的兼容处理。
 * 老用户 localStorage 里可能存着旧默认值（如 4000ms/10 次）——那是"从未自定义"的痕迹，
 * 若原样保留，防封优化对老用户完全无效。故：恰好等于旧默认值的字段替换为新默认；
 * 用户真实自定义过的值（偏离旧默认）原样保留。
 */
export function migrateLegacy(raw: any): AgentSettings {
  const n = normalize(raw);
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (same(n.retryDelayMin, LEGACY_DEFAULTS.retryDelayMin) && same(n.retryDelayMax, LEGACY_DEFAULTS.retryDelayMax)) {
    n.retryDelayMin = AGENT_SETTINGS_DEFAULTS.retryDelayMin;
    n.retryDelayMax = AGENT_SETTINGS_DEFAULTS.retryDelayMax;
  }
  if (same(n.retryCount, LEGACY_DEFAULTS.retryCount)) n.retryCount = AGENT_SETTINGS_DEFAULTS.retryCount;
  if (same(n.sendDelayMin, LEGACY_DEFAULTS.sendDelayMin) && same(n.sendDelayMax, LEGACY_DEFAULTS.sendDelayMax)) {
    n.sendDelayMin = AGENT_SETTINGS_DEFAULTS.sendDelayMin;
    n.sendDelayMax = AGENT_SETTINGS_DEFAULTS.sendDelayMax;
  }
  return n;
}

/**
 * 把增量设置合并到最新全量设置上（不落盘，纯函数）。
 *
 * 为什么需要：设置已全局化后，多个窗口可能并发保存**不同字段**。
 * 若各自提交全量快照，后保存的会用自己窗口的旧值覆盖对方刚写的字段。
 * 因此壳页面只提交变更字段（delta），主进程用「最新文件值 + delta」合并。
 *
 * @param latest 当前全局设置（应尽量新鲜：调用方在 await 之后重新读取）
 * @param delta 本次变更的字段（只含变更项）
 */
export function applyDelta(latest: any, delta: any): AgentSettings {
  const base = normalize(latest);
  const d = (delta && typeof delta === 'object') ? delta : {};
  // 只允许增量里显式出现的字段覆盖；未出现的字段保留 base 值。
  // 注意：undefined 视为"未提供"（JSON 序列化会丢 undefined，不能当变更）。
  const merged: any = { ...base };
  for (const k of Object.keys(d)) {
    if (d[k] !== undefined) merged[k] = d[k];
  }
  return normalize(merged);
}

let cached: AgentSettings | null = null;

export function readAgentSettings(): AgentSettings {
  if (cached) return cached;
  const o = readJsonRobustSync<any>(getAgentSettingsFile(), null);
  cached = normalize(o);
  return cached;
}

export function writeAgentSettings(raw: any): AgentSettings {
  const next = normalize(raw);
  writeJsonAtomicSync(getAgentSettingsFile(), next, { keepBackup: true });
  cached = next;
  return next;
}

/** 测试用：清空内存缓存（生产不需要调用） */
export function _clearCache(): void { cached = null; }
