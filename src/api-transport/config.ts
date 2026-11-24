/**
 * API transport 配置规整。
 *
 * 主对话 API 与提示词增强是两套独立配置，不再互相回退。
 * 允许 CUCKOO_API_* 环境变量覆盖，方便本地/局域网网关联调。
 * Key 只在主进程内存中使用、不写日志；落盘由 ui-prefs 通过 Electron safeStorage
 * 加密（没有 safeStorage 的环境才回退明文）。
 */
export interface ApiTransportConfig {
  /** 用户填写的 Base URL（不含 /chat/completions 或已包含） */
  baseUrl: string;
  /** 实际 POST 地址 */
  endpoint: string;
  /** 可为空（本地无鉴权网关） */
  apiKey: string;
  model: string;
}

export type ApiConfigResult =
  | { success: true; config: ApiTransportConfig }
  | { success: false; error: string };

/**
 * 由用户填写的 Base URL 推导 /models 地址。
 * 兼容三种常见填法：根地址、/v1、已经带 /chat/completions 或 /models。
 * @param baseUrl 用户填写的 Base URL
 */
export function resolveModelsEndpoint(baseUrl: string): string {
  let root = clean(baseUrl).replace(/\/+$/, '');
  root = root.replace(/\/chat\/completions$/i, '');
  root = root.replace(/\/models$/i, '');
  return root + '/models';
}

function clean(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 规整并校验 API 配置。
 * @param raw 原始连接配置（来自 ui-prefs 的某个 profile）
 * @param env 环境变量；默认 process.env，测试可注入
 */
export function resolveApiConfig(
  raw: { baseUrl?: any; apiKey?: any; model?: any } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ApiConfigResult {
  const input = raw || {};
  const baseUrl = clean(env.CUCKOO_API_BASE || input.baseUrl).replace(/\/+$/, '');
  const apiKey = clean(env.CUCKOO_API_KEY || input.apiKey);
  const model = clean(env.CUCKOO_API_MODEL || input.model);

  if (!baseUrl) return { success: false, error: 'API Base URL 未配置（可在“API 设置”里填写，或设置 CUCKOO_API_BASE）' };
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { success: false, error: 'API Base URL 必须以 http:// 或 https:// 开头' };
  }
  if (!model) return { success: false, error: 'API 模型未配置（可在“API 设置”里填写，或设置 CUCKOO_API_MODEL）' };

  const endpoint = /\/chat\/completions$/i.test(baseUrl)
    ? baseUrl
    : baseUrl + '/chat/completions';
  return { success: true, config: { baseUrl, endpoint, apiKey, model } };
}
