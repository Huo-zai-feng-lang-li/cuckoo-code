import { createRequire } from 'node:module';
import path from 'node:path';
import { buildChromeUserAgent, ensureClientHints } from '../../infra/user-agent.js';
const require = createRequire(import.meta.url);
const { BrowserWindow } = require('electron');

interface OpenWindowOptions {
  width?: number;
  height?: number;
  [key: string]: any;
}

class BrowserWindowManager {
  windows: Map<string, any>;
  nextAutoId: number;

  constructor() {
    this.windows = new Map();
    this.nextAutoId = 1;
  }

  openWindow(customId: string | null, url: string, options: OpenWindowOptions = {}): string {
    let id: string;
    if (customId) {
      if (this.windows.has(customId)) {
        throw new Error(`窗口 ID "${customId}" 已存在，请换一个 ID 或复用现有窗口`);
      }
      id = customId;
    } else {
      do {
        id = `win-${this.nextAutoId++}`;
      } while (this.windows.has(id));
    }

    // 剥离用户传入的 width/height/webPreferences，由本模块统一接管
    const { webPreferences: optWebPrefs, width: _w, height: _h, ...restOptions } = options;
    const win = new BrowserWindow({
      width: options.width || 1200,
      height: options.height || 800,
      ...restOptions,
      webPreferences: {
        ...(optWebPrefs || {}),
        // 以下安全基线由本模块强制接管，用户 webPreferences 不可覆盖（保证 preload 一定生效）
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox 必须为 false：ESM preload（含 import）在 sandbox 模式下无法加载。
        // 与主窗口 AI 视图（entry.ts）一致。
        sandbox: false,
        // 工具窗口专用 preload：注入 navigator.userAgentData 指纹修正（Google 系站点登录必需）。
        // 放在 tools 层根目录（非 impl/）：impl/ 是 D12 契约扫描目录，会被 build-tool-api 当工具模块 import。
        preload: path.join(import.meta.dirname, '..', 'browser-preload.js'),
      },
    });

    // preload 加载失败会让指纹修正静默失效（Google 登录又变"不安全"），主进程显式记录
    win.webContents.on('preload-error', (_e: any, preloadPath: string, error: any) => {
      console.error('[Cuckoo Browser] preload 加载失败:', preloadPath, error && error.message);
    });

    // 设置与主窗口一致的普通 Chrome UA（动态取真实内核版本），避免暴露 Electron 标识
    win.webContents.setUserAgent(buildChromeUserAgent());
    // 补齐 sec-ch-ua* 请求头（Google OAuth 登录必需）
    ensureClientHints(win.webContents.session);

    // F12 打开本窗口 DevTools（方便调试页面），用独立窗口模式（docked 会与本窗口内容互挤）。
    // 判断 keyDown：before-input-event 对 keyDown/keyUp 都触发，不判断会"按下开、抬起关"。
    win.webContents.on('before-input-event', (_event: any, input: any) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        const wc = win.webContents;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: 'detach' });
      }
    });

    if (url) win.loadURL(url);
    this.windows.set(id, win);
    win.on('closed', () => this.windows.delete(id));
    return id;
  }

  async injectJS(id: string, jsCode: string): Promise<any> {
    const win = this.windows.get(id);
    if (!win) throw new Error(`窗口 ID "${id}" 不存在`);

    // 语法探测：优先按"单个表达式"解析，失败则按"函数体（多条语句）"解析
    // 这样既支持 `1+2`、`(() => {...})()` 这类表达式，也支持
    // `return x`、`const a=1; return a`、`if (...) return x`、顶层 await 等多语句代码
    let mode: 'expression' | 'body'; // 'expression' | 'body'
    try {
      // eslint-disable-next-line no-new-func
      new Function('return (' + jsCode + '\n)');
      mode = 'expression';
    } catch (e) {
      try {
        // eslint-disable-next-line no-new-func
        new Function('return (async () => {\n' + jsCode + '\n})');
        mode = 'body';
      } catch (e2: any) {
        throw new Error(`JS 语法错误: ${e2.message}`);
      }
    }

    const wrapped =
      mode === 'expression'
        ? `(async () => {
  try {
    const __result = await (${jsCode});
    return { ok: true, value: __result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})()`
        : `(async () => {
  try {
    const __result = await (async () => {
${jsCode}
    })();
    return { ok: true, value: __result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})()`;

    const result = await win.webContents.executeJavaScript(wrapped, true);
    if (result && result.ok === false) {
      throw new Error(result.error);
    }
    return result ? result.value : undefined;
  }

  getWindow(id: string): any {
    const win = this.windows.get(id);
    if (!win) throw new Error(`窗口 ID "${id}" 不存在`);
    return win;
  }

  getAllWindowIds(): string[] {
    return Array.from(this.windows.keys());
  }

  closeWindow(id: string): void {
    const win = this.getWindow(id);
    win.close();
    this.windows.delete(id);
  }
}

const windowManager = new BrowserWindowManager();
export { windowManager };
