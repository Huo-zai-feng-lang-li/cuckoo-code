/**
 * IPC：项目初始化
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as windowState from '../window.js';
import * as mcpClient from '../../mcp/client.js';
import { initProject } from '../../session/project-context.js';
import { scanSkills, getUserSkillsDir, getProjectSkillsDir } from '../../skills/index.js';
import { buildSkillsSection } from '../../skills/prompt.js';
import { checkDeletableSkillDir } from '../../skills/delete-guard.js';
import { scanAgents } from '../../agents/index.js';
import { buildAgentsSection } from '../../agents/prompt.js';
import { getPluginScanRoots } from '../../plugins/roots.js';
import { parseFrontmatter } from '../../skills/frontmatter.js';
import { isWorkspaceTrusted } from '../../infra/workspace-trust.js';
import { isApiTransportProvider } from '../../api-transport/provider.js';
import { getActiveApiSessionId, setApiSessionProjectDir } from '../../api-transport/session-store.js';

const require = createRequire(import.meta.url);
const { ipcMain, shell } = require('electron');

/** 消费侧过滤（D-004）：未信任项目剔除 source==='project' 的技能/代理 */
function filterProjectScoped<T extends { source?: string }>(items: T[], projectDir: string | null): T[] {
  if (!projectDir || isWorkspaceTrusted(projectDir)) return items;
  return items.filter((it) => !(it && it.source === 'project'));
}

function registerProjectIpc(): void {
  /**
   * 当前窗口允许操作的技能根目录。
   * 只认用户级 + 已信任的项目级：未信任项目里的技能连扫描都被过滤，更不能被删。
   */
  function skillRootsOfEvent(event: any): string[] {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const projectDir = store ? store.state.selectedProjectDir : null;
    const roots = [getUserSkillsDir()];
    if (projectDir && isWorkspaceTrusted(projectDir)) roots.push(getProjectSkillsDir(projectDir));
    return roots;
  }

  // 初始化项目
  ipcMain.handle('init-project', async (event: any, { skipPrompt = false, projectDir = null, isCompaction = false, extraPrompt = '', noDialog = false, parentSessionId = null }: any = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const windowId = ctx && ctx.win ? ctx.win.id : null;
    // API 模式没有网页输入框：允许选项目目录，但永远不向占位页注入 initial-prompt。
    const apiMode = !!(ctx && isApiTransportProvider(ctx.providerId));
    const result = await initProject(apiMode ? true : skipPrompt, ctx, projectDir, isCompaction, extraPrompt || '', !!noDialog, parentSessionId);
    // API 会话要记住这次选择的目录，下次进入窗口/切换会话时恢复
    if (apiMode && result && result.success && ctx && ctx.profileId) {
      const dir = ctx.sessionStore && ctx.sessionStore.state ? ctx.sessionStore.state.selectedProjectDir : null;
      if (dir) setApiSessionProjectDir(ctx.profileId, getActiveApiSessionId(ctx.profileId), dir);
    }
    // 项目目录可能变化：释放该窗口对"旧项目"的 MCP 连接引用
    if (windowId !== null) {
      try {
        const newDir = (ctx && ctx.sessionStore && ctx.sessionStore.state.selectedProjectDir) || null;
        mcpClient.releaseProject(windowId, newDir);
      } catch (_) {}
    }
    return result;
  });

  // 列出所有技能（结构化，供壳页面「技能」页展示）
  ipcMain.handle('list-skills', async (event: any) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const projectDir = store ? store.state.selectedProjectDir : null;
      const skills = filterProjectScoped(scanSkills(projectDir || null, getPluginScanRoots().skillDirs), projectDir || null);
      return {
        success: true,
        skills: skills.map((s: any) => ({
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse || '',
          source: s.source,
          skillPath: s.skillPath,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 列出所有子代理（结构化，供壳页面「子代理」页展示）
  ipcMain.handle('list-agents', async (event: any) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const projectDir = store ? store.state.selectedProjectDir : null;
      const agents = scanAgents(projectDir || null);
      return {
        success: true,
        agents: agents.map((a: any) => ({
          name: a.name,
          description: a.description,
          source: a.source,
          agentPath: a.agentPath,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 新建子代理文件（生成模板 + 用系统默认程序打开编辑）
  ipcMain.handle('create-agent-file', async (event: any, { name, scope }: any) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const projectDir = store ? store.state.selectedProjectDir : null;

      let baseDir: string;
      if (scope === 'project') {
        if (!projectDir) return { success: false, error: '请先选择项目目录' };
        baseDir = projectDir;
      } else {
        baseDir = os.homedir();
      }

      const agentsDir = path.join(baseDir, '.cuckoo', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });

      const safeName = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-') || 'my-agent';
      const filePath = path.join(agentsDir, safeName + '.md');
      if (fs.existsSync(filePath)) return { success: false, error: '同名子代理已存在：' + safeName };

      const tpl = [
        '---',
        'name: ' + safeName,
        'description: （一句话说明何时委派给这个子代理）',
        '---',
        '',
        '（这里是子代理的系统提示词：写清它的职责、执行方式、输出要求。）',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, tpl, 'utf-8');

      // 用系统默认程序打开（编辑器/预览）
      await shell.openPath(filePath);
      return { success: true, path: filePath, name: safeName };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 安全校验：只允许操作 .cuckoo/agents/ 下的 .md 文件
  function isAgentFile(p: any): boolean {
    if (typeof p !== 'string' || !p) return false;
    const norm = p.replace(/\\/g, '/').toLowerCase();
    return norm.includes('/.cuckoo/agents/') && norm.endsWith('.md');
  }

  // 重命名子代理：改名（重命名文件 + 更新 frontmatter 的 name 字段）
  ipcMain.handle('rename-agent', async (_event: any, { agentPath, newName }: any) => {
    try {
      if (!isAgentFile(agentPath)) return { success: false, error: '非法路径' };
      if (!fs.existsSync(agentPath)) return { success: false, error: '文件不存在' };
      const safe = String(newName || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
      if (!safe) return { success: false, error: '名称不能为空' };
      const dir = path.dirname(agentPath);
      const newPath = path.join(dir, safe + '.md');
      if (newPath === agentPath) return { success: true, path: agentPath };
      if (fs.existsSync(newPath)) return { success: false, error: '同名子代理已存在：' + safe };

      // 更新内容里的 frontmatter name 字段
      let content = fs.readFileSync(agentPath, 'utf-8');
      const { data, body } = parseFrontmatter(content);
      if (Object.keys(data).length > 0) {
        // 有 frontmatter：重写 name
        const fmLines = ['---'];
        const keys = Object.keys(data);
        if (!keys.includes('name')) keys.unshift('name');
        for (const k of keys) {
          fmLines.push(k + ': ' + (k === 'name' ? safe : data[k]));
        }
        fmLines.push('---');
        content = fmLines.join('\n') + '\n' + body;
      } else {
        // 无 frontmatter：补一个
        content = '---\nname: ' + safe + '\n---\n\n' + content;
      }
      fs.writeFileSync(newPath, content, 'utf-8');
      fs.unlinkSync(agentPath);
      return { success: true, path: newPath, name: safe };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 用系统默认程序打开子代理文件（供「编辑」按钮）
  ipcMain.handle('open-agent-file', async (_event: any, { agentPath }: any) => {
    try {
      if (!isAgentFile(agentPath)) return { success: false, error: '非法路径' };
      if (!fs.existsSync(agentPath)) return { success: false, error: '文件不存在' };
      await shell.openPath(agentPath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 删除子代理文件（供「删除」按钮）
  ipcMain.handle('delete-agent-file', async (_event: any, { agentPath }: any) => {
    try {
      if (!isAgentFile(agentPath)) return { success: false, error: '非法路径' };
      if (!fs.existsSync(agentPath)) return { success: false, error: '文件不存在' };
      fs.unlinkSync(agentPath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 删除技能目录（进系统回收站，可恢复）。
  // 只允许删用户级/项目级扫描根的直接子目录；插件自带的技能请走插件卸载。
  ipcMain.handle('delete-skill-dir', async (event: any, { skillPath }: any) => {
    try {
      const roots = skillRootsOfEvent(event);
      const check = checkDeletableSkillDir(skillPath, roots);
      if (!check.ok || !check.dir) {
        const pluginDirs = getPluginScanRoots().skillDirs || [];
        const inPlugin = pluginDirs.some((d) => checkDeletableSkillDir(skillPath, [d]).ok);
        return { success: false, error: inPlugin ? '插件自带技能，请在插件页卸载对应插件' : (check.error || '路径不合法') };
      }
      try {
        await shell.trashItem(check.dir);
      } catch (err: any) {
        // Linux 等没有回收站的环境会失败：明确报错，绝不退化成 rm -rf
        return { success: false, error: '移入回收站失败：' + (err && err.message ? err.message : String(err)) };
      }
      return { success: true, dir: check.dir };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 打开技能目录（交给系统文件管理器，用户在那边自行管理）
  // 只读操作，额外放行插件技能目录（删不了但能看）
  ipcMain.handle('open-skill-dir', async (event: any, { skillPath }: any) => {
    try {
      const roots = skillRootsOfEvent(event).concat(getPluginScanRoots().skillDirs || []);
      const check = checkDeletableSkillDir(skillPath, roots);
      if (!check.ok || !check.dir) return { success: false, error: check.error || '路径不合法' };
      const err = await shell.openPath(check.dir);
      return err ? { success: false, error: err } : { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 重新扫描技能 + 代理，返回合并清单文本（供「刷新技能与代理」按钮使用）
  ipcMain.handle('refresh-skills', async (event: any) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const projectDir = store ? store.state.selectedProjectDir : null;
      const skills = filterProjectScoped(scanSkills(projectDir || null, getPluginScanRoots().skillDirs), projectDir || null);
      const agents = scanAgents(projectDir || null, getPluginScanRoots().agentDirs);
      // 合并：技能章节 + 代理章节（各自无内容时返回空串）
      const sections = [buildSkillsSection(skills), buildAgentsSection(agents)].filter((s) => s && s.trim());
      const section = sections.join('\n');
      return { success: true, section, skillCount: skills.length, agentCount: agents.length };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}

export { registerProjectIpc };
