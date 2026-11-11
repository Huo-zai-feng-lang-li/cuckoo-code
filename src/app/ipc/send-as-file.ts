/**
 * 长文本回传走附件通道（需求 115）
 *
 * 动机：当前工具回传用 sender.insertText 一次性"敲"上万字进 textarea，
 * 速率恒定、零停顿、内容是原始 JSON/日志 —— 账号级风控的典型脚本特征。
 * 人类路径是粘贴长文本 → 站点自动转 .txt 附件。本 IPC 走后者。
 *
 * 复用 cdpAttach：全程无合成事件（真实鼠标点击 / DOM.setFileInputFiles），
 * 与用户手动选文件等价。任何环节失败 → 返回 success:false，由 overlay
 * 静默回退到 insertText，消息绝不丢。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { cdpAttach } from './cdp-attach.js';
import { assertSenderOk } from '../ipc-guard.js';

/**
 * 按 sender 找窗口上下文。
 * 不用 windowState.getContextByWebContents —— 它只匹配 AI 视图，
 * harness / 壳页 / overlay 作为来源时会被误判为 no-ai-view。
 * 这里遍历全部视图，与 harness.ts 的 findContext 语义一致。
 */
function findCtxBySender(sender: any): any {
  let all: any[] = [];
  try { all = windowState.getAllContexts() || []; } catch (_) { return null; }
  for (const ctx of all) {
    const c: any = ctx;
    if (c.view && c.view.webContents === sender) return c;
    if (c.harnessView && c.harnessView.webContents === sender) return c;
    if (c.win && c.win.webContents === sender) return c;
    if (c.overlayView && c.overlayView.webContents === sender) return c;
  }
  return null;
}

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerSendAsFileIpc(): void {
  ipcMain.handle('chat-send-as-file', async (event: any, payload: any) => {
    // X-001：来源硬校验（AI 页面 URL 必须命中 provider 域）
    if (!assertSenderOk(event).ok) return { success: false, error: 'sender-rejected' };
    const text = (payload && payload.text) || '';
    const fileName = (payload && payload.fileName) || 'output.txt';
    if (!text) return { success: false, error: 'empty-text' };
    const ctx = findCtxBySender(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    try {
      const data = Buffer.from(String(text), 'utf8').toString('base64');
      const r = await cdpAttach(ctx as any, { name: fileName, data, mime: 'text/plain' });
      return r;
    } catch (err: any) {
      return { success: false, error: (err && err.message) || 'attach-failed' };
    }
  });
}

export { registerSendAsFileIpc };
