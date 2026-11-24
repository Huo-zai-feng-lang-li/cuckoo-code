/**
 * API Key / OpenAI 兼容平台 Provider。
 *
 * 这个 provider 不使用网页 DOM，也不注入 bridge：
 * - homeUrl 固定 about:blank，AI WebContentsView 只作为窗口上下文占位；
 * - 真正的请求由主进程的 api-transport runtime 发出；
 * - 现有网页 Provider 的 homeUrl / matchesUrl 不受影响。
 */
import type { Provider } from '../providers/types.js';

export const API_TRANSPORT_PROVIDER_ID = 'api-key';
/** API 占位页专用 URL：普通网页的 about:blank 不能被 API provider 抢走 */
export const API_TRANSPORT_HOME_URL = 'about:blank#cuckoo-api';

export function isApiTransportProvider(providerId: string | null | undefined): boolean {
  return providerId === API_TRANSPORT_PROVIDER_ID;
}

export const apiTransportProvider: Provider = {
  id: API_TRANSPORT_PROVIDER_ID,
  name: 'API Key / OpenAI 兼容',
  homeUrl: API_TRANSPORT_HOME_URL,
  sessionUrlBase: API_TRANSPORT_HOME_URL,
  matchesUrl(url: string): boolean {
    return url === API_TRANSPORT_HOME_URL || url.startsWith(API_TRANSPORT_HOME_URL);
  },
  extractSessionId(): string | null {
    return 'api';
  },
};
