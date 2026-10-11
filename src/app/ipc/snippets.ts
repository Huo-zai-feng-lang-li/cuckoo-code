/**
 * IPC：快捷提示词（Snippets）管理
 * 壳页面通过 window.shellAPI 调用：
 *  - list-snippets  ：列出全部
 *  - save-snippets  ：整体覆盖保存
 *  - trigger-snippet：把某条提示词填入 AI 页面输入框（可选自动发送）
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { listSnippets, saveSnippets } from '../snippets.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerSnippetsIpc(): void {
  // 列出全部提示词
  ipcMain.handle('list-snippets', async () => {
    return { success: true, snippets: listSnippets() };
  });

  // 整体覆盖保存 → 广播给所有窗口的壳页面，让它们重新加载（多窗口同步）
  ipcMain.handle('save-snippets', async (_event: any, { snippets }: any) => {
    const ok = saveSnippets(snippets);
    if (ok) {
      for (const ctx of windowState.getAllContexts()) {
        try {
          if (ctx && ctx.win && !ctx.win.isDestroyed()) {
            ctx.win.webContents.send('shell-snippets-changed');
          }
        } catch (_) {}
      }
    }
    return { success: ok, error: ok ? null : '保存失败' };
  });

  // 追加文本到 AI 输入框末尾（不发送）：MCP 名等
  ipcMain.handle('append-to-input', async (event: any, { text }: any) => {
    if (typeof text !== 'string' || !text) return { success: false, error: '文本为空' };
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '未找到窗口上下文' };

    const win = ctx.win;
    const isHarness = !!(win && (win as any).__ckHarnessVisible);
    const hv = (ctx as any).harnessView || (win as any)?.__ckHarnessView;
    let dispatched = false;

    // 纯净模式下通知 harness 视图
    if (isHarness && hv && !hv.webContents.isDestroyed()) {
      try {
        hv.webContents.send('harness-event', { type: 'append-input', text });
        dispatched = true;
      } catch (_) {}
    }

    // 网页模式或双向同步
    if (ctx.view && !ctx.view.webContents.isDestroyed()) {
      try {
        ctx.view.webContents.send('cuckoo-append-input', { text });
        dispatched = true;
      } catch (_) {}
    }

    // 非纯净模式下如果 harness 视图也存在，同步更新输入备用
    if (!isHarness && hv && !hv.webContents.isDestroyed()) {
      try {
        hv.webContents.send('harness-event', { type: 'append-input', text });
      } catch (_) {}
    }

    return dispatched ? { success: true } : { success: false, error: '未找到就绪的输入视图' };
  });

  // 触发某条提示词：通知对应窗口的 AI 页面填入输入框（+ 可选发送）
  ipcMain.handle('trigger-snippet', async (event: any, { content, autoSend }: any) => {
    if (typeof content !== 'string' || !content) {
      return { success: false, error: '内容为空' };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '未找到窗口上下文' };

    const win = ctx.win;
    const isHarness = !!(win && (win as any).__ckHarnessVisible);
    const hv = (ctx as any).harnessView || (win as any)?.__ckHarnessView;
    let dispatched = false;

    // 纯净模式：触发 harness 视图
    if (isHarness && hv && !hv.webContents.isDestroyed()) {
      try {
        hv.webContents.send('harness-event', { type: 'trigger-snippet', content, autoSend: autoSend !== false });
        dispatched = true;
      } catch (_) {}
    } else if (ctx.view && !ctx.view.webContents.isDestroyed()) {
      // 网页模式：触发网页 view
      try {
        ctx.view.webContents.send('cuckoo-trigger-snippet', { content, autoSend: autoSend !== false });
        dispatched = true;
      } catch (_) {}
    }

    return dispatched ? { success: true } : { success: false, error: '未找到就绪的输入视图' };
  });
}

export { registerSnippetsIpc };
