---
name: app
paths:
  - "src/app/**/*.ts"
---

# app 层规则（主进程）

app 是**最上层**应用外壳：入口、窗口、IPC、壳页面。可依赖所有下层。

## 窗口结构（铁律）

一个窗口有**三个 webContents 层级**：

| 部分 | 访问方式 | 说明 |
|---|---|---|
| 地址栏/壳页面 | `ctx.win.webContents` | 壳页面（侧边栏、设置页等） |
| AI 页面 | `ctx.view.webContents` | WebContentsView，嵌 AI 网页 |
| 覆盖层 | 独立 BrowserWindow | overlay |

- ⚠️ **操作 AI 页面用 `ctx.view.webContents`，不是 `ctx.win.webContents`**——这是最常见的坑。
- 通过 `windowState.getContextByWebContents(sender)` 拿 ctx。

## Electron 惯用法（铁律）

主进程模块**必须**用 `createRequire` 动态 require，**不可**静态 `import 'electron'`：

```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ipcMain, dialog, Notification } = require('electron');
```

原因：Electron 的 ESM 加载有坑（`electron` 导出与 ESM 不兼容）。

## 加 IPC 的标准流程

1. 新建/编辑 `src/app/ipc/<领域>.ts`，导出 `register<领域>Ipc()`
2. 在其中 `ipcMain.handle('channel', handler)`
3. 到 `src/app/ipc/index.ts` 的 `registerIpcHandlers()` 里**注册**（漏了 → 处理器不生效）
4. 渲染进程调用：`src/app/shell-preload.ts` 暴露（`ipcRenderer.invoke`）+ `src/ui/shell/scripts/shell-api.ts` 补类型

## 安全约定

- 文件路径一律过 `resolveProjectPath` 校验（防目录穿越）
- 执行外部命令用 `execFile('cmd', [参数数组])`，**绝不拼 shell 字符串**（防注入）
