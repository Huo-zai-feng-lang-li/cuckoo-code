/** 一轮上下文只尝试一次；等待主进程告警/切换结束期间阻止并发压缩。 */
export interface ContextSwitchConfig { enabled: boolean; threshold: number; }

export function createContextSwitchGate(request: (sessionId: string | null) => Promise<unknown>) {
  let busy = false;
  const attempted = new Set<string>();
  return {
    reset(sessionId: string | null) { attempted.delete(`${sessionId || ''}:`); },
    check(config: ContextSwitchConfig, tokens: number, sessionId: string | null): boolean {
      if (busy) return true;
      if (!config.enabled || !Number.isFinite(config.threshold) || config.threshold <= 0) return false;
      if (!Number.isFinite(tokens) || tokens < config.threshold * 10000) return false;
      const key = `${sessionId || ''}:`;
      if (attempted.has(key)) return false;
      attempted.add(key);
      busy = true;
      Promise.resolve().then(() => request(sessionId)).then((result: any) => {
        if (!result || result.success !== true || result.switched === false) attempted.delete(key);
      }).catch(() => { attempted.delete(key); }).finally(() => { busy = false; });
      return true;
    },
  };
}
