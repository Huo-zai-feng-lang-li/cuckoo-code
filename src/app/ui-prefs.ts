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
import { createRequire } from 'node:module';
import { writeJsonAtomicSync, readJsonRobustSync } from '../infra/atomic-json.js';

const require = createRequire(import.meta.url);

/** Electron safeStorage 只在主进程可用；测试/纯 Node 环境拿不到时返回 null。 */
function getSafeStorage(): any {
  try {
    const electron = require('electron');
    const ss = electron && electron.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) return ss;
  } catch (_) { /* 非 Electron 环境 */ }
  return null;
}

function cloneConnection(conn: any): any {
  return conn && typeof conn === 'object' ? { ...conn } : {};
}

/**
 * 把一条连接配置里的 Key 拆成密文；没有 safeStorage 时保留明文。
 * @param ss safeStorage 实例（可能为 null）
 * @param conn 连接配置（可能含 apiKey）
 */
function encryptConnection(ss: any, conn: any): any {
  const out = cloneConnection(conn);
  if (!ss) return out;
  const key = typeof out.apiKey === 'string' ? out.apiKey : '';
  try {
    if (key) out.apiKeyEncrypted = ss.encryptString(key).toString('base64');
    delete out.apiKey;
  } catch (_) {
    out.apiKey = key;
  }
  return out;
}

/**
 * 把 API Key 从明文配置里拆出来。
 * 有 safeStorage 时存 DPAPI/keychain 加密后的 base64；没有时保留明文并返回原对象。
 * @param prefs 完整偏好
 * @returns 可写盘的副本
 */
function toStoredPrefs(prefs: UiPrefs): any {
  const ss = getSafeStorage();
  const stored: any = { ...prefs };
  const api: any = encryptConnection(ss, prefs.apiTransport);
  api.byProfile = {};
  for (const [profileId, conn] of Object.entries(prefs.apiTransport.byProfile || {})) {
    api.byProfile[profileId] = encryptConnection(ss, conn);
  }
  stored.apiTransport = api;
  return stored;
}

/**
 * 把写盘格式中的 API Key 解回内存对象。
 * 优先读密文，兼容旧版明文 apiKey（下次保存时会自动迁移成密文）。
 * @param raw ui-prefs.json 原始对象
 * @returns 去掉 apiKeyEncrypted 的偏好对象
 */
function fromStoredPrefs(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const t = raw.apiTransport;
  if (!t || typeof t !== 'object') return raw;
  const next = { ...raw, apiTransport: { ...t, byProfile: {} } };
  delete next.apiTransport.apiKeyEncrypted;
  const ss = getSafeStorage();
  const decrypt = (encrypted: any): string => {
    if (typeof encrypted !== 'string' || !encrypted) return '';
    try { return ss ? (ss.decryptString(Buffer.from(encrypted, 'base64')) || '') : ''; } catch (_) { return ''; }
  };
  if (typeof t.apiKeyEncrypted === 'string' && t.apiKeyEncrypted) {
    next.apiTransport.apiKey = decrypt(t.apiKeyEncrypted);
  }
  const byProfile = t.byProfile && typeof t.byProfile === 'object' ? t.byProfile : {};
  for (const [profileId, conn] of Object.entries(byProfile)) {
    const c: any = { ...(conn as any) };
    delete c.apiKeyEncrypted;
    if (typeof (conn as any).apiKeyEncrypted === 'string' && (conn as any).apiKeyEncrypted) {
      c.apiKey = decrypt((conn as any).apiKeyEncrypted);
    }
    next.apiTransport.byProfile[profileId] = c;
  }
  return next;
}

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

/** API 工具调用模式：native=原生 function calling；cuckoo-js=网页模型代码块协议 */
export type ApiToolMode = 'native' | 'cuckoo-js';

export interface ApiTransportPrefs {
  /** 旧版全局默认 Base URL（新窗口未单独配置时继承） */
  baseUrl: string;
  /** 旧版全局默认 Key（新窗口未单独配置时继承） */
  apiKey: string;
  /** 旧版全局默认模型 */
  model: string;
  /** 是否把 Cuckoo 工具以 OpenAI tools 暴露给模型（默认开） */
  toolsEnabled: boolean;
  /** 工具调用模式；native 兼容 OpenAI tools，cuckoo-js 给网页模型写代码块 */
  toolMode: ApiToolMode;
  /** 单轮用户消息最多工具往返次数（1~500，默认 64） */
  maxToolRounds: number;
  /** 模型上下文窗口（tokens；不同厂商/Key 可不同，默认 131072） */
  contextWindow: number;
  /** 单次回复最大输出 tokens（默认 8192） */
  maxOutputTokens: number;
  /** 推理强度；auto 表示不下发 reasoning_effort */
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
  /** 是否支持图片输入；关闭时请求前过滤图片，文本附件仍可用 */
  vision: boolean;
  /** 额外系统提示词（最多 8000 字符） */
  systemPrompt: string;
  /** 连接显示名（只用于设置页，不参与请求） */
  label: string;
  /** 是否请求 usage 统计：auto=跟随网关，on=强制，off=不请求 */
  usageReporting: 'auto' | 'on' | 'off';
  /** 按窗口（profile）隔离的连接配置；未配置的窗口继承上面的全局默认 */
  byProfile: Record<string, ApiConnectionPrefs>;
}

export type ApiConnectionPrefs = Omit<ApiTransportPrefs, 'byProfile'>;


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
  /** 主对话 API Key / OpenAI 兼容接入（独立于提示词增强） */
  apiTransport: ApiTransportPrefs;
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
  apiTransport: {
    baseUrl: '',
    apiKey: '',
    model: '',
    toolsEnabled: true,
    toolMode: 'native',
    maxToolRounds: 64,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    reasoningEffort: 'auto',
    vision: true,
    systemPrompt: '',
    label: '',
    usageReporting: 'auto',
    byProfile: {},
  },
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

/** 规整单条 API 连接（不包含 byProfile） */
function normApiConnection(raw: any, fallback?: ApiConnectionPrefs): ApiConnectionPrefs {
  const d = fallback || (DEFAULTS.apiTransport as ApiConnectionPrefs);
  const r = raw && typeof raw === 'object' ? raw : {};
  const rounds = Number(r.maxToolRounds);
  const contextWindow = Number(r.contextWindow);
  const maxOutputTokens = Number(r.maxOutputTokens);
  const reasoning = typeof r.reasoningEffort === 'string' ? r.reasoningEffort : d.reasoningEffort;
  const usage = typeof r.usageReporting === 'string' ? r.usageReporting : d.usageReporting;
  return {
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl.trim() : d.baseUrl,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey.trim() : d.apiKey,
    model: typeof r.model === 'string' ? r.model.trim() : d.model,
    toolsEnabled: r.toolsEnabled !== false,
    toolMode: r.toolMode === 'cuckoo-js' ? 'cuckoo-js' : 'native',
    maxToolRounds: Number.isFinite(rounds)
      ? Math.max(1, Math.min(500, Math.round(rounds)))
      : d.maxToolRounds,
    contextWindow: Number.isFinite(contextWindow)
      ? Math.max(8192, Math.min(2097152, Math.round(contextWindow)))
      : d.contextWindow,
    maxOutputTokens: Number.isFinite(maxOutputTokens)
      ? Math.max(256, Math.min(32768, Math.round(maxOutputTokens)))
      : d.maxOutputTokens,
    reasoningEffort: (reasoning === 'low' || reasoning === 'medium' || reasoning === 'high') ? reasoning : 'auto',
    vision: typeof r.vision === 'boolean' ? r.vision : d.vision,
    systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt.slice(0, 8000) : d.systemPrompt,
    label: typeof r.label === 'string' ? r.label.trim().slice(0, 40) : d.label,
    usageReporting: (usage === 'on' || usage === 'off') ? usage : 'auto',
  };
}

/** 规整主对话 API 接入配置（旧版字段作为全局默认，byProfile 按窗口覆盖） */
function normApiTransport(raw: any): ApiTransportPrefs {
  const d = DEFAULTS.apiTransport;
  if (!raw || typeof raw !== 'object') return { ...d, byProfile: {} };
  const base = normApiConnection(raw, d as ApiConnectionPrefs);
  const byProfile: Record<string, ApiConnectionPrefs> = {};
  const map = raw.byProfile && typeof raw.byProfile === 'object' ? raw.byProfile : {};
  for (const [profileId, conn] of Object.entries(map)) {
    const id = String(profileId || '').trim();
    if (!id) continue;
    byProfile[id] = normApiConnection(conn, base);
  }
  return { ...base, byProfile };
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
  const raw = readJsonRobustSync<Record<string, any> | null>(getPrefsFile(), null);
  const o = fromStoredPrefs(raw);
  if (!o) {
    return {
      harnessZoom: DEFAULTS.harnessZoom,
      petEnabled: DEFAULTS.petEnabled,
      petSize: DEFAULTS.petSize,
      petDesktopSize: DEFAULTS.petDesktopSize,
      petX: DEFAULTS.petX,
      promptEnhancer: { ...DEFAULTS.promptEnhancer },
      apiTransport: { ...DEFAULTS.apiTransport, byProfile: {} },
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
    apiTransport: normApiTransport(o && o.apiTransport),
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
  if (patch.apiTransport !== undefined) {
    const patchApi: any = patch.apiTransport;
    const byProfile = {
      ...cur.apiTransport.byProfile,
      ...(patchApi.byProfile && typeof patchApi.byProfile === 'object' ? patchApi.byProfile : {}),
    };
    next.apiTransport = normApiTransport({ ...cur.apiTransport, ...patchApi, byProfile });
  }
  // shellLayout 为增量合并：只覆盖本次提交的键，其余保持
  if (patch.shellLayout !== undefined) next.shellLayout = { ...cur.shellLayout, ...normLayout(patch.shellLayout) };
  writeJsonAtomicSync(getPrefsFile(), toStoredPrefs(next), { keepBackup: true });
  return next;
}

/**
 * 读取某个窗口实际使用的 API 连接。
 * 已单独配置过就返回该窗口的配置；否则继承旧版全局字段。
 * @param prefs 主进程偏好
 * @param profileId 窗口/profile ID
 */
function getApiConnection(prefs: UiPrefs, profileId: string): ApiConnectionPrefs {
  const id = String(profileId || '');
  const t = prefs.apiTransport;
  if (id && t.byProfile && t.byProfile[id]) return { ...t.byProfile[id] };
  const { byProfile: _ignored, ...base } = t;
  return { ...base };
}

/**
 * 保存某个窗口的 API 连接（部分字段覆盖，不传的字段保持不变）。
 * @param profileId 窗口/profile ID
 * @param patch 要覆盖的字段；apiKey 传空串表示清除
 */
function setApiConnection(profileId: string, patch: Partial<ApiConnectionPrefs>): ApiConnectionPrefs {
  const id = String(profileId || '').trim();
  if (!id) throw new Error('profileId 为空');
  const cur = readPrefs();
  const existing = getApiConnection(cur, id);
  const next = normApiConnection({ ...existing, ...(patch || {}) }, existing);
  writePrefs({ apiTransport: { byProfile: { [id]: next } } } as any);
  return next;
}

/**
 * 给渲染进程的偏好副本：永远不把明文 Key 回传 DOM。
 * hasApiKey 只用于设置页显示"已配置（留空保持不变）"。
 * @param prefs 主进程内存偏好
 */
function redactPrefsForRenderer(prefs: UiPrefs): any {
  const redact = (conn: any): any => ({
    ...conn,
    apiKey: '',
    hasApiKey: !!conn.apiKey,
  });
  const byProfile: Record<string, any> = {};
  for (const [profileId, conn] of Object.entries(prefs.apiTransport.byProfile || {})) {
    byProfile[profileId] = redact(conn);
  }
  return {
    ...prefs,
    promptEnhancer: {
      ...prefs.promptEnhancer,
      apiKey: prefs.promptEnhancer.apiKey ? '已配置' : '',
    },
    apiTransport: {
      ...redact(prefs.apiTransport),
      byProfile,
    },
  };
}

/**
 * 启动时把旧版明文 API Key 迁移成 safeStorage 密文。
 * 没有 safeStorage（非 Electron/系统不支持）时保持原样，不丢 Key。
 */
function migrateApiKeyEncryption(): void {
  const ss = getSafeStorage();
  if (!ss) return;
  const prefs = readPrefs();
  const hasAny = !!prefs.apiTransport.apiKey
    || Object.values(prefs.apiTransport.byProfile || {}).some((c) => !!(c && c.apiKey));
  if (!hasAny) return;
  try {
    writePrefs({ apiTransport: { ...prefs.apiTransport } });
    console.log('[Cuckoo Code] API Key 已迁移到加密存储');
  } catch (_) { /* ignore */ }
}

export {
  readPrefs,
  writePrefs,
  redactPrefsForRenderer,
  migrateApiKeyEncryption,
  getApiConnection,
  setApiConnection,
  MIN_ZOOM,
  MAX_ZOOM,
  MIN_ROUNDS,
  MAX_ROUNDS,
};
