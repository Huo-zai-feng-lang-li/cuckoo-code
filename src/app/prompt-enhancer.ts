/**
 * 提示词增强：调用独立 LLM API，把用户草稿改写成更清晰的提示词。
 *
 * 设计原则（参照 Augment / DSH 系列插件）：
 *   - 旁路调用，不占 AI 网页对话轮次（与 bridge 完全隔离）
 *   - 只回填输入框，不自动发送
 *   - 失败不动原输入
 *
 * 依赖：ui-prefs（读配置）。纯 Node（fetch），可在测试中直接跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPrefs, type PromptEnhancerConfig } from './ui-prefs.js';

export interface EnhanceHistoryItem {
  /** 'user' | 'assistant' */
  role: string;
  /** 正文 */
  content: string;
}

export interface EnhanceInput {
  /** 当前草稿 */
  text: string;
  /** 最近对话（按时间顺序，末尾为最近） */
  history?: EnhanceHistoryItem[];
  /** 项目目录（读 package.json 提取技术栈） */
  projectDir?: string | null;
}

export interface EnhanceResult {
  success: boolean;
  /** 增强后的提示词（成功时） */
  text?: string;
  /** 错误信息（失败时） */
  error?: string;
}

const MAX_MSG_CHARS = 1000;   // 单条历史截断上限
const REQUEST_TIMEOUT_MS = 30000;

/** 截断字符串 */
function clip(s: string, n: number): string {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) : s;
}

/** 读项目技术栈关键词（package.json 的 name + 依赖名） */
export function readProjectTech(projectDir: string | null | undefined): string {
  if (!projectDir) return '';
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return '';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const parts: string[] = [];
    if (pkg && typeof pkg.name === 'string' && pkg.name) parts.push('项目名: ' + pkg.name);
    const deps = Object.keys({ ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) });
    if (deps.length) parts.push('依赖: ' + deps.slice(0, 30).join(', '));
    return parts.join('; ');
  } catch (_) {
    return '';
  }
}

/** 构造 system 提示词（用户自定义优先） */
export function buildSystemPrompt(cfg: PromptEnhancerConfig, tech: string): string {
  if (cfg.systemPrompt && cfg.systemPrompt.trim()) return cfg.systemPrompt.trim();
  const ctxLine = tech
    ? ('\n\n当前项目信息：' + tech + '\n（仅在相关时参考，不要臆造项目里没有的东西。）')
    : '';
  if (cfg.mode === 'strict') {
    return [
      '你是提示词增强助手。把用户的需求改写成一个结构化、可执行的提示词，包含：角色/目标、上下文、约束条件、输出格式。',
      '只输出改写后的提示词本身，不要任何解释、前言或后记。不要臆造用户没提供的事实（文件名、数值、库版本）。',
    ].join('\n') + ctxLine;
  }
  // gentle（默认）
  return [
    '你是提示词增强助手。把用户的需求改写得更清晰、更具体，但要克制：',
    '- 保留用户的原始意图与措辞，只在必要时补充缺失的关键信息（如技术栈、输出格式、约束）。',
    '- 如果原句已经足够清楚，只做轻微润色，不要为了改写而改写。',
    '- 绝对不要臆造事实（文件名、数值、库版本）；不确定的地方不要编。',
    '- 如果缺少会导致方向性错误的关键信息，在改写末尾用一行「需要确认：...」列出 1-3 个问题。',
    '只输出改写后的提示词本身，不要任何解释、前言或后记。',
  ].join('\n') + ctxLine;
}

/** 组装 messages（system + 最近 N 轮历史 + 当前草稿） */
export function buildMessages(cfg: PromptEnhancerConfig, input: EnhanceInput, tech: string): any[] {
  const msgs: any[] = [{ role: 'system', content: buildSystemPrompt(cfg, tech) }];
  const rounds = Math.max(0, Math.min(20, cfg.contextRounds || 0));
  if (rounds > 0 && Array.isArray(input.history) && input.history.length) {
    const h = input.history.slice(-rounds * 2);
    for (const it of h) {
      if (!it || !it.content) continue;
      const role = it.role === 'assistant' ? 'assistant' : 'user';
      msgs.push({ role, content: clip(it.content, MAX_MSG_CHARS) });
    }
  }
  msgs.push({ role: 'user', content: input.text });
  return msgs;
}

/**
 * 主函数：增强提示词。
 * @param input 草稿 + 历史 + 项目目录
 * @param cfgOverride 可选配置覆盖（测试用；缺省读 ui-prefs）
 */
export async function enhancePrompt(input: EnhanceInput, cfgOverride?: PromptEnhancerConfig): Promise<EnhanceResult> {
  const text = ((input && input.text) || '').trim();
  if (!text) return { success: false, error: '输入为空' };

  const cfg = cfgOverride || readPrefs().promptEnhancer;
  if (!cfg.apiUrl || !cfg.apiKey) {
    return { success: false, error: '未配置 API（请在设置里填写 API 地址与 Key）' };
  }

  const tech = readProjectTech(input.projectDir);
  const messages = buildMessages(cfg, { ...input, text }, tech);

  // 拼接 endpoint（apiUrl 可能带或不带尾斜杠）
  const base = cfg.apiUrl.replace(/\/+$/, '');
  const endpoint = base + '/chat/completions';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, max_tokens: 2000 }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { success: false, error: 'API 错误 ' + resp.status + (body ? (': ' + clip(body, 200)) : '') };
    }
    const data: any = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const out = typeof content === 'string' ? content.trim() : '';
    if (!out) return { success: false, error: 'API 返回为空' };
    return { success: true, text: out };
  } catch (err: any) {
    if (err && err.name === 'AbortError') return { success: false, error: '增强超时（30 秒）' };
    return { success: false, error: '请求失败: ' + ((err && err.message) || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}
