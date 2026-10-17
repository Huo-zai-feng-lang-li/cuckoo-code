/**
 * 工作区信任门编排（D-002 + D-004 合并）
 *
 * 用户选定项目目录后、buildPrompt / MCP 连接之前调用 ensureWorkspaceTrust：
 *   - 无目录 / 无 .agents 工件（mcp.json/rules/skills）→ 不弹，视为可信；
 *   - 已信任（持久/会话）→ 不弹，直接返回；
 *   - 否则弹主进程三按钮对话框（默认聚焦"不信任"），detail 列出将运行的
 *     MCP server 与规则/技能数；选择结果写入信任记录。
 *
 * 子代理（noDialog）/压缩 presetDir 等自动场景由调用方直接按"不信任"处理
 * （不弹），不在这里决定。
 */
import { createRequire } from 'node:module';
import {
  scanWorkspaceArtifacts,
  isWorkspaceTrusted,
  setWorkspaceTrust,
  type TrustScope,
} from '../infra/workspace-trust.js';

const require = createRequire(import.meta.url);

/** 可注入 dialog（测试用） */
let _dialog: any = null;
export function __setTrustPromptDialog(d: any): void {
  _dialog = d;
}

function getDialog(): any {
  if (_dialog) return _dialog;
  try { return require('electron').dialog; } catch (_) { return null; }
}

export interface TrustPromptResult {
  trusted: boolean;
  scope: TrustScope;
}

/** 组装对话框 detail 文本 */
export function buildTrustDetail(dir: string): string {
  const art = scanWorkspaceArtifacts(dir);
  const lines: string[] = [];
  if (art.mcp.length) {
    lines.push('将启动 ' + art.mcp.length + ' 个 MCP server（在你电脑上运行）：');
    for (const s of art.mcp.slice(0, 8)) {
      const src = s.url ? 'url=' + s.url : ((s.command || '') + ' ' + (s.args || []).join(' ')).trim();
      lines.push('  - ' + s.name + (src ? '（' + src + '）' : ''));
    }
    if (art.mcp.length > 8) lines.push('  … 其余 ' + (art.mcp.length - 8) + ' 个从略');
  }
  if (art.rules.length) lines.push('项目规则 ' + art.rules.length + ' 条（注入系统提示词）');
  if (art.skills.length) lines.push('项目技能 ' + art.skills.length + ' 个（注入系统提示词）');
  lines.push('');
  lines.push('这些内容将在你电脑上运行或注入提示词。未信任时项目级 MCP / 规则 / 技能均不启用。');
  return lines.join('\n');
}

/**
 * 确保工作区信任：无工件/已信任直接返回；否则弹三按钮确认框。
 * @param parentWin 父窗口（可能为 null/已销毁，对话框退化为无父窗）
 * @param dir 项目目录
 */
export async function ensureWorkspaceTrust(parentWin: any, dir: string | null): Promise<TrustPromptResult> {
  if (!dir) return { trusted: true, scope: 'trusted' };
  const art = scanWorkspaceArtifacts(dir);
  const hasArtifacts = art.mcp.length > 0 || art.rules.length > 0 || art.skills.length > 0;
  if (!hasArtifacts) return { trusted: true, scope: 'trusted' };
  if (isWorkspaceTrusted(dir)) return { trusted: true, scope: 'trusted' };

  const dlg = getDialog();
  if (!dlg) {
    // 无 dialog 能力（异常环境）：保守按"不信任"，不静默启用项目级内容
    setWorkspaceTrust(dir, 'untrusted');
    return { trusted: false, scope: 'untrusted' };
  }
  const parent = parentWin && !parentWin.isDestroyed() ? parentWin : null;
  const res = await dlg.showMessageBox(parent, {
    type: 'warning',
    buttons: ['信任并启用', '仅本次会话', '不信任'],
    defaultId: 2, // 默认聚焦"不信任"
    cancelId: 2,
    title: '信任此工作区？',
    message: '该项目包含将在你电脑上运行的内容（MCP / 规则 / 技能）',
    detail: buildTrustDetail(dir),
  });
  const idx = typeof res === 'object' && res !== null ? res.response : 2;
  if (idx === 0) {
    setWorkspaceTrust(dir, 'trusted');
    return { trusted: true, scope: 'trusted' };
  }
  if (idx === 1) {
    setWorkspaceTrust(dir, 'session');
    return { trusted: true, scope: 'session' };
  }
  setWorkspaceTrust(dir, 'untrusted');
  return { trusted: false, scope: 'untrusted' };
}
