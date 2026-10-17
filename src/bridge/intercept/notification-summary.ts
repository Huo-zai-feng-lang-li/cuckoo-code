/**
 * 系统通知摘要归一化（纯函数，不依赖 window/document，便于单测）。
 *
 * B-007：历史实现误写为 `.replace(/s+/g, ' ')`，匹配的是字面字母 s 而非空白，
 * 导致英文/混排回复的通知摘要被吞掉所有 s（"Successfully" → "Succe fully"）。
 * 此处统一用 `\s+`（含空格/换行/tab）折叠连续空白。
 */

/**
 * 把 AI 回复正文归一化为系统通知摘要：
 * 折叠连续空白为单个空格、去首尾空白、截断到 maxLen。
 * @param raw 原始回复文本
 * @param maxLen 最大长度（默认 120）
 */
function buildNotificationSummary(raw: any, maxLen = 120): string {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export { buildNotificationSummary };
