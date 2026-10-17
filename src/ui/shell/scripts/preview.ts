/**
 * 「文件」页内预览区。
 *
 * 两条拖拽条各司其职：
 *  - 左条（树/内容之间）：改树宽 → 树与内容此消彼长，侧栏总宽不变（AI 不变）
 *  - 右条（侧栏右缘，现成机制）：改侧栏总宽 → 树宽不变，内容区伸缩（AI 变）
 *
 * 实现：打开预览时「树固定宽 + 预览 flex:1」；
 * 左条改树的固定宽（总宽不动），右条改侧栏总宽（现成机制，树固定故内容跟随）。
 */
import { api, escapeHtml, ckConfirm, ckAlert, ckDialog3 } from "./shared.js";
import { showInMonaco, showDiff, getEditorValue, onEditorChange } from "./preview-monaco.js";

const PREVIEW_W_KEY = "cuckoo-preview-width";
const MIN_PREVIEW_W = 180;
const MIN_TREE_W = 120;

let openedBaseWidth = 0;    // 打开预览时的侧栏基础宽（关闭时恢复）
let currentRelPath = "";
let loadedRelPath = "";     // 编辑器当前实际加载的文件（用于判断切回是否需重载）
let dirty = false;          // 当前文件是否有未保存改动
let saving = false;
let lastSelfSaveAt = 0;     // 本端保存的时间戳（忽略自己写盘触发的变更事件）
let conflictHandling = false; // 冲突弹框处理中（防重入）
let diffMode = false;        // 当前是否处于 diff 视图

/** 保存按钮 / 未保存标记 */
function updateSaveBtn(): void {
  const btn = document.getElementById("ck-preview-save");
  if (!btn) return;
  if (!currentRelPath) { btn.style.display = "none"; return; }
  btn.style.display = "";
  btn.textContent = saving ? "保存中…" : (dirty ? "保存*" : "保存");
  btn.classList.toggle("dirty", dirty);
}

/** 有未保存改动时询问是否丢弃（返回 true = 继续/丢弃） */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return await ckConfirm("当前文件有未保存的修改，确定放弃吗？", "未保存的修改");
}

/** 保存当前文件（原子写入） */
async function saveFile(): Promise<boolean> {
  if (!currentRelPath || saving) return false;
  saving = true;
  updateSaveBtn();
  try {
    const r = await (api as any).writeProjectFile(currentRelPath, getEditorValue());
    if (r && r.success) {
      lastSelfSaveAt = Date.now();
      dirty = false;
      const sizeEl = document.getElementById("ck-preview-size");
      if (sizeEl) sizeEl.textContent = fmtSize(r.size);
      updateSaveBtn();
      return true;
    }
    await ckAlert("保存失败：" + ((r && r.error) || "未知错误"), "保存失败");
    return false;
  } catch (err: any) {
    await ckAlert("保存失败：" + (err && err.message), "保存失败");
    return false;
  } finally {
    saving = false;
    updateSaveBtn();
  }
}

function pane(): HTMLElement | null { return document.getElementById("ck-preview-pane"); }
function listEl(): HTMLElement | null { return document.getElementById("ft-list"); }
function sidebarEl(): HTMLElement | null { return document.getElementById("ck-sidebar"); }
function colsEl(): HTMLElement | null { return document.querySelector(".ck-files-cols"); }

function getPreviewWidth(): number {
  try {
    const v = Number(localStorage.getItem(PREVIEW_W_KEY));
    if (Number.isFinite(v) && v >= MIN_PREVIEW_W && v <= 1600) return Math.round(v);
  } catch (_) { /* ignore */ }
  return 420;
}

/** 预览可用最大宽：保证 AI 区域至少留 300px */
function maxPreviewWidth(): number {
  const avail = window.innerWidth - baseSidebarWidth() - 300;
  return Math.max(MIN_PREVIEW_W, avail);
}
function savePreviewWidth(w: number): void {
  try { localStorage.setItem(PREVIEW_W_KEY, String(w)); } catch (_) { /* ignore */ }
}

/** 侧栏"基础宽"：用 sidebar.ts 存的稳定值（不被预览加宽污染） */
function baseSidebarWidth(): number {
  try {
    const v = Number(localStorage.getItem("cuckoo-sidebar-width"));
    // 旧默认 320：不是用户主动选的，升到新默认（须在最小宽判断之前）
    if (Number.isFinite(v) && v === 320) return 460;
    if (Number.isFinite(v) && v >= 240) return Math.round(v);
  } catch (_) { /* ignore */ }
  return 460;
}

/** 设置侧栏总宽（改 AI 区域）；clamp 到窗口的 75% 防超界 */
function setSidebarWidth(total: number): void {
  let ww = Math.round(total);
  const max = Math.round(window.innerWidth * 0.75);
  if (ww > max) ww = max;
  if (ww < 240) ww = 240;
  const sb = sidebarEl();
  if (sb && !sb.classList.contains("ck-collapsed")) sb.style.width = ww + "px";
  if (api.toggleSidebar) api.toggleSidebar(ww);
}

function fmtSize(n: any): string {
  if (typeof n !== "number") return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

async function loadFile(relPath: string): Promise<void> {
  // 同一文件且有未保存改动 → 不重读盘（保留编辑器内容，避免覆盖丢失）
  if (dirty && relPath === loadedRelPath) return;
  // 切到别的文件前：有未保存改动先询问是否丢弃
  if (dirty && relPath !== loadedRelPath) {
    if (!(await confirmDiscard())) return;
    dirty = false;
  }
  const nameEl = document.getElementById("ck-preview-name");
  const sizeEl = document.getElementById("ck-preview-size");
  const emptyEl = document.getElementById("ck-preview-empty");
  const monacoEl = document.getElementById("ck-monaco");
  if (nameEl) { nameEl.textContent = relPath; nameEl.title = relPath; }
  if (sizeEl) sizeEl.textContent = "";
  if (emptyEl) { emptyEl.style.display = "block"; emptyEl.textContent = "加载中…"; }
  if (monacoEl) monacoEl.style.display = "none";
  try {
    const r = await (api as any).readProjectFile(relPath);
    if (!r || !r.success) {
      if (emptyEl) { emptyEl.style.display = "block"; emptyEl.textContent = (r && r.error) || "读取失败"; }
      return;
    }
    if (sizeEl) sizeEl.textContent = fmtSize(r.size);
    if (monacoEl) {
      // 载入新文件：退出 diff 态，显示编辑器
      hideConflictBar();
      setDiffTreeHidden(false);
      diffMode = false;
      const diffEl = document.getElementById("ck-monaco-diff");
      if (diffEl) diffEl.style.display = "none";
      monacoEl.style.display = "block";
      if (emptyEl) emptyEl.style.display = "none";
      dirty = false;
      loadedRelPath = relPath;
      await showInMonaco(monacoEl, relPath, r.content);
      updateSaveBtn();
      updateDiffBtn();
      // 开启对该文件的变更监听（自动刷新用）
      try { if ((api as any).watchProjectFile) (api as any).watchProjectFile(relPath); } catch (_) {}
    }
  } catch (err: any) {
    if (emptyEl) { emptyEl.style.display = "block"; emptyEl.textContent = "读取失败: " + escapeHtml(err.message); }
    if (monacoEl) monacoEl.style.display = "none";
  }
}

/** 在 diff 容器里显示"磁盘外部版 vs 我的未保存编辑"，并显示决策条 */
async function showConflictDiff(relPath: string): Promise<void> {
  const editEl = document.getElementById("ck-monaco");
  const diffEl = document.getElementById("ck-monaco-diff");
  if (!editEl || !diffEl) return;
  const cur = await (api as any).readProjectFile(relPath);
  if (!cur || !cur.success) { await ckAlert("读取失败"); return; }
  diffMode = true;
  updateDiffBtn();
  setDiffTreeHidden(true);
  const emptyEl = document.getElementById("ck-preview-empty");
  if (emptyEl) emptyEl.style.display = "none";
  editEl.style.display = "none";
  diffEl.style.display = "block";
  // 左边=磁盘外部最新版，右边=我的编辑器内容（未保存编辑）
  await showDiff(diffEl, relPath, cur.content, getEditorValue());
  showConflictBar(relPath, cur.content);
}

/** 冲突决策条（diff 视图顶部）：采用外部版 / 保留我的 */
function showConflictBar(relPath: string, externalContent: string): void {
  const head = document.querySelector(".ck-preview-head");
  if (!head || !head.parentNode) return;
  const old = document.getElementById("ck-conflict-bar");
  if (old) old.remove();
  const bar = document.createElement("div");
  bar.id = "ck-conflict-bar";
  bar.className = "ck-conflict-bar";
  bar.innerHTML = '<span class="ck-cb-text">⚠ 文件已被外部修改</span>' +
    '<span class="ck-cb-actions">' +
      '<button class="ck-cb-btn ck-cb-primary" id="ck-cb-take">采用外部版</button>' +
      '<button class="ck-cb-btn" id="ck-cb-keep">保留我的</button>' +
    '</span>';
  head.parentNode.insertBefore(bar, head.nextSibling);
  const takeBtn = bar.querySelector("#ck-cb-take");
  const keepBtn = bar.querySelector("#ck-cb-keep");
  if (takeBtn) takeBtn.addEventListener("click", () => { applyExternal(externalContent); });
  if (keepBtn) keepBtn.addEventListener("click", () => {
    // 保留我的：退出 diff，编辑器内容不动（仍 dirty）
    hideConflictBar();
    exitDiffToEdit();
  });
}

function hideConflictBar(): void {
  const bar = document.getElementById("ck-conflict-bar");
  if (bar) bar.remove();
}

/** 采用外部版：把编辑器内容替换为磁盘版，清 dirty，退出 diff */
function applyExternal(content: string): void {
  hideConflictBar();
  exitDiffToEdit();
  // 用新内容刷新编辑器；showInMonaco 会触发 change 回调，故完成后才清 dirty
  const monacoEl = document.getElementById("ck-monaco");
  if (monacoEl && currentRelPath) {
    showInMonaco(monacoEl, currentRelPath, content).then(() => {
      dirty = false;
      updateSaveBtn();
    });
  } else {
    dirty = false;
    updateSaveBtn();
  }
}

/** diff 模式：隐藏文件树让预览占满（退出恢复） */
function setDiffTreeHidden(hidden: boolean): void {
  const cols = colsEl();
  if (cols) cols.classList.toggle("diff-mode", hidden);
}

/** 退出 diff 视图，回到编辑器显示 */
function exitDiffToEdit(): void {
  diffMode = false;
  updateDiffBtn();
  setDiffTreeHidden(false);
  const diffEl = document.getElementById("ck-monaco-diff");
  const editEl = document.getElementById("ck-monaco");
  if (diffEl) diffEl.style.display = "none";
  if (editEl) editEl.style.display = "block";
}

/** 切换 diff 视图：与 git HEAD 对比（用独立容器，不碰编辑器 model，不丢未保存编辑） */
async function toggleDiff(): Promise<void> {
  if (!currentRelPath) return;
  const editEl = document.getElementById("ck-monaco");
  const diffEl = document.getElementById("ck-monaco-diff");
  if (!editEl || !diffEl) return;

  if (diffMode) {
    // 退出 diff → 显示编辑器（其内容/未保存编辑原样保留）
    hideConflictBar();
    exitDiffToEdit();
    return;
  }

  const r = await (api as any).gitShowFile(currentRelPath);
  if (!r || !r.success) { await ckAlert("无法对比：" + ((r && r.error) || "未提交或无基准版本"), "Diff"); return; }
  // modified 用「编辑器当前内容」（含未保存编辑），更实用且不丢数据
  const curContent = getEditorValue();
  diffMode = true;
  updateDiffBtn();
  setDiffTreeHidden(true);
  const emptyEl = document.getElementById("ck-preview-empty");
  if (emptyEl) emptyEl.style.display = "none";
  editEl.style.display = "none";
  diffEl.style.display = "block";
  await showDiff(diffEl, currentRelPath, r.content, curContent);
}

/** Diff 按钮显隐/文案 */
function updateDiffBtn(): void {
  const btn = document.getElementById("ck-preview-diff");
  if (!btn) return;
  if (!currentRelPath) { btn.style.display = "none"; return; }
  btn.style.display = "";
  btn.textContent = diffMode ? "返回" : "Diff";
  btn.classList.toggle("active", diffMode);
}

/** 文件在外部被修改 → 按当前是否有未保存编辑决定：自动刷 / 弹框二选一 */
async function onExternalChange(relPath: string): Promise<void> {
  // 只处理当前正在看的文件
  if (relPath !== loadedRelPath || !currentRelPath) return;
  // 预览隐藏（切走 tab）时不处理：等 restore 时 loadFile 自然重读，避免后台弹框
  if (!pane() || !pane()!.classList.contains("open")) return;
  // 自己刚保存触发的变更 → 忽略
  if (Date.now() - lastSelfSaveAt < 800) return;
  if (conflictHandling) return;

  if (!dirty) {
    // 无未保存编辑 → 静默重载最新内容
    await loadFile(relPath);
    return;
  }

  // 有未保存编辑 → 弹框三选一（不丢数据）
  conflictHandling = true;
  try {
    const choice = await ckDialog3({
      title: '文件已被外部修改',
      message: '文件「' + relPath + '」已在外部被修改，你本地有未保存的编辑。\n\n' +
        '· 采用外部版：放弃本地编辑，加载外部最新版\n' +
        '· 查看差异：先对比两版内容再决定\n' +
        '· 保留我的：保持本地编辑（稍后可保存覆盖）',
      primary: '采用外部版',
      alt: '查看差异',
      cancel: '保留我的',
    });
    if (choice === 'primary') {
      dirty = false;
      await loadFile(relPath);
    } else if (choice === 'alt') {
      await showConflictDiff(relPath);
    }
    // cancel：什么都不做（保留我的）
  } finally {
    conflictHandling = false;
  }
}

/** 打开预览：树固定宽 + 预览 flex:1；侧栏加宽给预览腾空间 */
export async function openPreview(relPath: string): Promise<void> {
  const p = pane();
  if (!p) return;
  currentRelPath = relPath;
  if (!p.classList.contains("open")) {
    const l = listEl();
    openedBaseWidth = baseSidebarWidth();
    // 树固定当前宽（不再被预览挤压）
    if (l) {
      const treeW = Math.round(l.getBoundingClientRect().width);
      l.style.flex = "0 0 " + treeW + "px";
      l.style.width = treeW + "px";
    }
    p.classList.add("open");
    // 预览占剩余空间
    p.style.flex = "1 1 0";
    p.style.width = "";
    // 侧栏加宽 = 初始预览宽（给预览腾地方）
    setSidebarWidth(openedBaseWidth + Math.min(getPreviewWidth(), maxPreviewWidth()));
  }
  await loadFile(relPath);
}

/** 临时隐藏（切走 tab / 收起侧栏）：记住文件 + 缩回侧栏（不重载，未保存改动保留在编辑器） */
export function hidePreview(): void {
  const p = pane();
  if (!p || !p.classList.contains("open")) return;
  p.classList.remove("open");
  const l = listEl();
  if (l) { l.style.flex = ""; l.style.width = ""; }
  if (openedBaseWidth > 0) setSidebarWidth(openedBaseWidth);
  openedBaseWidth = 0;
}

/** 真关闭（点 ✕）：忘掉文件 + 缩回侧栏 */
export function dismissPreview(): void {
  if (dirty) {
    confirmDiscard().then((ok) => { if (ok) { dirty = false; dismissPreview(); } });
    return;
  }
  currentRelPath = "";
  loadedRelPath = "";
  dirty = false;
  diffMode = false;
  try { if ((api as any).unwatchProjectFile) (api as any).unwatchProjectFile(); } catch (_) {}
  hidePreview();
}

/** 恢复预览布局（切回「文件」tab 时，只恢复显隐与宽度，不重读文件——内容一直在编辑器里） */
export function showPreviewLayout(): void {
  if (!currentRelPath) return;
  const p = pane();
  if (!p || p.classList.contains("open")) return;
  const l = listEl();
  openedBaseWidth = baseSidebarWidth();
  if (l) {
    const treeW = Math.round(l.getBoundingClientRect().width);
    l.style.flex = "0 0 " + treeW + "px";
    l.style.width = treeW + "px";
  }
  p.classList.add("open");
  p.style.flex = "1 1 0";
  p.style.width = "";
  setSidebarWidth(openedBaseWidth + Math.min(getPreviewWidth(), maxPreviewWidth()));
}

/** 恢复之前看的文件（切回「文件」tab 时）：只恢复布局，不重读文件 */
export function restorePreview(): void {
  showPreviewLayout();
}

// ✕ 关闭按钮
document.getElementById("ck-preview-close")?.addEventListener("click", dismissPreview);
// 保存按钮
document.getElementById("ck-preview-save")?.addEventListener("click", () => { saveFile(); });
// Diff 按钮
document.getElementById("ck-preview-diff")?.addEventListener("click", () => { toggleDiff(); });
// Ctrl+S 保存（仅在文件页预览打开时）
document.addEventListener("keydown", (e: any) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && currentRelPath && pane()?.classList.contains("open")) {
    e.preventDefault();
    saveFile();
  }
});
// 编辑器内容变更 → 标记未保存
onEditorChange(() => { dirty = true; updateSaveBtn(); });
// 文件在外部被修改 → 自动刷新 / 冲突弹框
try { if ((api as any).onProjectFileChanged) (api as any).onProjectFileChanged((d: any) => { if (d && d.relPath) onExternalChange(d.relPath); }); } catch (_) {}
// 系统程序打开
document.getElementById("ck-preview-ext")?.addEventListener("click", () => {
  if (currentRelPath && (api as any).openFileExternal) (api as any).openFileExternal(currentRelPath).catch(() => {});
});

// 左条（树/内容之间）：改树宽（总宽不变 → AI 不变）
{
  const p = pane();
  if (p) {
    const rz = document.createElement("div");
    rz.className = "ck-preview-resizer";
    rz.title = "拖动调整：文件树 / 内容区";
    p.appendChild(rz);
    rz.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      const startX = e.clientX;
      const l = listEl();
      const cols = colsEl();
      if (!l || !cols) return;
      const startTreeW = l.getBoundingClientRect().width;
      const totalW = cols.getBoundingClientRect().width;
      const onMove = (ev: any) => {
        let treeW = Math.round(startTreeW + (ev.clientX - startX));
        const maxTree = Math.max(MIN_TREE_W, totalW - MIN_PREVIEW_W);
        if (treeW < MIN_TREE_W) treeW = MIN_TREE_W;
        if (treeW > maxTree) treeW = maxTree;
        l.style.flex = "0 0 " + treeW + "px";
        l.style.width = treeW + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // 记忆预览宽（= 总宽 - 树宽）
        const treeW = l.getBoundingClientRect().width;
        savePreviewWidth(Math.max(MIN_PREVIEW_W, Math.round(totalW - treeW)));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
}
