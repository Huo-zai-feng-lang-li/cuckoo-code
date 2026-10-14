/**
 * 工具窗口（openBrowserWindow）专用 preload。
 *
 * 背景：工具窗口是独立的 BrowserWindow，不带 Cuckoo 的 bridge preload，
 * 因而缺少 Google OAuth 所需的 `navigator.userAgentData` 主世界修正
 * （brands 缺 "Google Chrome" 品牌）→ Gemini / Google 登录页判定"浏览器不安全"。
 *
 * 本 preload 在页面脚本执行前向主世界注入指纹修正，与 bridge/entry.ts 一致。
 * 请求头（sec-ch-ua*）改写由 browser-window-manager.ts 经 infra 的 ensureClientHints 完成。
 *
 * 放在 tools 层（与 browser-window-manager.ts 同目录）：preload 是工具窗口的自有资源，
 * 避免 tools 反向引用 app 层（依赖方向铁律）。
 */
import { createRequire } from 'node:module';
import { buildUserAgentDataFix } from '../infra/user-agent.js';

const require = createRequire(import.meta.url);
const { webFrame } = require('electron');

try {
  webFrame.executeJavaScript(buildUserAgentDataFix()).then(
    () => console.log('[Cuckoo Browser] 主世界指纹修正已注入'),
    (err: any) => console.warn('[Cuckoo Browser] 主世界指纹修正注入失败:', err && err.message)
  );
} catch (err) {
  console.warn('[Cuckoo Browser] 主世界指纹修正异常:', err);
}
