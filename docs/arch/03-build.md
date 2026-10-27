# 03 构建流程

## 命令总览

| 命令 | 作用 |
|---|---|
| `npm start` | 编译 + 启动 Electron（开发用，日志进 `wyp/log/`） |
| `npm run compile` | 三步构建（见下） |
| `npm run typecheck` | `tsc --noEmit` + `tsc -p tsconfig.hooks.json`（两套） |
| `npm test` | Vitest |
| `npm run lint` | ESLint |
| `npm run build:win:local` | 本地打 Windows 包 |

## compile 的完整步骤（8 步）

```
npm run compile
  = node scripts/copy-monaco.mjs          # ① 复制 monaco 编辑器资源
  && node scripts/build-hooks.mjs         # ② 打包 hook + 外置模板
  && node scripts/build-sanitizer.mjs     # ③ 构建 HTML sanitizer
  && tsc -p tsconfig.build.json           # ④ TS → out/
  && node scripts/copy-remote-pwa.mjs     # ⑤ 复制 PWA 静态文件 + marked
  && node scripts/copy-sandbox-worker.mjs # ⑥ 复制沙箱 worker
  && node scripts/build-tool-api.mjs      # ⑦ 生成工具契约 + 沙箱注入
  && node scripts/build-shell.mjs         # ⑧ 组装壳页面 shell.html
```

**顺序约束**：⑦ 依赖 ④ 的编译产物（读 `out/src/tools/impl/*.js` 的 `apiMetas`）；⑧ 依赖 `src/ui/shell/` 源码。
**改了 `src/ui/shell/**` 必须跑 compile 或 `node scripts/build-shell.mjs`**，否则 `src/ui/shell.html` 不更新。

### ② build-hooks.mjs

- **hook**：用 esbuild 把 `src/providers/hooks/*.ts` 打包成自包含 IIFE，写入 `src/providers/generated/hook-sources.ts`。
  - 为何要打包？hook 经 `.toString()` 注入 AI 网页主世界，**只能自包含**。写成正常 TS 模块 + 构建期打包，才能 import 共享的 `shared/sse.ts`。
- **覆盖层模板**：读 `src/overlay/template/overlay.html` 与 `overlay.css`，写入 `src/overlay/template.generated.ts`。

### ④ tsc

编译 `src/**/*.ts` → `out/`（`rootDir: .`，`outDir: out`）。产物结构镜像 `src/`，即 `out/src/...`。**排除 `src/providers/hooks`**（它们由 esbuild 处理，不需 tsc emit）。

### ⑦ build-tool-api.mjs

- **工具契约**：收集所有工具的 `apiMetas`，按 `order` 排序、按 `category` 分组，生成 `src/tools/api.d.ts`（给 AI 看的 TS 声明）。
- **沙箱注入**：收集所有工具的 `bootstrap()` 函数，`.toString()` 提取函数体，生成 `src/tools/runtime/bootstrap.generated.ts`。

## 自动生成物清单（⚠️ 别手改）

| 文件 | 真源 |
|---|---|
| `src/providers/generated/hook-sources.ts` | `src/providers/hooks/*.ts` |
| `src/overlay/template.generated.ts` | `src/overlay/template/overlay.{html,css}` |
| `src/tools/api.d.ts` | 各工具的 `apiMetas` |
| `src/tools/runtime/bootstrap.generated.ts` | 各工具的 `bootstrap()` |
| `src/ui/shell.html` | `src/ui/shell/`（index.html + partials + styles + scripts） |

**生成物已提交到 git**（便于 diff 与直接运行），但**改动应改真源**。

## 两套 tsconfig

| 配置 | 范围 | strict | 用途 |
|---|---|---|---|
| `tsconfig.json` | `src/**` + `test/**`（排除 hooks） | ✅ | 主应用类型检查 |
| `tsconfig.hooks.json` | `src/providers/hooks/**` | ❌ | hook 独立环境 |
| `tsconfig.build.json` | `src/**`（排除 hooks、test） | 继承 | 编译到 out/ |

**为什么 hook 单独一套**：hook 是注入浏览器主世界的动态脚本（大量 DOM/fetch/XHR 无类型回调），用 strict 会逼出一堆形式主义的 `: any`。单独环境既保留基础检查，又不污染主应用。

## 启动链

```
npm start
  → node start.js
      → tsc -p tsconfig.build.json（编译）
      → electron .
          → 读 package.json 的 main = out/src/app/entry.js
              → src/app/entry.ts 的 app.whenReady() → createWindow()
```
