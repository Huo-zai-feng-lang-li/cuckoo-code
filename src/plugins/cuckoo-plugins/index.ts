/**
 * Cuckoo 插件（DSH 兼容）主进程集成：
 *   installAndLoad(pkgName)  —— npm 下载 + 加载 + 注册工具
 *   loadEnabledPlugins()     —— 启动时加载所有已启用插件
 *
 * 依赖方向：本模块在 plugins 层（纯 node + esbuild + 工具注册表）。
 */
import fs from 'node:fs';
import { Tool } from '../../tools/core/Tool.js';
import { installCuckooPlugin } from './installer.js';
import { loadCuckooPlugin } from './loader.js';
import type { CuckooHost } from './loader.js';
import { listCuckooPluginDirs, getCuckooPluginDir, isValidPluginId } from './paths.js';
import { isCuckooPluginEnabled, setCuckooPluginEnabled, clearCuckooPluginState } from './state.js';

/**
 * 从 JSON Schema 生成 JS 调用签名（供提示词），展开嵌套结构——
 * 如 todo_write(todos: {content: string, status: 'pending'|'in_progress'|'completed'}[])
 * AI 看签名就懂参数结构，减少误传。
 */
function typeOf(spec: any, depth: number): string {
  if (!spec || typeof spec !== 'object' || depth > 3) return 'any';
  const t = spec.type;
  if (Array.isArray(spec.enum)) {
    return spec.enum.map((v: any) => JSON.stringify(v)).join('|');
  }
  if (t === 'array') {
    const inner = spec.items ? typeOf(spec.items, depth + 1) : 'any';
    // 对象数组用 (…)[]，简单类型用 string[] 更简洁
    return /[{}()|]/.test(inner) ? '(' + inner + ')[]' : inner + '[]';
  }
  if (t === 'object') {
    const props = spec.properties || {};
    const req: string[] = spec.required || [];
    const inner = Object.keys(props).map((k) => k + (req.includes(k) ? '' : '?') + ': ' + typeOf(props[k], depth + 1));
    return '{' + inner.join(', ') + '}';
  }
  if (t === 'integer') return 'number';
  return t || 'any';
}

/** 生成 JS 调用签名，如 greet(name: string, age?: number) */
function buildJsApi(name: string, parameters: any): string {
  const props = (parameters && parameters.properties) || {};
  const required: string[] = (parameters && parameters.required) || [];
  const parts = Object.keys(props).map((k) => {
    const opt = required.includes(k) ? '' : '?';
    return k + opt + ': ' + typeOf(props[k], 0);
  });
  return name + '(' + parts.join(', ') + ')';
}

/** 把 DSH 插件工具（{name,description,parameters,execute}）包成 Cuckoo Tool */
class DshPluginTool extends Tool {
  private _exec: (args: any) => Promise<any>;
  constructor(def: any) {
    super(def.name, def.description, def.parameters, buildJsApi(def.name, def.parameters));
    this._exec = def.execute;
    this.dynamic = true; // 运行时工具：沙箱注入 + 提示词由运行期生成
  }
  async execute(params: any): Promise<any> {
    // Cuckoo 工具约定：返回 { success, data }
    const out = await this._exec(params);
    return { success: true, data: typeof out === 'string' ? out : JSON.stringify(out) };
  }
  getPromptSection() {
    return { name: 'tool:' + this.name, order: 200, text: '使用 ' + this.jsApi + ' 工具：' + this.description };
  }
}

/** 已加载的插件工具名（供沙箱注入用） */
const loadedPluginTools = new Set<string>();

/** 已加载插件的句柄表：插件目录 → 句柄（卸载/热重载用） */
const loadedHandles = new Map<string, { handle: any; toolNames: string[] }>();

/** 从插件目录加载并注册工具到 registry */
async function loadPluginFromDir(dir: string, registry: any, host?: CuckooHost): Promise<{ pluginName: string; tools: string[] }> {
  // 幂等：同目录重复加载 → 先卸旧的，避免工具/事件重复
  if (loadedHandles.has(dir)) await unloadPluginFromDir(dir, registry);

  const loaded = await loadCuckooPlugin(dir, host);
  const names: string[] = [];
  for (const def of loaded.tools) {
    if (!def || typeof def.name !== 'string') continue;
    registry.register(new DshPluginTool(def));
    loadedPluginTools.add(def.name);
    names.push(def.name);
  }
  loadedHandles.set(dir, { handle: loaded, toolNames: names });
  return { pluginName: loaded.pluginName, tools: names };
}

/** 卸载：反注册工具 + 摘事件总线 + 跑插件清理 */
async function unloadPluginFromDir(dir: string, registry: any): Promise<{ removedTools: string[] }> {
  const rec = loadedHandles.get(dir);
  if (!rec) return { removedTools: [] };
  loadedHandles.delete(dir);
  // 1) 反注册工具
  let removed: string[] = [];
  if (registry && typeof registry.unregisterMany === 'function') {
    removed = registry.unregisterMany(rec.toolNames);
  } else if (registry && typeof registry.unregister === 'function') {
    for (const n of rec.toolNames) { if (registry.unregister(n)) removed.push(n); }
  }
  for (const n of removed) loadedPluginTools.delete(n);
  // 2) 句柄清理（事件总线 + 插件 dispose）
  try { rec.handle.dispose(); } catch (_) { /* ignore */ }
  return { removedTools: removed };
}

/** 某目录是否已加载 */
function isPluginLoaded(dir: string): boolean {
  return loadedHandles.has(dir);
}

/** 安装（npm 下载）+ 加载 + 注册 */
async function installAndLoad(pkgName: string, registry: any, host?: CuckooHost): Promise<{ id: string; pluginName: string; tools: string[]; state: string; note: string; npmSource: string }> {
  const inst = await installCuckooPlugin(pkgName);
  let pluginName = inst.id;
  let tools: string[] = [];
  let loadErr = '';
  try {
    const r = await loadPluginFromDir(inst.dir, registry, host);
    pluginName = r.pluginName;
    tools = r.tools;
  } catch (err: any) {
    loadErr = (err && err.message) ? err.message : String(err);
  }
  setCuckooPluginEnabled(inst.id, true);
  // 加载失败 → 覆盖状态判定为 broken，把原因带回 UI
  const state = loadErr ? 'broken' : inst.state;
  const note = loadErr ? ('已下载但加载失败: ' + loadErr) : inst.note;
  return { id: inst.id, pluginName, tools, state, note, npmSource: inst.npmSource };
}

/** 启动时加载所有"已启用"的插件 */
async function loadEnabledPlugins(registry: any, host?: CuckooHost): Promise<{ loaded: string[]; failed: { id: string; error: string }[] }> {
  const loaded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const dir of listCuckooPluginDirs()) {
    const id = dir.split(/[\\/]/).pop() || '';
    if (!isValidPluginId(id) || !isCuckooPluginEnabled(id)) continue;
    try {
      const r = await loadPluginFromDir(dir, registry, host);
      loaded.push(id + '(' + r.pluginName + '):' + r.tools.join(','));
    } catch (err: any) {
      failed.push({ id, error: err && err.message ? err.message : String(err) });
    }
  }
  return { loaded, failed };
}

/**
 * 卸载插件（真卸载：反注册工具 + 摘事件总线 + 清状态 + 删目录）
 * @param id 插件 id
 * @param registry 工具注册表
 * @param opts.deleteFiles 是否删除插件目录（默认 true）
 */
async function uninstallCuckooPlugin(id: string, registry?: any, opts?: { deleteFiles?: boolean }): Promise<boolean> {
  const dir = getCuckooPluginDir(id);
  try { await unloadPluginFromDir(dir, registry); } catch (_) { /* ignore */ }
  clearCuckooPluginState(id);
  if (!opts || opts.deleteFiles !== false) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  return true;
}

export {
  installAndLoad,
  loadEnabledPlugins,
  loadPluginFromDir,
  unloadPluginFromDir,
  isPluginLoaded,
  uninstallCuckooPlugin,
  loadedPluginTools,
  DshPluginTool,
};
