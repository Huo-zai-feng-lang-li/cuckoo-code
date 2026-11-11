import { randomUUID } from 'node:crypto';

type IpcEvents = {
  on(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void): unknown;
  off(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void): unknown;
};

/** Register before the initial-prompt IPC is sent. A receipt from another page cannot settle it. */
export function waitForInitialPromptReceipt(ipc: IpcEvents, target: unknown, timeoutMs: number): {
  requestId: string;
  result: Promise<boolean>;
  cancel: () => void;
} {
  const requestId = randomUUID();
  let settled = false;
  let settle: (success: boolean) => void = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<boolean>((resolve) => {
    settle = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipc.off('initial-prompt-result', onResult);
      resolve(success);
    };
    const onResult = (event: { sender: unknown }, payload: unknown) => {
      const receipt = payload as { requestId?: unknown; success?: unknown } | null;
      if (event.sender === target && receipt?.requestId === requestId) settle(receipt.success === true);
    };
    ipc.on('initial-prompt-result', onResult);
    timer = setTimeout(() => settle(false), timeoutMs);
  });
  return { requestId, result, cancel: () => settle(false) };
}
