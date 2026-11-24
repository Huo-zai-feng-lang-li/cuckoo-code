/**
 * Provider 注册表
 * 加载所有内置的 AI 平台 Provider（并校验），以及用户导入的自定义 Provider。
 */
import { loadCustomProviders } from './custom/loader.js';
import { deepseek } from './deepseek.js';
import { claude } from './claude.js';
import { chatgpt } from './chatgpt.js';
import { apiTransportProvider } from '../api-transport/provider.js';
import { validateProvider } from './validate.js';

function loadBuiltinProviders(): any[] {
  const list: any[] = [];
  for (const p of [deepseek, claude, chatgpt, apiTransportProvider]) {
    const err = validateProvider(p);
    if (err) {
      console.warn('[Provider] 内置 provider 校验失败，跳过:', (p && p.id) || '?', err);
      continue;
    }
    list.push(p);
  }
  return list;
}

const builtinProviders = loadBuiltinProviders();

// 新建窗口的平台选择只保留 DeepSeek 网页与 API Key 直连。
// Claude / ChatGPT 仍保留在 registry 中，仅为兼容已存在的旧窗口；它们不会出现在
// 平台选择页，也不会阻止旧窗口继续按原 URL 打开。
const selectableBuiltinProviderIds = new Set(['deepseek', apiTransportProvider.id]);

function isSelectableProvider(provider: any): boolean {
  if (!provider || typeof provider.id !== 'string') return false;
  // 用户显式导入或启用的自定义 Provider 不受内置白名单限制。
  if (provider._customPath || provider._fromPlugin) return true;
  return selectableBuiltinProviderIds.has(provider.id);
}

function getAllProviders(): any[] {
  return [...builtinProviders, ...loadCustomProviders()];
}

function getProvider(id: string): any {
  return getAllProviders().find((p) => p.id === id) || null;
}

/** 根据 URL 自动识别所属平台 */
function getProviderByUrl(url: string): any {
  if (!url) return null;
  return getAllProviders().find((p) => typeof p.matchesUrl === 'function' && p.matchesUrl(url)) || null;
}

const providers = getAllProviders();

export { providers, getProvider, getAllProviders, getProviderByUrl, isSelectableProvider };
