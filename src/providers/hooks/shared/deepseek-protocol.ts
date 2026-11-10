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

/**
 * 判定 `response/fragments` 更新帧的语义：全量快照（需重置累积文本）还是增量（追加）。
 *
 * 背景（真机问题）：DeepSeek 的增量帧会重复下发整组 fragments（含已输出过的内容），
 * 若一律按增量 `text += c / thinkText += c` 累加，思考内容与正文会被重复叠加
 * （纯净模式下表现为思考过程出现两份、三份）。
 *
 * 旧判据的缺陷：只看 `op === 'SET'`。但 `flattenDelta` 展开 `BATCH` 批量帧时，
 * 子项的 o 会**继承 'BATCH'**（见本文件 BATCH 分支），于是整组重放的 BATCH 帧
 * 被当成增量 → 内容叠加成两份、三份。协议用哪个 op 是服务端实现细节，
 * 靠它判语义是脆弱假设（已实测翻车）。
 *
 * 现判据（与 op 无关，只看内容）：本帧 fragments 重建出的思考/正文，若以已累积的
 * 思考/正文为**前缀**（含完全相等），即为全量快照重放 → 重置；否则是真实增量块 → 追加。
 *   - 重放帧：内容相等或更长且前缀一致 → 重置重建，不会重复；
 *   - 增量帧：内容是全新的下一段，前缀必然不符 → 追加，不会丢已输出内容。
 * 无内容信息时（首帧前 / 纯类型调用）退回类型判定，保持向后兼容。
 *
 * @param prevTypes 已累积的 fragment 类型列表
 * @param nextTypes 本帧下发的 fragment 类型列表
 * @param op 本帧操作符（仅作无内容信息时的兜底判据）
 * @param prevText 已累积正文
 * @param prevThink 已累积思考
 * @param nextText 本帧 fragments 重建出的正文
 * @param nextThink 本帧 fragments 重建出的思考
 * @returns reset=true 时必须重置累积文本后再消费本帧内容
 */
export function planFragmentsUpdate(
  prevTypes: string[],
  nextTypes: string[],
  op?: string,
  prevText?: string,
  prevThink?: string,
  nextText?: string,
  nextThink?: string
): { reset: boolean; types: string[] } {
  const prev = Array.isArray(prevTypes) ? prevTypes : [];
  const next = Array.isArray(nextTypes) ? nextTypes : [];
  const pT = typeof prevText === 'string' ? prevText : '';
  const pK = typeof prevThink === 'string' ? prevThink : '';
  const nT = typeof nextText === 'string' ? nextText : '';
  const nK = typeof nextThink === 'string' ? nextThink : '';

  // 有内容信息 → 按内容前缀判定（BATCH / SET / append 一视同仁）
  if (pT || pK || nT || nK) {
    const thinkReplay = nK === pK || nK.indexOf(pK) === 0;
    const textReplay = nT === pT || nT.indexOf(pT) === 0;
    if (thinkReplay && textReplay) return { reset: true, types: next };
    return { reset: false, types: prev.concat(next) };
  }

  // 无内容信息 → 退回类型判定（兼容旧调用与单测）
  const isSet = op === undefined || op === null || op === '' || String(op).toUpperCase() === 'SET';
  if (isSet && next.length >= prev.length) return { reset: true, types: next };
  return { reset: false, types: prev.concat(next) };
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
