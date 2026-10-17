/**
 * Claude 流终态判定（hook 共享纯函数）。
 *
 * 被 esbuild 打包进 claude hook（主世界），同时可被 vitest 在 Node 单测。
 * 不引用 window/document。
 *
 * B-002：历史 claude hook 在 fetch pump catch / XHR readyState=4 时，不看错误与状态，
 * 一律 `dispatch(截断正文, true)` 当"finished 成功"派发——断流截断的半段正文被当终态，
 * 自动重试引擎收不到 error 不会重试，若截断落在 ```cuckoo 块中途还会执行残缺代码。
 * 对照 DeepSeek/ChatGPT 在同样的 catch 里都 dispatch 'error'。本函数把终态判定从
 * 浏览器事件里抽出来，便于钉死回归。
 */

/** 流退出的终态：'finished' 正常完成 / 'error' 失败（触发重试） */
export type ClaudeStreamExit = 'finished' | 'error';

/**
 * @param opts.sawMessageStop 是否收到 message_stop 帧（Claude 正常完成标志）
 * @param opts.text 已累积正文（截断时可能为半段）
 * @param opts.networkError fetch reader.read() 走了 catch（网络异常/连接被掐）；
 *        与"流正常走到尾"区分开——断流即错误，不套用宽容策略
 * @param opts.aborted 是否用户主动中止（AbortError）；中止不触发重试
 * @param opts.httpStatus XHR 终态的 HTTP 状态码；fetch 路径传 null/undefined
 * @returns 终态
 */
function decideClaudeStreamExit(opts: {
  sawMessageStop: boolean;
  text: string;
  networkError?: boolean;
  aborted?: boolean;
  httpStatus?: number | null;
}): ClaudeStreamExit {
  // fetch pump catch：网络异常/断流。用户中止（AbortError）按完成收尾，其余一律失败
  if (opts.networkError) {
    return opts.aborted ? 'finished' : 'error';
  }
  // 流正常走到尾（reader.done / XHR readyState=4）：按 HTTP 状态与完成标志判定
  // HTTP 非 2xx：明确失败
  if (typeof opts.httpStatus === 'number' && (opts.httpStatus < 200 || opts.httpStatus >= 300)) {
    return 'error';
  }
  // 收到 message_stop：正常完成（空正文由 dispatch 内部转 empty-error）
  if (opts.sawMessageStop) return 'finished';
  // 未收到 message_stop 但流自然结束：对齐 DeepSeek/ChatGPT 的宽容策略——
  // 有正文视为完成；无正文 = 截断/空响应 → 失败触发重试
  if (opts.text && opts.text.trim()) return 'finished';
  return 'error';
}

export { decideClaudeStreamExit };
