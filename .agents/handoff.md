# 会话接续状态

## 当前版本
- package.json / CHANGELOG 顶部：**v0.10.97**（2026-10-27）

## 最近完成的工作
- **v0.10.85**：恢复自动更新静默安装（不再弹窗）。
- **文档校准（本轮）**：
  - `.cuckoo/CUCKOO.md`：修正「加 IPC」链路（壳页面走 `src/app/shell-preload.ts`，`bridge/api.ts` 只给 AI 网页）；compile 由"三步"更正为 8 步；生成物禁改清单补 `bootstrap.generated.ts` 与 `src/ui/shell.html`。
  - `docs/arch/03-build.md`：compile 步骤改为完整 8 步，小节编号对齐；生成物清单补 `src/ui/shell.html`。
  - `.agents/rules/overlay.md` / `bridge.md`：为既有的 `session/compaction.js` 依赖加"已知例外"说明（不拆代码）。

## 已知问题 / 待办
- **远程 PWA 体验**：手机切后台/锁屏约 90–120s 会被服务端心跳判死并重连；重连后 `renderHistory` 会 `innerHTML=''` 整块重画并强制滚底，视觉上像"刷新"。属设计副作用，**本轮按要求未改**。
- **用户级全局规则** `~/.agents/rules/rule.md` 写死本机路径（`D:\Desktop` 等），换机器会失效，需人工调整。
- **GitHub Release 标记**：如仍有 Tag 竞态遗留，需网页端手动把最新版本设为 Latest。

## 关键文件
- 提示词组装：`src/session/prompt-builder.ts`（项目专属内容全从项目目录读，无硬编码）
- 规则扫描：`src/rules/scanner.ts`、`src/rules/prompt.ts`
- 远程：`src/remote/server.ts`（心跳/WS）、`src/remote/manager.ts`（历史重推）、`src/remote/pwa/app.js`（重连与渲染）
