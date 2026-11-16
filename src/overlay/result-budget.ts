/**
 * 工具结果回填的长度预算（纯函数，便于单元测试）。
 *
 * 背景：DeepSeek App/网页端 2026-11 起把单次输入限制在约 4 万字（非官方公告，媒体与用户实测）。
 * 单条工具结果此前按 15,000 字符截断，但多段汇总没有总预算：3 段就能到 45,000+，
 * 再加用户草稿必然越过站点上限。这里统一按总预算均分，并保留头尾关键部分。
 */

/** 单条工具结果上限（保持原行为） */
export const MAX_ITEM_CHARS = 15000;
/** 回填消息总预算：低于站点约 4 万字，给用户草稿与分隔符留余量 */
export const MAX_RESULT_TOTAL_CHARS = 26000;
/** 单条消息硬上限：站点约 4 万字，留 1,000 字符安全余量 */
export const MAX_MESSAGE_CHARS = 39000;

/** 截断标记：必须保留 `...[输出过长已截断]...` 原文，系统提示词的「截断自救纪律」依赖它 */
export const TRUNC_MARKER =
  '...[输出过长已截断]...（已保留头尾关键部分；严禁再次输出全量，请改用 read 的 offset/limit 分段读取，或在脚本中 slice/filter 后 log）';

/**
 * 计算每条结果的可用预算：多段均分，最少 200 字符。
 * 下限不能再高（2,000 会让 20 段时总量冲到 40,000），否则总预算形同虚设。
 * @param count 结果段数
 * @param maxTotal 回填总预算
 * @param maxItem 单条上限
 */
export function budgetPerItem(
  count: number,
  maxTotal: number = MAX_RESULT_TOTAL_CHARS,
  maxItem: number = MAX_ITEM_CHARS
): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.max(200, Math.min(maxItem, Math.floor(maxTotal / count)));
}

/**
 * 头尾保留截断：错误栈/结论通常在尾部，只砍尾巴会让模型看不到关键信息。
 * @param text 原始文本
 * @param max 目标上限（含标记）
 * @param marker 截断标记
 */
export function clipToolText(text: string, max: number, marker: string = TRUNC_MARKER): string {
  if (!text || text.length <= max) return text;
  const keep = max - marker.length - 2;
  if (keep <= 0) return text.slice(0, max);
  const head = Math.floor(keep * 0.65);
  const tail = keep - head;
  return text.slice(0, head) + '\n' + marker + '\n' + text.slice(text.length - tail);
}

/**
 * 拼「用户草稿 + 工具结果」，并保证整条消息不超单次上限。
 * 草稿永远完整保留；超长时只裁结果段，且不会把草稿重复拼接。
 * @param draft 用户在输入框里已有的内容
 * @param result 工具结果正文
 * @param maxMessage 单条消息硬上限
 * @param sep 分隔符
 */
export function fitDraftAndResult(
  draft: string,
  result: string,
  maxMessage: number = MAX_MESSAGE_CHARS,
  sep: string = '\n'
): string {
  if (!draft) return clipToolText(result, maxMessage, TRUNC_MARKER);
  const reserved = draft.length + sep.length * 2;
  const room = Math.max(2000, maxMessage - reserved);
  const capped = clipToolText(result, room, TRUNC_MARKER);
  return draft + sep + sep + capped;
}
