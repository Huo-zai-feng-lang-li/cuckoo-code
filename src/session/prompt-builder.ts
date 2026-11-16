/**
 * 系统提示词组装：读取模板、填充占位符、拼装 MCP/平台/项目章节
 * 由 project-context.ts 拆分而来（P4.5）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getProvider } from '../providers/registry.js';
import * as mcpClient from '../mcp/client.js';
import { resolveSrc, resolveToolSpec } from '../infra/paths.js';
import { registry as toolRegistry } from '../tools/index.js';
import { scanSkills, buildSkillsSection } from '../skills/index.js';
import { scanAgents, buildAgentsSection } from '../agents/index.js';
import { scanRules, getUnscopedRules, buildUnscopedRulesSection } from '../rules/index.js';
// 直接引 roots 子模块（不走 plugins 的 barrel），避免把整个插件模块图拉进来
import { getPluginScanRoots } from '../plugins/roots.js';
import type { PluginScanRoots } from '../plugins/roots.js';
import { buildMemorySection } from '../infra/memories.js';
import { isWorkspaceTrusted } from '../infra/workspace-trust.js';
// DSH 插件注册的提示词段（C4）
import { getPromptSections as getDshPromptSections } from '../plugins/dsh-compat/prompt-sections.js';

// 提示词模板目录（D20：锚定应用根，与 dist 结构解耦）
const PROMPT_DIR = resolveSrc('prompt');

/**
 * 单条消息硬预算（字符）。
 * DeepSeek App/网页端自 2026-11 起把单次输入限制在约 4 万字（非官方公告，媒体与用户实测），
 * 这里留 4,000 字符余量，防止首条系统提示词在站点侧被静默截断。
 */
const MAX_PROMPT_CHARS = 36000;
/** 项目介绍（CUCKOO.md）单段上限：超出截断，全文由模型按需 read */
const MAX_PROJECT_INTRO_CHARS = 6000;
/** 项目介绍降级上限 */
const MAX_PROJECT_INTRO_COMPACT = 3000;
/** 无 paths 规则章节上限：超出只保留「名字 + 路径」索引 */
const MAX_RULES_SECTION_CHARS = 7000;
/** 技能章节上限：超出先压缩描述，再降级为「名字 + 路径」 */
const MAX_SKILLS_SECTION_CHARS = 4000;
/** 子代理章节上限 */
const MAX_AGENTS_SECTION_CHARS = 1200;
/** 用户记忆章节上限 */
const MAX_MEMORY_SECTION_CHARS = 2500;
/** DSH 插件提示段上限 */
const MAX_DSH_SECTION_CHARS = 3000;

/**
 * 读取平台提示词模板。
 * 优先级：1) provider.getPromptTemplate()  2) src/prompt/{id}.md  3) src/prompt/default.md
 * @returns { content, path }，失败时 content 为空串并带 message
 */
function loadTemplate(providerId: string): { content: string; path: string; error?: string } {
  const provider = getProvider(providerId);
  let templateContent = '';
  let templatePath = '';

  if (provider && typeof provider.getPromptTemplate === 'function') {
    try {
      const fromMethod = provider.getPromptTemplate();
      if (fromMethod && typeof fromMethod === 'string' && fromMethod.trim()) {
        templateContent = fromMethod;
        templatePath = '(provider.getPromptTemplate)';
      }
    } catch (err: any) {
      console.warn('[Cuckoo Code] 调用 provider.getPromptTemplate 失败:', err.message);
    }
  }

  if (!templateContent && providerId) {
    const candidate = path.join(PROMPT_DIR, providerId + '.md');
    if (fs.existsSync(candidate)) templatePath = candidate;
  }

  if (!templateContent && templatePath) {
    try {
      templateContent = fs.readFileSync(templatePath, 'utf-8');
    } catch (err: any) {
      return { content: '', path: templatePath, error: '读取提示词模板失败: ' + err.message };
    }
  }

  if (!templateContent) {
    templatePath = path.join(PROMPT_DIR, 'default.md');
    try {
      templateContent = fs.readFileSync(templatePath, 'utf-8');
      console.warn('[Cuckoo Code] 未找到平台模板，使用默认模板:', templatePath);
    } catch (err: any) {
      return { content: '', path: templatePath, error: '读取默认提示词模板失败: ' + err.message };
    }
  }

  return { content: templateContent, path: templatePath };
}

/** 生成平台信息章节（OS/arch/命令差异） */
function buildPlatformInfo(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') {
    return '- 操作系统：Windows（' + arch + '）\n  - bash 使用 cmd.exe（Windows 命令：cd / dir / echo %cd% / type / findstr）\n  - pwsh 使用 PowerShell（Get-Location / $env:VAR / Get-ChildItem）\n  - 路径分隔符为反斜杠 \\，传给工具的相对路径统一用正斜杠 /';
  }
  if (platform === 'darwin') {
    return '- 操作系统：macOS（' + arch + '）\n  - bash 使用 zsh/bash（Unix 命令：pwd / ls / cat / grep）\n  - 路径分隔符为正斜杠 /';
  }
  return '- 操作系统：Linux（' + arch + '）\n  - bash 使用 bash（Unix 命令：pwd / ls / cat / grep）\n  - 路径分隔符为正斜杠 /';
}

/** 生成 MCP 能力章节 */
function buildMcpSection(selectedDir: string | null): string {
  const enabledMcpServers = mcpClient.listConfiguredServers(selectedDir).filter(s => s.enabled);
  const mcpServerList = enabledMcpServers.length
    ? enabledMcpServers.map(s => '- ' + s.name + '（' + s.type + '，' + (s.connected ? '已连接' : '未连接') + '，工具数 ' + s.toolCount + '）').join('\n')
    : '（当前没有已配置且启用的 MCP server）';
  const mcpCwd = mcpClient.getDefaultMcpCwd();
  const mcpCwdLine = mcpCwd
    ? 'MCP 子进程的工作目录（cwd）：' + mcpCwd + '\n注意：MCP 工具（如截图、下载）返回的路径多为相对路径，实际文件位于该 cwd 下。若需读取/上传这些文件（如 attachFile），请把该 cwd 与相对路径用 / 拼接成绝对路径传入，例如：' + mcpCwd + '/page-xxx.png'
    : 'MCP 子进程的工作目录（cwd）：未确定（继承父进程）。MCP 工具返回的相对路径请以实际返回为准。';

  return [
    '## MCP 能力',
    '',
    '本应用支持 MCP（Model Context Protocol）外部工具扩展。',
    '',
    mcpCwdLine,
    '',
    '当前已配置且启用的 MCP server：',
    mcpServerList,
    '',
    '**使用 MCP 的强制流程（务必遵守）**：',
    '1. 先调 mcpListServers() 看有哪些 server、是否已连接',
    '2. **调用任何工具前，必须先调 mcpGetTools(server) 查看该 server 的工具列表与参数**（每个工具的名称、描述、参数名/类型都在这里）。不同 server/版本参数名可能不同，凭记忆猜参数极易失败。',
    '3. 按 mcpGetTools 返回的准确参数，通过 mcpCall(server, tool, args) 调用',
    '4. 工具返回的错误要仔细读（通常已说明失败原因，如参数缺失、引用过期），据此调整后重试',
    '',
    '注意：MCP server 可能未连接或未启用，以 mcpListServers() 的实时返回为准。',
    '',
    '如果你需要使用某个 MCP（例如浏览器自动化、数据库访问等），可以提示用户安装并配置对应的 MCP server。'
  ].join('\n');
}

/**
 * 截断一段提示词内容，并留下可诊断、可自救的说明。
 * 优先在换行处断开，避免把一行代码或一句规则切成两半。
 * @param text 原始内容
 * @param max 字符上限
 * @param hint 给模型的下一步提示（通常是"read 哪个文件"）
 */
function clipSection(text: string, max: number, hint: string): string {
  if (!text || text.length <= max) return text;
  let cut = text.lastIndexOf('\n', max);
  if (cut < Math.floor(max * 0.8)) cut = max;
  return text.slice(0, cut) + '\n\n…（内容过长已截断，原文 ' + text.length + ' 字符，仅保留前 ' + cut + ' 字符。' + hint + '）';
}

/**
 * 读取项目介绍（CUCKOO.md），无则返回空串。
 * 优先新路径 `.cuckoo/CUCKOO.md`，兼容旧路径 `.cuckooCode/CUCKOO.md`。
 */
function readProjectIntro(selectedDir: string): { content: string; path: string } {
  const candidates = [
    path.join(selectedDir, '.cuckoo', 'CUCKOO.md'),
    path.join(selectedDir, '.cuckooCode', 'CUCKOO.md'),
  ];
  const cuckooMdPath = candidates.find((p) => fs.existsSync(p));
  if (!cuckooMdPath) return { content: '', path: '' };
  try {
    const content = fs.readFileSync(cuckooMdPath, 'utf-8');
    console.log('[Cuckoo Code] 已读取 CUCKOO.md 内容:', cuckooMdPath);
    return { content, path: cuckooMdPath };
  } catch (err: any) {
    console.error('[Cuckoo Code] 读取 CUCKOO.md 失败:', err.message);
    return { content: '', path: '' };
  }
}

/**
 * 消费侧过滤（D-004 落地）：项目未在工作区信任门被信任时，
 * 剔除 source==='project' 的规则/技能（用户级/插件级不受影响）。
 * 数据层（mcp/config、skills/rules 扫描）另有兜底，这里是组装侧双保险。
 */
function filterProjectScoped<T extends { source?: string }>(items: T[], projectDir: string | null): T[] {
  if (!projectDir || isWorkspaceTrusted(projectDir)) return items;
  return items.filter((it) => !(it && it.source === 'project'));
}

/**
 * 组装完整的系统提示词（带总预算降级阶梯）。
 * 固定段（模板 + 工具契约 + 平台/MCP）永不裁剪；可裁剪段按 mode 逐级收紧，
 * 保证注入网页输入框的首条消息不触发站点静默截断。
 * @param opts { providerId, selectedDir, isCompaction }
 * @returns { prompt, error? }，error 存在时 prompt 为空
 */
function buildPrompt(opts: { providerId: string; selectedDir: string; isCompaction?: boolean }): { prompt: string; error?: string } {
  const { providerId, selectedDir, isCompaction } = opts;

  const tpl = loadTemplate(providerId);
  if (tpl.error) return { prompt: '', error: tpl.error };
  console.log('[Cuckoo Code] 已读取提示词模板:', tpl.path);

  // 工具 API 类型定义（从 d.ts 文件读取，避免与模板重复维护）
  let toolApiTypes = '';
  try {
    toolApiTypes = fs.readFileSync(resolveToolSpec(), 'utf-8');
  } catch (err) { /* 找不到时保持空串 */ }
  if (!toolApiTypes) {
    console.error('[Cuckoo Code] 读取 cuckoo-tools.d.ts 失败:', resolveToolSpec());
  }

  // C4：DSH 插件注册的提示词段（与工具 section 合并，但有独立预算）
  let dshSections = '';
  try {
    const secs = getDshPromptSections();
    if (secs.length > 0) dshSections = secs.map((s) => s.text).join('\n\n');
  } catch (_) { /* ignore */ }
  const toolSections = toolRegistry.getFormattedPromptSections();

  // 后台异步连接已启用的 MCP server，不阻塞初始化（按当前项目）
  mcpClient.connectEnabledServers(selectedDir).catch((err: any) => {
    console.error('[MCP] 初始化时连接失败:', err.message);
  });

  const mcpSection = buildMcpSection(selectedDir);
  const platformInfo = buildPlatformInfo();
  const intro = readProjectIntro(selectedDir);

  // 已安装插件贡献的扫描根。
  // 由本层居中传递：scanner 不 import plugins，plugins 不 import scanner，两边无依赖环。
  let pluginRoots: PluginScanRoots = { skillDirs: [], agentDirs: [], ruleDirs: [], mcpFiles: [] };
  try {
    pluginRoots = getPluginScanRoots();
  } catch (err: any) {
    console.warn('[Cuckoo Code] 读取插件扫描根失败:', err && err.message ? err.message : String(err));
  }

  // 扫描只做一次，降级时只换渲染方式，避免重复 IO。
  const skills = filterProjectScoped(scanSkills(selectedDir, pluginRoots.skillDirs), selectedDir);
  // D-004：agents 数据层（scanAgents）已做信任门，这里再包一层过滤，与 skills/rules 对齐。
  const agents = filterProjectScoped(scanAgents(selectedDir, pluginRoots.agentDirs), selectedDir);
  // 无 paths 的规则：始终注入（「## 项目规则」章节）
  const rules = getUnscopedRules(filterProjectScoped(scanRules(selectedDir, pluginRoots.ruleDirs), selectedDir));
  // 用户记忆（跨项目）：让模型了解用户习惯
  let memorySection = '';
  try { memorySection = buildMemorySection(); } catch (err: any) {
    console.warn('[Cuckoo Code] 读取用户记忆失败:', err && err.message ? err.message : String(err));
  }

  /** 按降级级别渲染可裁剪章节：0=原样，1=压缩，2=最小，3=仅指针 */
  const renderSections = (mode: number): Record<string, string> => {
    let introSection = '';
    if (intro.content) {
      if (mode === 0) {
        introSection = '---\n## 项目介绍\n' + clipSection(intro.content, MAX_PROJECT_INTRO_CHARS, '需要全文请 read ' + intro.path);
      } else if (mode === 1) {
        introSection = '---\n## 项目介绍\n' + clipSection(intro.content, MAX_PROJECT_INTRO_COMPACT, '需要全文请 read ' + intro.path);
      } else {
        introSection = '---\n## 项目介绍\n（内容过长已省略，需要时 read ' + intro.path + '）';
      }
    }

    let rulesSection = '';
    if (rules.length > 0) {
      const full = buildUnscopedRulesSection(rules);
      if (mode === 0 && full.length <= MAX_RULES_SECTION_CHARS) {
        rulesSection = full;
      } else if (mode <= 2) {
        rulesSection = clipSection(
          buildUnscopedRulesSection(rules, { indexOnly: true }),
          MAX_RULES_SECTION_CHARS,
          '规则索引已截断，请直接 read 规则目录'
        );
      } else {
        rulesSection = '## 项目规则\n\n（规则正文过长已省略，执行前请 read 对应规则文件）\n';
      }
    }

    let skillsSection = '';
    if (skills.length === 0) {
      skillsSection = buildSkillsSection(skills);
    } else {
      const full = buildSkillsSection(skills);
      if (mode === 0 && full.length <= MAX_SKILLS_SECTION_CHARS) {
        skillsSection = full;
      } else if (mode === 1) {
        const compact = buildSkillsSection(skills, { maxDesc: 120 });
        skillsSection = compact.length <= MAX_SKILLS_SECTION_CHARS
          ? compact
          : clipSection(buildSkillsSection(skills, { namesOnly: true }), MAX_SKILLS_SECTION_CHARS, '技能清单已截断，请直接 read 技能目录');
      } else if (mode <= 2) {
        skillsSection = clipSection(buildSkillsSection(skills, { namesOnly: true }), MAX_SKILLS_SECTION_CHARS, '技能清单已截断，请直接 read 技能目录');
      } else {
        skillsSection = '## 可用技能（Skills）\n\n（技能清单过长已省略，需要时 read 技能目录下的 SKILL.md）\n';
      }
    }

    let agentsSection = '';
    if (agents.length > 0) {
      const full = buildAgentsSection(agents);
      if (mode === 0 && full.length <= MAX_AGENTS_SECTION_CHARS) {
        agentsSection = full;
      } else if (mode <= 2) {
        agentsSection = clipSection(buildAgentsSection(agents, { namesOnly: true }), MAX_AGENTS_SECTION_CHARS, '子代理清单已截断');
      } else {
        agentsSection = '## 可用子代理（Agents）\n\n（清单过长已省略，用 runAgent 时按名称调用）\n';
      }
    }

    const memoryLimit = mode === 0 ? MAX_MEMORY_SECTION_CHARS : mode === 1 ? 1500 : mode === 2 ? 800 : 0;
    const memoryOut = memorySection && memoryLimit > 0
      ? clipSection(memorySection, memoryLimit, '记忆已截断')
      : '';

    const dshLimit = mode === 0 ? MAX_DSH_SECTION_CHARS : mode === 1 ? 1500 : mode === 2 ? 800 : 0;
    const dshOut = dshSections && dshLimit > 0
      ? clipSection(dshSections, dshLimit, '插件提示段已截断，需要细节请查看插件文档')
      : '';
    const promptSections = dshOut ? (toolSections + '\n\n' + dshOut) : toolSections;

    return {
      '{{TOOL_API_TYPES}}': toolApiTypes,
      '{{TOOL_SECTIONS}}': promptSections,
      '{{PLATFORM_INFO}}': platformInfo,
      '{{PROJECT_DIR}}': selectedDir,
      '{{PROJECT_INTRO_SECTION}}': introSection,
      '{{MCP_SECTION}}': mcpSection,
      '{{SKILLS_SECTION}}': skillsSection,
      '{{AGENTS_SECTION}}': agentsSection,
      '{{PROJECT_RULES_SECTION}}': rulesSection,
      '{{MEMORY_SECTION}}': memoryOut,
    };
  };

  let combined = '';
  for (let mode = 0; mode <= 3; mode++) {
    const placeholders = renderSections(mode);
    combined = tpl.content;
    for (const [key, value] of Object.entries(placeholders)) {
      combined = combined.split(key).join(value);
    }
    if (isCompaction) combined += '\n\n---\n\n请继续你之前的工作';
    if (combined.length <= MAX_PROMPT_CHARS) {
      if (mode > 0) {
        console.warn('[Cuckoo Code] 提示词超出 ' + MAX_PROMPT_CHARS + ' 字符预算，已降级到模式 ' + mode + '（' + combined.length + ' 字符）');
      }
      break;
    }
  }
  if (combined.length > MAX_PROMPT_CHARS) {
    // 工具契约属于核心功能，绝不裁剪；到这里说明固定段本身超预算，交给上层日志暴露。
    console.error('[Cuckoo Code] 提示词在最小模式下仍超出预算:', combined.length, '字符');
  }
  return { prompt: combined };
}

export { PROMPT_DIR, loadTemplate, buildPrompt };
