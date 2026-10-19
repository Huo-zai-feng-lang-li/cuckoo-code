/**
 * 项目文件树页：只读浏览当前项目目录（整树加载，忽略 node_modules/.git 等）。
 * 支持按文件名/路径关键词搜索（前端过滤，扁平显示匹配项）。
 */
import { api, escapeHtml, escapeAttr, ckPrompt, ckConfirm, ckAlert } from '../shared.js';

interface TreeNode { name: string; path: string; type: 'dir' | 'file'; children?: TreeNode[] }

/** 目录折叠状态 */
const expanded = new Set<string>();
/** 已加载的树缓存（供搜索用，避免重复 IPC） */
let cachedTree: TreeNode[] = [];
let cachedTruncated = false;

// VSCode 风格图标（内联 SVG）
const CARET_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

// 行操作图标（hover 显示）
const IC_NEW_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/><path d="M12 13v5M9.5 15.5h5"/></svg>';
const IC_NEW_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v5M9.5 12.5h5"/></svg>';
const IC_RENAME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const IC_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

/** 转义后的关键词高亮（<mark>） */
function highlight(text: string, kw: string): string {
  const esc = escapeHtml(text);
  if (!kw) return esc;
  const escKw = escapeHtml(kw).replace(/[.*+?^$^{}()|[\]\\]/g, '\\$&');
  try {
    return esc.replace(new RegExp('(' + escKw + ')', 'gi'), '<mark class="ck-ft-hl">$1</mark>');
  } catch (_) {
    return esc;
  }
}

/** 扩展名 → 颜色类名后缀（VSCode 风格语义色） */
const EXT_COLOR: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json', json5: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  py: 'py', pyw: 'py',
  java: 'java', kt: 'java', kts: 'java',
  go: 'go',
  rs: 'rs',
  rb: 'rb',
  php: 'php',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cxx: 'c',
  cs: 'cs',
  sh: 'sh', bash: 'sh', zsh: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh',
  yml: 'yml', yaml: 'yml', toml: 'yml', ini: 'yml', conf: 'yml', env: 'yml',
  xml: 'xml', svg: 'xml',
  sql: 'sql',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', bmp: 'img', ico: 'img', avif: 'img',
  mp4: 'img', mp3: 'img', wav: 'img', mov: 'img', webm: 'img',
  txt: 'txt', log: 'txt', text: 'txt',
  lock: 'lock',
};

/** 扩展名 → 角标文字（圆角小方块 + 语言缩写，VSCode Seti 风） */
const EXT_BADGE: Record<string, string> = {
  ts: 'TS', tsx: 'TS', mts: 'TS', cts: 'TS',
  js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS',
  json: '{}', json5: '{}',
  md: 'MD', markdown: 'MD', mdx: 'MD',
  css: 'CSS', scss: 'CSS', less: 'CSS', sass: 'CSS',
  html: '<>', htm: '<>', vue: 'VUE', svelte: 'SVE',
  py: 'PY', pyw: 'PY',
  java: 'JV', kt: 'KT', kts: 'KT',
  go: 'GO', rs: 'RS', rb: 'RB', php: 'PHP',
  c: 'C', h: 'H', cc: 'C+', cpp: 'C+', hpp: 'C+', cxx: 'C+',
  cs: 'C#',
  sh: '>_', bash: '>_', zsh: '>_', bat: '>_', cmd: '>_', ps1: '>_',
  yml: 'YML', yaml: 'YML', toml: 'TML', ini: 'INI', conf: 'CFG', env: 'ENV',
  xml: 'XML', svg: 'SVG', sql: 'SQL',
  txt: 'TXT', log: 'LOG', text: 'TXT', lock: 'LCK',
};

/** 媒体类扩展名（用图形图标） */
const MEDIA_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'mp4', 'mp3', 'wav', 'mov', 'webm']);
const IMG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

/** 取扩展名（小写） */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 图标 HTML：目录=文件夹；媒体=图片图形；已知类型=圆角角标；其余=通用文件 */
function iconHtml(name: string, type: 'dir' | 'file'): string {
  if (type === 'dir') return '<span class="ck-ft-icon ck-ft-i-dir">' + FOLDER_SVG + '</span>';
  const ext = extOf(name);
  if (MEDIA_EXTS.has(ext)) return '<span class="ck-ft-icon ck-ft-i-media">' + IMG_SVG + '</span>';
  const badge = EXT_BADGE[ext];
  if (badge) return '<span class="ck-ft-icon ck-ft-badge ' + colorClass(name, 'file') + '">' + badge + '</span>';
  return '<span class="ck-ft-icon ck-ft-i-file">' + FILE_SVG + '</span>';
}

/** 类型色类（文件名 + 角标共用） */
function colorClass(name: string, type: 'dir' | 'file'): string {
  if (type === 'dir') return '';
  const ext = extOf(name);
  return EXT_COLOR[ext] ? 'ck-ft-c-' + EXT_COLOR[ext] : 'ck-ft-c-file';
}

/** 文件名颜色类（沿用原映射，颜色加到文件名上） */
function nameClass(name: string, type: 'dir' | 'file'): string {
  return type === 'dir' ? 'ck-ft-name' : 'ck-ft-name ' + colorClass(name, type);
}

/** @ 按钮 HTML */
function atBtn(path: string): string {
  return '<span class="ck-ft-at" data-at="' + escapeAttr(path) + '">@</span>';
}

/** 行操作按钮 HTML */
function actBtn(act: string, path: string, name: string, isDir: boolean, svg: string): string {
  return '<span class="ck-ft-act" data-act="' + act + '" data-path="' + escapeAttr(path) +
    '" data-name="' + escapeAttr(name) + '" data-isdir="' + (isDir ? '1' : '0') +
    '">' + svg + '</span>';
}

/** 行操作图标组（hover 显示）：目录=新建文件/新建文件夹/重命名/删除；文件=重命名/删除 */
function actionsHtml(path: string, type: 'dir' | 'file'): string {
  const name = path.split('/').pop() || '';
  const isDir = type === 'dir';
  let h = '';
  if (isDir) {
    h += actBtn('new-file', path, name, true, IC_NEW_FILE);
    h += actBtn('new-folder', path, name, true, IC_NEW_FOLDER);
  }
  h += actBtn('rename', path, name, isDir, IC_RENAME);
  h += actBtn('delete', path, name, isDir, IC_DEL);
  return '<span class="ck-ft-actions">' + h + '</span>';
}

function renderNodes(nodes: TreeNode[], depth: number): string {
  let html = '';
  for (const n of nodes) {
    const pad = 6 + depth * 14;
    if (n.type === 'dir') {
      const open = expanded.has(n.path);
      html += '<div class="ck-ft-row ck-ft-dir' + (open ? ' open' : '') + '" data-path="' + escapeAttr(n.path) + '" style="padding-left:' + pad + 'px">' +
        '<span class="ck-ft-caret">' + CARET_SVG + '</span>' +
        iconHtml(n.name, 'dir') +
        '<span class="' + nameClass(n.name, 'dir') + '">' + escapeHtml(n.name) + '</span>' +
        actionsHtml(n.path, 'dir') +
        atBtn(n.path) +
      '</div>';
      if (open && n.children) html += renderNodes(n.children, depth + 1);
    } else {
      html += '<div class="ck-ft-row ck-ft-file" data-path="' + escapeAttr(n.path) + '" title="' + escapeAttr(n.path) + '" style="padding-left:' + pad + 'px">' +
        '<span class="ck-ft-caret"></span>' +
        iconHtml(n.name, 'file') +
        '<span class="' + nameClass(n.name, 'file') + '">' + escapeHtml(n.name) + '</span>' +
        actionsHtml(n.path, 'file') +
        atBtn(n.path) +
      '</div>';
    }
  }
  return html;
}

/** 扁平化（含所有节点） */
function flatten(nodes: TreeNode[], out: TreeNode[]): TreeNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

/** 渲染搜索结果（扁平列表：图标 + 名称（高亮）+ 路径） */
function renderSearch(kw: string): string {
  const all = flatten(cachedTree, []);
  const low = kw.toLowerCase();
  const matched = all.filter((n) => n.path.toLowerCase().includes(low));
  if (matched.length === 0) return '<div class="ck-list-empty">无匹配结果</div>';
  // 文件优先，其次目录；再按路径排序
  matched.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return matched.slice(0, 500).map((n) => {
    const cls = n.type === 'dir' ? 'ck-ft-dir' : 'ck-ft-file';
    return '<div class="ck-ft-row ' + cls + '" data-path="' + escapeAttr(n.path) + '" title="' + escapeAttr(n.path) + '">' +
      iconHtml(n.name, n.type) +
      '<span class="' + nameClass(n.name, n.type) + '">' + highlight(n.name, kw) + '</span>' +
      '<span class="ck-ft-path">' + highlight(n.path, kw) + '</span>' +
      actionsHtml(n.path, n.type) +
      atBtn(n.path) +
    '</div>';
  }).join('') + (matched.length > 500 ? '<div class="ck-ft-truncated">（结果过多，仅显示前 500 项）</div>' : '');
}

/** 处理行操作图标点击 */
function onActClick(el: any, e: any): void {
  e.stopPropagation();
  const act = el.dataset.act;
  const p = el.dataset.path;
  const name = el.dataset.name;
  const isDir = el.dataset.isdir === '1';
  if (!act || !p) return;
  if (act === 'new-file') doCreate(p, false);
  else if (act === 'new-folder') doCreate(p, true);
  else if (act === 'rename') doRename(p, name);
  else if (act === 'delete') doDelete(p, name, isDir);
}

/** 绑定行事件：**事件委托**（只绑一次）。
 *  原来每行逐个 addEventListener，大项目（上限 5000 节点）展开后单次渲染上万监听器，
 *  折叠/搜索每次都重建 → GC 压力。改为在容器上绑一次，按 closest 分派。 */
function bindRowEvents(listEl: HTMLElement): void {
  if ((listEl as any).__ckDelegated) return;
  (listEl as any).__ckDelegated = true;
  listEl.addEventListener('click', async (e: any) => {
    const t = e.target;
    if (!t || !t.closest) return;
    // 优先级：@ 追加 → 操作图标 → 目录 → 文件（前者是后者的子元素，先命中先返回）
    const atEl = t.closest('.ck-ft-at');
    if (atEl) {
      e.stopPropagation();
      const p = atEl.dataset.at;
      if (p && api.appendSnippet) { try { await api.appendSnippet('@' + p); } catch (_) { /* ignore */ } }
      return;
    }
    const actEl = t.closest('.ck-ft-act');
    if (actEl) { onActClick(actEl, e); return; }
    const dirEl = t.closest('.ck-ft-dir');
    if (dirEl) {
      const p = dirEl.dataset.path;
      if (p) {
        if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
        // 只变了展开状态 → 复用缓存重渲染，不重新拉 IPC
        const listEl = document.getElementById('ft-list');
        if (listEl) renderList(listEl);
      }
      return;
    }
    // 点击文件行 → 打开文件预览（主区域覆盖视图）
    const fileEl = t.closest('.ck-ft-file');
    if (fileEl) {
      const p = fileEl.dataset.path;
      if (p) { try { const { openPreview } = await import('../preview.js'); await openPreview(p); } catch (_) { /* ignore */ } }
    }
  });
}

function currentKeyword(): string {
  const s = document.getElementById('ft-search') as any;
  return s ? String(s.value || '').trim() : '';
}

/** 新建文件/文件夹 */
async function doCreate(parentRel: string, isDir: boolean): Promise<void> {
  const name = await ckPrompt({ title: isDir ? '新建文件夹' : '新建文件', placeholder: '输入名称', value: '' });
  if (!name) return;
  const r = await (api as any).createProjectEntry(parentRel, name, isDir);
  if (!r || !r.success) { await ckAlert('创建失败：' + ((r && r.error) || '未知错误')); return; }
  if (isDir) expanded.add(parentRel ? (parentRel + '/' + name) : name);
  await loadFiles({ force: true });
}

/** 重命名 */
async function doRename(relPath: string, oldName: string): Promise<void> {
  const newName = await ckPrompt({ title: '重命名', placeholder: '输入新名称', value: oldName });
  if (!newName || newName === oldName) return;
  const r = await (api as any).renameProjectEntry(relPath, newName);
  if (!r || !r.success) { await ckAlert('重命名失败：' + ((r && r.error) || '未知错误')); return; }
  await loadFiles({ force: true });
}

/** 删除（回收站） */
async function doDelete(relPath: string, name: string, isDir: boolean): Promise<void> {
  const ok = await ckConfirm('确定删除「' + name + '」' + (isDir ? '（及其全部内容）' : '') + '吗？\n将移入系统回收站，可从回收站恢复。', '删除确认');
  if (!ok) return;
  const r = await (api as any).deleteProjectEntry(relPath);
  if (!r || !r.success) { await ckAlert('删除失败：' + ((r && r.error) || '未知错误')); return; }
  await loadFiles({ force: true });
}

/**
 * 加载文件树。
 * @param opts.force true=强制重新拉取 IPC（刷新/增删改后）；默认 false=有缓存直接复用（切 tab 用）
 */
export async function loadFiles(opts?: { force?: boolean }): Promise<void> {
  const listEl = document.getElementById('ft-list');
  if (!listEl || !api.listProjectTree) return;
  
  const isForce = opts?.force || filesDirty;
  if (isForce) filesDirty = false;

  // 有缓存且不强制刷新 → 直接渲染，免去 IPC 往返
  if (!isForce && cachedTree.length > 0) {
    renderList(listEl);
    return;
  }
  try {
    const r = await api.listProjectTree();
    if (!r || !r.success) {
      listEl.innerHTML = '<div class="ck-list-empty">' + escapeHtml((r && r.error) || '加载失败') + '</div>';
      return;
    }
    const rootEl = document.getElementById('ft-root');
    if (rootEl && r.root) {
      const base = String(r.root).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '项目文件';
      rootEl.textContent = base;
      rootEl.title = r.root;
    }
    cachedTree = r.tree || [];
    cachedTruncated = !!r.truncated;
    renderList(listEl);
  } catch (_) {
    listEl.innerHTML = '<div class="ck-list-empty">加载失败</div>';
  }
}

/** 按当前关键词渲染（无词 → 树；有词 → 扁平搜索结果）
 *  大项目（节点多）时先插入占位，rAF 再真正渲染，避免一次性重建数千 DOM 阻塞主线程。 */
function renderList(listEl: HTMLElement): void {
  bindRowEvents(listEl);
  const kw = currentKeyword();
  if (kw) {
    listEl.innerHTML = renderSearch(kw);
    return;
  }
  if (cachedTree.length === 0) {
    listEl.innerHTML = '<div class="ck-list-empty">空目录</div>';
    return;
  }
  // 节点数估算：扁平化计数，超过 300 走分帧
  const total = countNodes(cachedTree, 0, 301);
  const paint = () => {
    listEl.innerHTML = renderNodes(cachedTree, 0) +
      (cachedTruncated ? '<div class="ck-ft-truncated">（节点过多，已截断显示）</div>' : '');
  };
  if (total <= 300) { paint(); return; }
  listEl.innerHTML = '<div class="ck-list-empty">加载中…</div>';
  requestAnimationFrame(paint);
}

/** 统计节点数（提前退出，避免大项目全量遍历） */
function countNodes(nodes: TreeNode[], n: number, limit: number): number {
  for (const node of nodes) {
    if (++n >= limit) return n;
    if (node.children && node.children.length) {
      n = countNodes(node.children, n, limit);
      if (n >= limit) return n;
    }
  }
  return n;
}

document.getElementById('ft-refresh')?.addEventListener('click', () => loadFiles({ force: true }));
// 全部折叠：清空展开状态后重渲染
document.getElementById('ft-collapse-all')?.addEventListener('click', () => {
  expanded.clear();
  const listEl = document.getElementById('ft-list');
  if (listEl) renderList(listEl);
});
document.getElementById('ft-new-file')?.addEventListener('click', () => doCreate('', false));
document.getElementById('ft-new-folder')?.addEventListener('click', () => doCreate('', true));

// 搜索：输入防抖 → 过滤
{
  const searchEl = document.getElementById('ft-search') as any;
  if (searchEl) {
    let timer: any = null;
    searchEl.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const listEl = document.getElementById('ft-list');
        if (listEl) renderList(listEl);
      }, 150);
    });
    searchEl.addEventListener('keydown', (e: any) => {
      if (e.key === 'Escape') { searchEl.value = ''; const listEl = document.getElementById('ft-list'); if (listEl) renderList(listEl); }
    });
  }
}

// 当前项目目录变化 → 刷新
if (api.onProjectDir) {
  api.onProjectDir(() => { expanded.clear(); cachedTree = []; loadFiles({ force: true }); });
}

// 监听目录变化（复用 Git 的 watcher，外部文件变动时自动刷新）
function isFilesPanelActive(): boolean {
  const p = document.querySelector('.ck-tab[data-panel="files"]');
  return !!(p && p.classList.contains('ck-tab-active'));
}
if (api.onGitChanged) {
  api.onGitChanged(() => {
    if (isFilesPanelActive()) {
      loadFiles({ force: true });
    } else {
      filesDirty = true; // 不在当前面板，标记需要刷新，下次切回来时强刷
    }
  });
}
