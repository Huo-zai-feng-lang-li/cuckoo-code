/**
 * preload 控制台降噪。
 *
 * 背景：AI 页面的 DevTools Console 会持续出现 `[Cuckoo Code]` 启动/注入、
 * 拦截器、看门狗、插件等诊断日志。它们不是品牌指纹缺失的原因，但会把
 * “Cuckoo 正在注入页面”直接显示给打开 DevTools 的人。生产版不需要这些
 * 诊断输出，因此只静默 preload 的 log / info / debug，保留 warn / error。
 *
 * 注意：只改 preload 隔离世界的 console，不碰页面主世界的 console；
 * 页面自己的日志与控制台行为不受影响。开发启动（electron .）或
 * CUCKOO_DEBUG=1 时保持全部日志，避免调试失明。
 */
/**
 * 判断是否需要保留完整控制台日志。
 * @param env 环境变量表，默认取 `process.env`
 * @param defaultApp 是否为 `electron .` 开发启动；打包版为 false/undefined
 * @param argv 渲染进程参数，默认取 `process.argv`；主进程在开发态会附加 `--cuckoo-debug`
 * @returns true 表示保留日志，false 表示生产静默
 */
export function isDebugConsoleEnabled(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
  defaultApp: boolean | undefined = typeof process !== 'undefined'
    ? (process as any).defaultApp
    : undefined,
  argv: string[] = typeof process !== 'undefined' && Array.isArray(process.argv)
    ? process.argv
    : [],
): boolean {
  const flag = String(env.CUCKOO_DEBUG || '').trim().toLowerCase();
  return defaultApp === true || flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on' || argv.includes('--cuckoo-debug');
}

/**
 * 按运行环境安装控制台过滤器。
 * @param target 目标 console；测试可注入假对象
 * @param debug 是否保留日志；默认按运行环境判断
 * @returns 是否实际安装了过滤器；调试模式返回 false
 */
export function installConsoleFilter(
  target: Pick<Console, 'log' | 'info' | 'debug'> = console,
  debug: boolean = isDebugConsoleEnabled(),
): boolean {
  if (debug) return false;
  try {
    const noop = () => {};
    target.log = noop;
    target.info = noop;
    target.debug = noop;
    return true;
  } catch (_) {
    return false;
  }
}
