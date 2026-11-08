/**
 * DeepSeek SSE 协议与 Delta 状态化处理纯函数。
 * 被 esbuild 打包进 deepseek hook（主世界），同时可被 vitest 在 Node 单测。
 * 不引用 window/document。
 */

export interface DeltaState {
  op: string;
  path: string;
}

export interface FlatDelta {
  p: string;
  o: string;
  v: any;
  raw?: any;
}

/** 展平并补全 Delta 操作路径（对齐官方 class xY 的 op/path 状态继承与 BATCH 路径级联） */
export function flattenDelta(item: any, parentPath: string, state: DeltaState): FlatDelta[] {
  if (!item || typeof item !== 'object') return [];
  var op = item.o != null ? item.o : (state.op || 'SET');
  var p = item.p != null ? item.p : (state.path || '');
  var fullPath = parentPath ? (p ? (parentPath + '/' + p) : parentPath) : p;

  if (op === 'BATCH' && Array.isArray(item.v)) {
    var res: FlatDelta[] = [];
    for (var bi = 0; bi < item.v.length; bi++) {
      var sub = item.v[bi];
      if (!sub || typeof sub !== 'object') continue;
      var subOp = sub.o != null ? sub.o : op;
      var subP = sub.p != null ? sub.p : '';
      var subFullPath = fullPath ? (subP ? (fullPath + '/' + subP) : fullPath) : subP;
      if (subOp === 'BATCH' && Array.isArray(sub.v)) {
        res = res.concat(flattenDelta(sub, fullPath, state));
      } else {
        res.push({ p: subFullPath, o: subOp, v: sub.v, raw: sub });
      }
    }
    return res;
  }

  state.op = op;
  state.path = fullPath;
  return [{ p: fullPath, o: op, v: item.v, raw: item }];
}

export type DeepSeekStreamStatus = 'finished' | 'stopped' | 'error';

/**
 * 判定 DeepSeek 流退出终态：
 * 1) 用户主动停止（stop_stream）→ 'stopped'
 * 2) 服务端截断（INCOMPLETE）→ 'error'
 * 3) 流内明确命中限流（event: toast/hint）→ 'error'
 * 4) 收到完成事件（event: finish/close 或 response/status=FINISHED）：
 *    正文为空（哪怕有思考）→ 'error'（触发重试）
 *    正文非空 → 'finished'
 * 5) 未收到完成事件，但流正常自然结束且有正文 → 'finished'
 * 6) 其余兜底 → 'error'
 */
export function decideDeepSeekStreamExit(opts: {
  userStopped?: boolean;
  incomplete?: boolean;
  streamRateLimit?: boolean;
  finished?: boolean;
  textLen: number;
}): DeepSeekStreamStatus {
  if (opts.userStopped) return 'stopped';
  if (opts.incomplete) return 'error';
  if (opts.streamRateLimit) return 'error';
  if (opts.finished) {
    if (opts.textLen === 0) return 'error';
    return 'finished';
  }
  if (opts.textLen > 0) return 'finished';
  return 'error';
}
