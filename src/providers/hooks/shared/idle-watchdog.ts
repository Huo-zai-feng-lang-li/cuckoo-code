/**
 * 流静默看门狗（hook 共享）。
 *
 * 被 esbuild 打包进各平台 hook（主世界），同时可在 Node 用 fake timer 单测。
 * 不引用 window/document——onIdle 回调由调用方传入（在 hook 里 dispatch 事件）。
 *
 * B-005：fetch 路径 observeBody 早已装了 5s 轮询的 cuckoo-stream-idle 看门狗，
 * 但 XHR 路径（observeXhr）只有 readystatechange 被动消费，流挂起不发数据也不断开时
 * 无人检测 → bridge 看门狗永远收不到 idle → 任务静默卡死。此 helper 抽出同一套
 * 计时逻辑，让 observeXhr 也挂装。
 */

export interface IdleWatchdog {
  /** 收到任意数据（含心跳）时调用，刷新活跃时间 */
  touch: () => void;
  /** 流结束 / 已派发终态后调用，停止轮询 */
  stop: () => void;
}

/**
 * 创建一个流静默看门狗。
 * @param opts.timeoutMs 静默阈值（毫秒）；<=0 则不启动轮询
 * @param opts.onIdle 超过阈值仍未结束时回调一次（helper 内部会重置计时，可重复触发）
 */
function createIdleWatchdog(opts: { timeoutMs: number; onIdle: () => void }): IdleWatchdog {
  var lastActiveAt = Date.now();
  var timer: any = null;
  function touch() { lastActiveAt = Date.now(); }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  if (opts.timeoutMs > 0) {
    timer = setInterval(function () {
      if (timer === null) return;
      if (Date.now() - lastActiveAt > opts.timeoutMs) {
        lastActiveAt = Date.now(); // 重置，避免连续触发
        try { opts.onIdle(); } catch (e) { /* ignore */ }
      }
    }, 5000);
  }
  return { touch: touch, stop: stop };
}

export { createIdleWatchdog };
