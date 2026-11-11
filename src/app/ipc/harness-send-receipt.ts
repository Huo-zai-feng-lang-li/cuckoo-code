import { randomUUID } from 'node:crypto';

type IpcEvents = {
  on(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void): unknown;
  off(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void): unknown;
};

export type UserMessageReceipt = { success: boolean; error?: string };

/**
 * 等待纯净模式用户消息在 AI 页面的投递回执。
 *
 * 与初始提示回执同构：注册在消息发出之前；只有目标 AI 页面、且 requestId 匹配的
 * 回执才能 settle，跨页面/旧请求的回执不得误判。超时按失败处理；settle 后移除监听。
 *
 * @param ipc 主进程 IPC（ipcMain）
 * @param target 目标 AI 页面 webContents（event.sender 比对）
 * @param timeoutMs 回执超时（覆盖长暂停 + 拟人延迟 + 附件/输入余量）
 */
export function waitForUserMessageReceipt(ipc: IpcEvents, target: unknown, timeoutMs: number, externalRequestId?: string): {
  requestId: string;
  result: Promise<UserMessageReceipt>;
  cancel: () => void;
} {
  const requestId = externalRequestId || randomUUID();
  let settled = false;
  let settle: (r: UserMessageReceipt) => void = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<UserMessageReceipt>((resolve) => {
    settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipc.off('harness-user-message-result', onResult);
      resolve(r);
    };
    const onResult = (event: { sender: unknown }, payload: unknown) => {
      const receipt = payload as { requestId?: unknown; success?: unknown; error?: unknown } | null;
      if (event.sender === target && receipt?.requestId === requestId) {
        settle({ success: receipt.success === true, error: typeof receipt.error === 'string' ? receipt.error : undefined });
      }
    };
    ipc.on('harness-user-message-result', onResult);
    timer = setTimeout(() => settle({ success: false, error: '投递回执超时' }), timeoutMs);
  });
  return { requestId, result, cancel: () => settle({ success: false, error: '已取消' }) };
}
