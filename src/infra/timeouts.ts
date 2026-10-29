/**
 * 全局超时常量（唯一真相源）
 *
 * 放在 infra 最底层：bridge / tools / app 都能 import，避免同一数字在多处漂移。
 */

/** 子代理（runAgent）单次执行上限：10 分钟 */
export const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** 网关隐藏窗口问答（runGatewayQuery）上限：5 分钟 */
export const GATEWAY_TIMEOUT_MS = 5 * 60 * 1000;

/** 工具执行遮罩默认显示上限（普通工具）：5 分钟 */
export const MASK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 遮罩在「子代理任务」下的显示上限：子代理 10min + 2min 余量。
 * 遮罩必须活得比任务久，否则任务还在跑、遮罩先消失，用户会以为卡死。
 */
export const MASK_SUBAGENT_TIMEOUT_MS = SUBAGENT_TIMEOUT_MS + 2 * 60 * 1000;

/** 遮罩超时后的降级倒计时提示（秒） */
export const MASK_DEGRADED_HINT_SEC = 4;
