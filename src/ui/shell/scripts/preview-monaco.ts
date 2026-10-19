/**
 * Monaco Editor 集成（文件预览用）。
 * 通过 AMD loader 加载 vendor/monaco/vs；提供创建 / 更新 / 主题 / 语言。
 */

let monacoPromise: Promise<any> | null = null;
let editor: any = null;

/** 扩展名 → Monaco 语言 id */
const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", json5: "json",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  css: "css", scss: "scss", less: "less", sass: "scss",
  html: "html", htm: "html", vue: "html", svelte: "html",
  py: "python", pyw: "python",
  java: "java", kt: "kotlin", kts: "kotlin",
  go: "go", rs: "rust", rb: "ruby", php: "php",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  cs: "csharp",
  sh: "shell", bash: "shell", zsh: "shell", bat: "bat", cmd: "bat", ps1: "powershell",
  yml: "yaml", yaml: "yaml",
  xml: "xml", svg: "xml",
  sql: "sql",
  txt: "plaintext", log: "plaintext", lock: "plaintext",
};

function langOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  return LANG_MAP[name.slice(dot + 1).toLowerCase()] || "plaintext";
}

/** 加载 Monaco（AMD loader，全局只加载一次） */
export function loadMonaco(): Promise<any> {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const req = (window as any).require;
    if (!req) { reject(new Error("Monaco loader 未加载")); return; }
    try {
      req.config({ paths: { vs: "vendor/monaco/vs" } });
      (window as any).MonacoEnvironment = {
        getWorkerUrl: function (moduleId: string, label: string) {
          const base = "vendor/monaco/vs/";
          if (label === "json") return base + "language/json/json.worker.js";
          if (label === "css" || label === "scss" || label === "less") return base + "language/css/css.worker.js";
          if (label === "html" || label === "handlebars" || label === "razor") return base + "language/html/html.worker.js";
          if (label === "typescript" || label === "javascript") return base + "language/typescript/ts.worker.js";
          return base + "editor/editor.worker.js";
        },
      };
      req(["vs/editor/editor.main"], () => {
        resolve((window as any).monaco);
      }, (err: any) => reject(err || new Error("加载失败")));
    } catch (e) { reject(e); }
  });
  return monacoPromise;
}

/** 当前深浅色主题名 */
function themeName(): string {
  const scheme = document.documentElement.style.colorScheme;
  if (scheme === "dark") return "vs-dark";
  if (scheme === "light") return "vs";
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "vs-dark" : "vs";
}

let changeCb: (() => void) | null = null;

/** 注册内容变更回调（用于标记"未保存"） */
export function onEditorChange(cb: () => void): void {
  changeCb = cb;
  if (editor) {
    if ((editor as any).__ckChangeDisposable) { try { (editor as any).__ckChangeDisposable.dispose(); } catch (_) {} }
    (editor as any).__ckChangeDisposable = editor.onDidChangeModelContent(() => { try { changeCb && changeCb(); } catch (_) {} });
  }
}

/** 取当前编辑器内容 */
export function getEditorValue(): string {
  return editor && editor.getValue ? editor.getValue() : "";
}

/** 在容器里创建（或复用）编辑器并设置内容（可编辑） */
export async function showInMonaco(container: HTMLElement, fileName: string, content: string): Promise<void> {
  const monaco = await loadMonaco();
  const lang = langOf(fileName);
  if (!editor) {
    editor = monaco.editor.create(container, {
      value: content,
      language: lang,
      theme: themeName(),
      readOnly: false,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12.5,
      lineNumbers: "on",
      renderWhitespace: "none",
      wordWrap: "off",
    });
    (editor as any).__ckChangeDisposable = editor.onDidChangeModelContent(() => { try { changeCb && changeCb(); } catch (_) {} });
  } else {
    const model = monaco.editor.createModel(content, lang);
    const old = editor.getModel();
    editor.setModel(model);
    if (old) old.dispose();
    if ((editor as any).__ckChangeDisposable) { try { (editor as any).__ckChangeDisposable.dispose(); } catch (_) {} }
    (editor as any).__ckChangeDisposable = editor.onDidChangeModelContent(() => { try { changeCb && changeCb(); } catch (_) {} });
  }
}

let diffEditor: any = null;

/** 显示 diff（原始 vs 修改），内联红绿对比。orig=基准(HEAD)，mod=当前磁盘内容 */
export async function showDiff(container: HTMLElement, fileName: string, orig: string, mod: string): Promise<void> {
  const monaco = await loadMonaco();
  const lang = langOf(fileName);
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(container, {
      theme: themeName(),
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: false, // 内联（VSCode 默认风格）
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12.5,
      renderWhitespace: "none",
      wordWrap: "off",
    });
  }
  const origModel = monaco.editor.createModel(orig, lang);
  const modModel = monaco.editor.createModel(mod, lang);
  const old = diffEditor.getModel();
  diffEditor.setModel({ original: origModel, modified: modModel });
  if (old) { try { old.original && old.original.dispose(); old.modified && old.modified.dispose(); } catch (_) {} }
}

/** 主题跟随系统变化 */
export function syncMonacoTheme(): void {
  if (editor) { try { (window as any).monaco.editor.setTheme(themeName()); } catch (_) { /* ignore */ } }
  if (diffEditor) { try { (window as any).monaco.editor.setTheme(themeName()); } catch (_) { /* ignore */ } }
}

if (window.matchMedia) {
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncMonacoTheme); } catch (_) { /* ignore */ }
}
// 监听壳页面主题变化（由 theme-presenter.ts 触发）
window.addEventListener("ck-theme-change", syncMonacoTheme);
