type SwitchTargetWebContents = {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  loadURL(url: string): Promise<unknown>;
};

/** Resolve only after the target navigation has emitted its load event. */
export function loadSwitchTarget(wc: SwitchTargetWebContents, url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off('did-finish-load', onLoad);
      resolve(loaded);
    };
    const onLoad = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    wc.on('did-finish-load', onLoad);
    try { void wc.loadURL(url).catch(() => finish(false)); }
    catch (_) { finish(false); }
  });
}
