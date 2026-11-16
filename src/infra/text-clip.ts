/**
 * 文本头尾保留截断（工具输出源头与回填层共用）。
 *
 * 只砍尾巴会丢掉错误栈、最终结论这些最常在尾部的信息；
 * 只砍头部会丢掉任务背景与前文。统一保留头尾，中间用明确标记占位。
 */

/** 截断标记：必须保留 `...[输出过长已截断]...` 原文，系统提示词的「截断自救纪律」依赖它 */
export const OUTPUT_TRUNC_MARKER =
  '...[输出过长已截断]...（已保留头尾关键部分；严禁再次输出全量，请改用 read 的 offset/limit 分段读取，或在脚本中 slice/filter 后 log）';

/**
 * 头尾保留截断：默认 65% 头 / 35% 尾。
 * @param text 原始文本
 * @param max 目标上限（含标记）
 * @param marker 截断标记
 */
export function clipMiddleText(text: string, max: number, marker: string = OUTPUT_TRUNC_MARKER): string {
  if (!text || text.length <= max) return text;
  const keep = max - marker.length - 2;
  if (keep <= 0) return text.slice(0, max);
  const head = Math.floor(keep * 0.65);
  const tail = keep - head;
  return text.slice(0, head) + '\n' + marker + '\n' + text.slice(text.length - tail);
}
