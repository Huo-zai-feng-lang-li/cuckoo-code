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
 *  - 其余（429/看门狗）保持原值，已合理
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
  goalMaxIterations: 50,
  ssrfGuard: false,
  maxConcurrentAgents: 3,
  // 需求 100：默认不再是 0 —— 同账号多路子代理同时开 SSE 是明显机器人特征。
  // 2~5 秒随机间隔足以打散"并发启动"，对正常使用几乎无感。
  agentStartIntervalMin: 2,
  agentStartIntervalMax: 5,
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

/** 数值解析：非数字回退默认 */
function toNum(v: any, def: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : def;
}

/** 非负数值：负数归零 */
function toNonNeg(v: any, def: number): number {
  const n = toNum(v, def);
  return n < 0 ? 0 : n;
}

/** 整数解析：非整数回退默认 */
function toInt(v: any, def: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

/** 非空文本：非字符串或全空白回退默认 */
function toStr(v: any, def: string): string {
  if (typeof v !== 'string') return def;
  const t = v.trim();
  return t ? t : def;
}

/**
 * 严格布尔：只认 true / 'true'，避免文件被手改成 'false'/'0' 时误判为开。
 * 缺字段（undefined）回退默认 —— 不能用表达式兜底，否则 undefined 会被判成 false。
 */
function toBool(v: any, def: boolean): boolean {
  if (v === undefined) return def;
  return v === true || v === 'true';
}

/**
 * 区间规整：两端都非负；max < min 时把 max 抬到 min。
 * 返回 [min, max]，供解构赋值直接对应到设置字段。
 */
function toRange(rawMin: any, rawMax: any, defMin: number, defMax: number): [number, number] {
  const min = toNonNeg(rawMin, defMin);
  const max = toNonNeg(rawMax, defMax);
  return max < min ? [min, min] : [min, max];
}

/** 正整数：非正回退默认（如 goalMaxIterations 必须 > 0） */
function toPositiveInt(v: any, def: number): number {
  const n = toInt(v, def);
  return n > 0 ? n : def;
}

/** 并发上限：1~10 合法；<1 或非数字回退默认，>10 压到 10 */
function toConcurrency(v: any, def: number): number {
  const n = toInt(v, def);
  if (n < 1) return def;
  return n > 10 ? 10 : n;
}

/** 规整：缺字段回退默认、时间/次数非负、文本非空、布尔严格 */
function normalize(raw: any): AgentSettings {
  const d = { ...AGENT_SETTINGS_DEFAULTS };
  if (!raw || typeof raw !== 'object') return d;

  const [retryDelayMin, retryDelayMax] = toRange(raw.retryDelayMin, raw.retryDelayMax, d.retryDelayMin, d.retryDelayMax);
  const [sendDelayMin, sendDelayMax] = toRange(raw.sendDelayMin, raw.sendDelayMax, d.sendDelayMin, d.sendDelayMax);
  const [agentStartIntervalMin, agentStartIntervalMax] = toRange(
    raw.agentStartIntervalMin, raw.agentStartIntervalMax,
    d.agentStartIntervalMin, d.agentStartIntervalMax,
  );

  return {
    retryEnabled: toBool(raw.retryEnabled, d.retryEnabled),
    retryDelayMin,
    retryDelayMax,
    retryCount: toInt(raw.retryCount, d.retryCount),
    retry429Delay: toNonNeg(raw.retry429Delay, d.retry429Delay),
    retry429Count: toInt(raw.retry429Count, d.retry429Count),
    retryPrompt: toStr(raw.retryPrompt, d.retryPrompt),
    xhrIdleTimeout: toNonNeg(raw.xhrIdleTimeout, d.xhrIdleTimeout),
    watchdogPrompt: toStr(raw.watchdogPrompt, d.watchdogPrompt),
    watchdogCount: toInt(raw.watchdogCount, d.watchdogCount),
    sendDelayMin,
    sendDelayMax,
    goalMaxIterations: toPositiveInt(raw.goalMaxIterations, d.goalMaxIterations),
    ssrfGuard: raw.ssrfGuard === true,
    maxConcurrentAgents: toConcurrency(raw.maxConcurrentAgents, d.maxConcurrentAgents),
    agentStartIntervalMin,
    agentStartIntervalMax,
    autoCompactEnabled: toBool(raw.autoCompactEnabled, d.autoCompactEnabled),
    autoCompactThreshold: toNonNeg(raw.autoCompactThreshold, d.autoCompactThreshold),
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
  // 子代理启动间隔的旧默认是 0/0（= 完全不打散）。恰好等于旧默认的视为"从未自定义"，
  // 迁移到新的 2/5（需求 100）。
  agentStartIntervalMin: 0,
  agentStartIntervalMax: 0,
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
  // 子代理启动间隔：旧默认 0/0 表示"从未自定义"，迁移到 2/5。
  // 用户真实自定义过的值（如 10/20）原样保留。
  if (same(n.agentStartIntervalMin, LEGACY_DEFAULTS.agentStartIntervalMin) &&
      same(n.agentStartIntervalMax, LEGACY_DEFAULTS.agentStartIntervalMax)) {
    n.agentStartIntervalMin = AGENT_SETTINGS_DEFAULTS.agentStartIntervalMin;
    n.agentStartIntervalMax = AGENT_SETTINGS_DEFAULTS.agentStartIntervalMax;
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
