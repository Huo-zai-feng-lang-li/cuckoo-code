/**
 * 远程控制用的路径工具（零依赖纯函数，便于单测）。
 *
 * 从 manager.ts 抽出：manager 依赖 electron（createRequire），在测试环境无法 import，
 * 导致纯函数只能靠"源码正则 + new Function"这种脆弱方式测。
 */

/**
 * 取项目目录的末段名（`D:\work\cuckoo-code` → `cuckoo-code`）。
 *
 * - 无目录 / 空串 / 全是分隔符 → 返回空串
 * - 忽略尾部斜杠
 * - Windows 盘符根（`D:\` / `C:`）→ 返回空串：对用户无意义，不如只显示窗口名
 */
export function projectNameOf(dir: string | undefined): string {
  if (!dir) return '';
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  return /^[A-Za-z]:$/.test(last) ? '' : last;
}
