/**
 * 模型输出速度（tokens per second）
 *
 * 两条路径：
 *  1) 精确路径：DeepSeek 每帧下发 accumulated_token_usage（= 对话上下文累计 token），
 *     本轮输出 token = 当前值 − 本轮起始值，TpsMeter 优先采用。**不含输入 token**。
 *  2) 回退估算：ChatGPT/Claude hook 未提供 token 用量，用正文长度近似估算。
 *     - CJK 约 0.7 token/字（DeepSeek BPE 常合并双字词）
 *     - 英文/符号约 0.28 token/字符（约 3.5 字符/token）
 *     - 数字约 0.35/位，空白约 0.25/字符，emoji 约 2.5/个
 *     仅用于体感展示，非计费口径。
 *
 * 新一轮检测：正文长度回退（本轮正文从 0 重新累积）即视为新一轮开始，
 * 自动重置基准。这样即使上一轮被中止（未收到 finished），也不会把两轮 token 叠加。
 *
 * ⚠️ 速度口径：用**滑动窗口**（最近 WINDOW_MS 内的 token 增量 / 时间增量）而非整轮平均。
 * 整轮平均会把整个思考阶段计入分母：思考 20s（慢）+ 正文 5s（快）→ 平均被严重拉低，
 * 与"肉眼看到的出字速度"严重不符（用户反馈"出字飞快却显示 8"）。滑动窗口反映近期真实速度。
 */

/** 估算一段文本的 token 数（近似；仅在无服务端 token 时回退使用） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) || []).length;
  const emoji = (text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  const spaces = (text.match(/\s/g) || []).length;
  const rest = Math.max(0, text.length - cjk - emoji - digits - spaces);
  return Math.round(cjk * 0.7 + emoji * 2.5 + digits * 0.35 + spaces * 0.25 + rest * 0.28);
}

/** 滑动窗口长度（ms）：反映最近这段时间的速度（比整轮平均更贴近肉眼体感） */
const WINDOW_MS = 4000;
/** 窗口内最小时间跨度（秒）：过短会让 TPS 抖动/虚高 */
const MIN_WINDOW = 0.5;

/**
 * 测速器：滑动窗口实时算 TPS。
 * - 优先用服务端 accumulated_token_usage 差值算本轮已输出 token，否则正文长度估算；
 * - 采样最近 WINDOW_MS 内的 (时间, 已输出token)，用窗口内增量算速度；
 * - 结束（finished）后冻结最终值，下一轮开始自动重置基准（防叠加）。
 */
export function createTpsMeter() {
  let startAt = 0;        // 本轮起始时间（ms）
  let baseAcc = 0;        // 本轮起始 accumulated（差值基准）
  let hasAcc = false;     // 本轮是否已收到服务端 token
  let accEverGrew = false; // 本轮 acc 是否曾增长过（区分"acc 失效"与"本帧恰好无新 token"）
  let running = false;    // 本轮是否进行中
  let value = 0;          // 最近一次算出的 TPS（跨轮保留供展示）
  let tokens = 0;         // 最近一次的本轮已输出 token
  let lastTextLen = 0;    // 上一帧正文长度，用于检测新一轮
  let samples: { t: number; tok: number }[] = []; // 滑动窗口采样（本轮）

  /** 开始新一轮：只重置"本轮计算状态"，保留 value 供展示（避免归零） */
  function startNewRound(): void {
    startAt = 0; baseAcc = 0; hasAcc = false; accEverGrew = false;
    running = false; tokens = 0; lastTextLen = 0; samples = [];
  }

  return {
    /**
     * 流式更新。finished 为 true 时结束本轮（冻结 value）。
     * acc 为服务端 accumulated_token_usage；优先用其差值算精确 TPS，否则回退估算。
     */
    update(text: string, finished: boolean, acc: number | null = null, now: number = Date.now()): number {
      if (finished) { running = false; return value; }

      const textLen = (text || '').length;
      // 新一轮检测：上一轮已结束，或正文长度回退（本轮正文重新累积）
      if ((!running && startAt !== 0) || (startAt !== 0 && textLen < lastTextLen)) {
        startNewRound();
      }
      running = true;
      lastTextLen = textLen;

      // 本轮已输出 token：优先服务端精确差值（不含输入 token）
      let outTokens = -1;
      let justBaselined = false; // 本帧刚建立基准（acc 差值必为 0）→ tok 记 0，作为窗口起点
      if (typeof acc === 'number' && acc >= 0) {
        if (!hasAcc) { baseAcc = acc; hasAcc = true; startAt = now; justBaselined = true; }
        const accTokens = acc - baseAcc;
        if (accTokens > 0) { outTokens = accTokens; accEverGrew = true; }
        else if (justBaselined) outTokens = 0;
      }
      if (outTokens < 0) {
        if (hasAcc && accEverGrew) {
          // acc 曾增长、本帧暂停 → 沿用当前累计 token（本帧无新增），保持窗口口径一致。
          // 不可回退正文估算：两者量纲不同（acc 数百 vs 估算数十），混用会污染窗口。
          outTokens = tokens;
        } else {
          // acc 不可用（平台不提供）或本轮从未增长 → 用正文长度估算
          outTokens = estimateTokens(text);
          if (outTokens <= 0) {
            // 尚无新增输出：若计时已开始，push 当前累计 token 的采样点（保持窗口新鲜）
            if (startAt !== 0) {
              samples.push({ t: now, tok: tokens });
              while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift();
            }
            return value;
          }
          if (startAt === 0) startAt = now;
        }
      }
      tokens = outTokens;

      // 滑动窗口采样 + 裁剪
      samples.push({ t: now, tok: tokens });
      while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift();

      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dt = (last.t - first.t) / 1000;
        const dtok = last.tok - first.tok;
        if (dt >= MIN_WINDOW && dtok > 0) value = dtok / dt;
      }
      return value;
    },
    /** 完全重置（如切换会话）：清空本轮状态与展示值 */
    reset(): void { startNewRound(); value = 0; },
    get value(): number { return value; },
    get tokens(): number { return tokens; },
    /** 本轮是否正在生成计时中 */
    get active(): boolean { return running; },
  };
}

/** 把 TPS 格式化为展示文本（无数据返回空串） */
export function formatTps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}
