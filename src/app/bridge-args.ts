/**
 * AI 页面 bridge preload 的 additionalArguments 构造。
 *
 * 为什么需要显式参数：preload 渲染进程里拿不到主进程的
 * `process.defaultApp`（官方文档明确该属性只在主进程为 true），
 * 所以开发态必须由主进程把标记传给 renderer，过滤器才能保留日志。
 */

/** 构造 bridge preload 启动参数所需的选项 */
export interface BridgeArgsOptions {
  isPackaged: boolean;
  userDataPath: string;
  subagentArg?: string | null;
}

/**
 * @param options bridge preload 启动参数选项
 * @returns Electron webPreferences.additionalArguments
 */
export function buildBridgeAdditionalArguments(options: BridgeArgsOptions): string[] {
  const args = ['--cuckoo-user-data=' + options.userDataPath];
  if (!options.isPackaged) args.push('--cuckoo-debug');
  if (options.subagentArg) args.push(options.subagentArg);
  return args;
}
