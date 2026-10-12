# 最新接续状态 (2026-10-12)

## 核心进展
- **本次会话（接续会话）**：读取 `.agents/handoff.md` 完成状态接续，**尚未开展实质编码**，等待任务指派。
- 上一会话已完成：全局自定义好看 Tooltip 引擎（替换系统原生 title）+ 纯净模式发送队列 + 右侧对话导航；已 bump 0.8.12、打 tag v0.8.12 并 push（触发 CI Release）。
- 验证状态（上一会话末）：typecheck ✅ / test 948 passed ✅ / lint 0 errors ✅ / compile ✅。

## 核心动机与背景 (Motivation & Background)
- 项目当前分支 master，HEAD `26182c2`，基座 v0.8.11，工作区干净，领先 origin 若干 commits（**未 push**）。
- 备份分支 `backup/pre-ff`（10-11 会话存档 `d0fe406`，99 文件）。
- 依赖铁律：overlay 不 import bridge/session/app；bridge/session 不依赖 overlay/state；tools 不依赖上层。
- 窗口结构：地址栏在 win.webContents（壳页面），AI 页面在 ctx.view（WebContentsView）。
- 生成物禁手改：*.generated.ts、src/tools/api.d.ts、src/ui/shell.html（改真源 + npm run compile）。

## 关键设计与实现 (Implementation & Decisions)
- 上一会话改动文件要点：
  - `src/ui/harness.html`：发送队列去文本原生 title、hover 整行铺满、垂直居中；导航圆点改 `data-tooltip`；内联挂载全局 Tooltip 引擎。
  - `src/ui/shell/scripts/tooltip.ts`（新增）：全局统一自定义 Tooltip 引擎（pointerover 捕获 `[title]` → `data-tooltip`）。
  - `src/ui/shell/scripts/main.ts` / `src/ui/shell/styles/components.css` / `src/ui/shell.html` / `src/ui/platform-select.html`。
  - 测试：`test/ui/harness-page.test.js` & `test/ui/tooltip.test.js`（新增守卫）。
- 发送延迟统一、并发发送丢消息修复（sendChain 串行）、停止按钮恢复、任务栏图标、窗口名显示、窗口组跳过忙碌、限流窗口自动关闭等（详见 git 历史）。

## 待办事项 (Next Steps)
- [ ] **新任务 A：登录安全**（"浏览器环境不安全"）——反检测代码已接入（user-agent.ts buildChromeUserAgent / buildClientHintsHeaders / bridge/entry.ts buildUserAgentDataFix），站点仍提示不安全，需真机抓证确认漏点：Sec-CH-UA 是否真正发到请求、其它指纹（plugins/hardwareConcurrency/languages/WebGL/Canvas/chrome 对象）、Electron 特有暴露（window.process、--remote-debugging）。难度高。
- [ ] **新任务 B：性能优化**——需求不明确，需用户指明场景（启动慢 / 界面卡 / 长对话卡 / 内存高）。
- [ ] **新任务 C：工作区删除**（现只有归档无删除）——整条链路都不存在，需从零补：① store 层删除方法（src/session/store.ts）② 主进程 handler（ipc/session.ts）③ preload 暴露（shell-preload.ts）+ UI 删除按钮（pages/workspaces.ts，二次确认）。
- [ ] **新任务 D：发布 Releases**——CI 已配好（.github/workflows/release.yml），push 代码 → `git tag v0.8.12` → `git push origin v0.8.12`。
- [ ] **遗留 3 项**（backup/pre-ff 有、master 没有，需逐段挑）：子进程树 taskkill（tools/impl/bash.ts、pwsh.ts）；IPC 协议白名单（app/ipc/shell.ts）；删 fab.ts（0.8.11 又带回）。
- [ ] **重启验证**：上一会话改动多为主进程，尚未真机 `npm start` 验证（限流关窗口、窗口组跳过忙碌、停止按钮、窗口名、主题/浏览器按钮、纯净模式回显、通知聚焦）。

## 关键上下文
- 目录: D:\Desktop\Super-File\cuckoo-code
- 主要文件: `src/ui/shell/scripts/tooltip.ts`、`src/ui/harness.html`、`src/session/store.ts`、`src/app/ipc/session.ts`、`src/bridge/entry.ts`
- 外网代理: http://127.0.0.1:51081
- CDP 调试: Electron 开 --remote-debugging-port=9333
- 规则目录: 全局 `~/.cuckoo/rules/`；项目 `<项目>/.cuckoo/rules/`
- ⚠️ 不可 `git checkout backup/pre-ff -- 文件`（backup 是 0.8.10 基座，会丢 0.8.11 改动），须逐段挑。
