/**
 * UI 偏好（主进程直存，不依赖 AI 页面 localStorage）。
 * 存储：<userDir>/ui-prefs.json（CUCKOO_HOME 可覆盖）。
 *
 * 目前：
 *   - harnessZoom：纯净模式缩放（0.8 ~ 1.6，默认 1.0）
 *   - petEnabled：宠物总开关（同时控制纯净模式与桌面宠物）
 *   - petSize / petDesktopSize：纯净模式与桌面的显示边长（各自记忆，滚轮调整）
 *   - petX：纯净模式宠物的横向站位比例（拖动后记忆）
 *   - promptEnhancer：纯净模式提示词增强配置
 *
 * API Key 默认空（源码不硬编码任何密钥，开源安全）；用户在设置里填写后存 ui-prefs.json。
 */
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomicSync, readJsonRobustSync } from '../infra/atomic-json.js';

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
  /** 增强中的输入框背景样式：grid=科技网格（默认）/ image=炫酷图片 */
  backgroundStyle: 'grid' | 'image';
  /** 图片模式下指定图片文件名（如 "07.jpg"；空 = 随机） */
  backgroundImage: string;
}

/** 宠物显示边长（px）。历史上是三档字符串（small/medium/large），现已统一为数字。 */
export type PetSize = number;
export const PET_SIZE_MIN = 48;
export const PET_SIZE_MAX = 256;
/** 旧三档 → px 的映射（兼容老配置） */
const LEGACY_PET_SIZE: Record<string, number> = { small: 64, medium: 96, large: 128 };

export interface UiPrefs {
  harnessZoom: number;
  /** 显示宠物（同时控制纯净模式与桌面宠物） */
  petEnabled: boolean;
  /** 纯净模式宠物显示边长（px，48 ~ 256；滚轮调整） */
  petSize: PetSize;
  /** 桌面宠物显示边长（px，48 ~ 256；滚轮调整；桌面通常设得更大） */
  petDesktopSize: PetSize;
  /** 宠物横向站位比例（0.06 ~ 0.94，相对输入框宽度；拖动后记忆） */
  petX: number;
  promptEnhancer: PromptEnhancerConfig;
  /**
   * 壳页面布局（全窗口共享）：localStorage 键 → 值（均以字符串存）。
   * 键必须在 LAYOUT_KEYS 白名单内，防止被用来写任意 localStorage。
   */
  shellLayout: Record<string, string>;
}

/**
 * 允许跨窗口同步的壳页面布局键白名单。
 * 只放"布局/位置"类设置——它们由壳页面自己写 localStorage 后上报，
 * 其它窗口收到后写回各自 localStorage 并重新应用。
 */
export const LAYOUT_KEYS = [
  'cuckoo-sidebar-width',
  'cuckoo-activitybar-order',
  'cuckoo-activitybar-hidden',
];

const DEFAULTS: UiPrefs = {
  harnessZoom: 1.0,
  petEnabled: true,
  petSize: 96,
  petDesktopSize: 160,
  petX: 0.18,
  shellLayout: {},
  promptEnhancer: {
    enabled: true,
    apiUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    model: 'agnes-2.5-flash',
    mode: 'gentle',
    contextRounds: 8,
    systemPrompt: '',
    backgroundStyle: 'grid',
    backgroundImage: '',
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

/** 规整宠物横向站位：钳到 6%~94%（两端留出半个身位，避免贴边被裁） */
function clampPetX(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return DEFAULTS.petX;
  return Math.max(0.06, Math.min(0.94, Math.round(n * 1000) / 1000));
}

/** 规整宠物尺寸：数字（px）钳到 [40, 200]；旧的三档字符串按映射表转换 */
function normPetSize(v: any): PetSize {
  if (typeof v === 'string' && LEGACY_PET_SIZE[v]) return LEGACY_PET_SIZE[v];
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return DEFAULTS.petSize;
  return Math.max(PET_SIZE_MIN, Math.min(PET_SIZE_MAX, Math.round(n)));
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
    backgroundStyle: raw.backgroundStyle === 'image' ? 'image' : 'grid',
    backgroundImage: typeof raw.backgroundImage === 'string' ? raw.backgroundImage : d.backgroundImage,
  };
}

/** 规整 shellLayout：只保留白名单键 + 字符串值 */
function normLayout(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of LAYOUT_KEYS) {
    if (typeof raw[k] === 'string') out[k] = raw[k];
  }
  return out;
}

function readPrefs(): UiPrefs {
  // C-003：损坏回退 .bak
  const o = readJsonRobustSync<Record<string, any> | null>(getPrefsFile(), null);
  if (!o) {
    return {
      harnessZoom: DEFAULTS.harnessZoom,
      petEnabled: DEFAULTS.petEnabled,
      petSize: DEFAULTS.petSize,
      petDesktopSize: DEFAULTS.petDesktopSize,
      petX: DEFAULTS.petX,
      promptEnhancer: { ...DEFAULTS.promptEnhancer },
      shellLayout: {},
    };
  }
  return {
    harnessZoom: clampZoom(o && o.harnessZoom),
    petEnabled: o.petEnabled !== false,
    petSize: normPetSize(o && o.petSize),
    // 老配置只有 petSize 时，桌面沿用同值（避免突然跳到 160）
    petDesktopSize: normPetSize(o && o.petDesktopSize !== undefined ? o.petDesktopSize : o && o.petSize),
    petX: clampPetX(o && o.petX),
    promptEnhancer: normEnhancer(o && o.promptEnhancer),
    shellLayout: normLayout(o && o.shellLayout),
  };
}

function writePrefs(patch: Partial<UiPrefs>): UiPrefs {
  const cur = readPrefs();
  const next: UiPrefs = { ...cur };
  if (patch.harnessZoom !== undefined) next.harnessZoom = clampZoom(patch.harnessZoom);
  if (patch.petEnabled !== undefined) next.petEnabled = !!patch.petEnabled;
  if (patch.petSize !== undefined) next.petSize = normPetSize(patch.petSize);
  if (patch.petDesktopSize !== undefined) next.petDesktopSize = normPetSize(patch.petDesktopSize);
  if (patch.petX !== undefined) next.petX = clampPetX(patch.petX);
  if (patch.promptEnhancer !== undefined) next.promptEnhancer = normEnhancer({ ...cur.promptEnhancer, ...patch.promptEnhancer });
  // shellLayout 为增量合并：只覆盖本次提交的键，其余保持
  if (patch.shellLayout !== undefined) next.shellLayout = { ...cur.shellLayout, ...normLayout(patch.shellLayout) };
  writeJsonAtomicSync(getPrefsFile(), next, { keepBackup: true });
  return next;
}

export { readPrefs, writePrefs, MIN_ZOOM, MAX_ZOOM, MIN_ROUNDS, MAX_ROUNDS };
