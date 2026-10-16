/**
 * UI 偏好（主进程直存，不依赖 AI 页面 localStorage）。
 * 存储：<userDir>/ui-prefs.json（CUCKOO_HOME 可覆盖）。
 *
 * 目前：
 *   - harnessZoom：纯净模式缩放（0.8 ~ 1.6，默认 1.0）
 *   - promptEnhancer：纯净模式提示词增强配置
 *
 * API Key 默认空（源码不硬编码任何密钥，开源安全）；用户在设置里填写后存 ui-prefs.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PromptEnhancerConfig {
  /** 是否显示增强按钮 */
  enabled: boolean;
  /** OpenAI 兼容 API 基址（不含 /chat/completions） */
  apiUrl: string;
  /** API Key（默认空，由用户在设置里填写） */
  apiKey: string;
  /** 模型名 */
  model: string;
  /** 增强力度：gentle=温和（缺啥补啥）/ strict=激进（强制结构化） */
  mode: 'gentle' | 'strict';
  /** 携带最近几轮对话作为上下文（0 = 不带） */
  contextRounds: number;
  /** 自定义增强系统提示词（空 = 用内置模板） */
  systemPrompt: string;
}

export interface UiPrefs {
  harnessZoom: number;
  promptEnhancer: PromptEnhancerConfig;
}

const DEFAULTS: UiPrefs = {
  harnessZoom: 1.0,
  promptEnhancer: {
    enabled: true,
    apiUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    model: 'agnes-2.5-flash',
    mode: 'gentle',
    contextRounds: 8,
    systemPrompt: '',
  },
};
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 1.6;
const MIN_ROUNDS = 0;
const MAX_ROUNDS = 20;

function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}

function getPrefsFile(): string {
  return path.join(getUserDir(), 'ui-prefs.json');
}

function clampZoom(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return DEFAULTS.harnessZoom;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(n * 100) / 100));
}

function clampRounds(v: any): number {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return DEFAULTS.promptEnhancer.contextRounds;
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.round(n)));
}

/** 规整增强配置（容错：缺字段回退默认，mode 只认 strict/gentle） */
function normEnhancer(raw: any): PromptEnhancerConfig {
  const d = DEFAULTS.promptEnhancer;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    enabled: raw.enabled !== false,
    apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl.trim() : d.apiUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : d.apiKey,
    model: typeof raw.model === 'string' ? raw.model.trim() : d.model,
    mode: raw.mode === 'strict' ? 'strict' : 'gentle',
    contextRounds: clampRounds(raw.contextRounds),
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : d.systemPrompt,
  };
}

function readPrefs(): UiPrefs {
  try {
    const raw = fs.readFileSync(getPrefsFile(), 'utf-8');
    const o = JSON.parse(raw);
    return {
      harnessZoom: clampZoom(o && o.harnessZoom),
      promptEnhancer: normEnhancer(o && o.promptEnhancer),
    };
  } catch (_) {
    return { harnessZoom: DEFAULTS.harnessZoom, promptEnhancer: { ...DEFAULTS.promptEnhancer } };
  }
}

function writePrefs(patch: Partial<UiPrefs>): UiPrefs {
  const cur = readPrefs();
  const next: UiPrefs = { ...cur };
  if (patch.harnessZoom !== undefined) next.harnessZoom = clampZoom(patch.harnessZoom);
  if (patch.promptEnhancer !== undefined) next.promptEnhancer = normEnhancer({ ...cur.promptEnhancer, ...patch.promptEnhancer });
  try {
    fs.mkdirSync(getUserDir(), { recursive: true });
    fs.writeFileSync(getPrefsFile(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('[UIPrefs] 写入失败:', err.message);
  }
  return next;
}

export { readPrefs, writePrefs, MIN_ZOOM, MAX_ZOOM, MIN_ROUNDS, MAX_ROUNDS };
