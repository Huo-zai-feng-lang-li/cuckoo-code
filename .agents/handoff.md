# 最新接续状态 (2026-10-12 更新)

## 2026-10-12 追加会话：纯净模式发送队列 + 右侧对话导航

- **提交**：`bb19a22` feat(harness): 纯净模式发送队列 + 右侧对话快捷导航
- **改动文件**：仅 `src/ui/harness.html`（手写源，不在构建流程）+ `test/ui/harness-page.test.js`
- **发送队列**：busy 时 Enter 入队（不再丢弃）；输入框上方显示待发队列可单删；任务就绪自动发下一条；goal/plan 指令不入队；用户主动停止(aborted)后不自动发；flush 备份/恢复用户输入不打断
- **对话导航**：右侧浮动圆点（fixed），每条用户消息一个锚点，悬停显摘要、点击 scrollIntoView、滚动高亮当前项；<2 条不显示；切会话/空态清空
- **真机验证**：CDP(9333) 实测——导航 5 锚点渲染、点击 scrollTop=13812、active=1 ✅
- **验证**：typecheck ✅ / test 937 passed ✅ / lint 0 errors ✅ / compile ✅
- **版本**：已 bump 0.8.12、已打 tag v0.8.12 并 push（触发 CI Release）
- **遗留**：队列"生成中入队→自动发"仅单测守卫，未在真实生成中手动实测（注入会干扰会话）


> 面向下次会话的 AI，**开工前先读**。以本地源码为准。
> 上一份 handoff（10-11 会话）归档在 backup/pre-ff 分支。

## 当前 git 状态

| 项 | 值 |
|---|---|
| 分支 | master |
| HEAD | `26182c2`（本 AI 最后提交） |
| 基座 | v0.8.11（合并自 8555uuy/personal/full，`862d144`） |
| 工作区 | 干净 |
| 领先 origin | 若干 commits（**未 push**） |
| 备份分支 | `backup/pre-ff`（10-11 会话存档 `d0fe406`，99 文件） |

### 本会话相关提交（部分由用户/其它会话提交）
- `26182c2` 恢复主题/系统浏览器按钮 + 纯净模式最近回显 + 通知点击聚焦 ← **本 AI**
- `6d7614f` 全局规则管理页 + 对话入口隐藏 + 最近叉号恢复
- `c7a58dc` 停止按钮真杀子代理
- `bb399d4` JsRunner 长任务判定增强 + 插件图标首字 + 提示词段卸载清理
- `28d30d9` docs: handoff.md
- `7ffb02d` 限流窗口自动关闭 + 自动创建 handoff + 项目规则 ← **本 AI**
- `e32d898` 窗口组跳过忙碌 + 并发串行 + 延迟统一等 ← **本 AI**

## 重要事件：git 被外部改变

会话中途**有人执行了合并**（非本 AI 操作）：master 从 0.8.10 快进到 0.8.11（merge 8555uuy/personal/full）。
**收益**：0.8.11 内置了插件需要的后端 API（memories/snapshots/ipc/tools）——"插件缺后端"问题从根解决。

## 本会话已完成的改动（要点）

1. **发送延迟统一**：初始提示秒发；任务反馈+11 处系统消息走 0.5~1s 区间；默认 2000/4000→500/1000
2. **并发发送丢消息修复**：chat-input.ts sendToChat 改串行链 sendChain
3. **停止按钮恢复**：observer.ts 全程 showToolMask(停止回调)；overlay.css 改顶部非阻塞提示条
4. **构建健壮性**：copy-monaco 幂等化；tsconfig exclude src/ui/vendor
5. **任务栏图标**：scripts/patch-electron-icon.mjs（rcedit 打 exe 图标），集成 start.js
6. **窗口名显示**：statusbar + IPC + 渲染
7. **窗口组跳过忙碌窗口**：window.ts setGenerating/isGenerating + harness.ts 记 ai-state + entry.ts 探测跳过
8. **限流窗口自动关闭**：runSwitchForGroup 加 closeSource 参数（限流路径 true）
9. **自动创建 .agents/handoff.md**：project-context.ts ensureAgentsHandoff
10. **项目规则** `.cuckoo/rules/project.md`（无 paths，始终适用）
11. **全局规则修正** `~/.cuckoo/rules/global-override.md`（不在 git，已备份 .bak）
12. **恢复丢失的菜单/按钮**：全局规则管理页、对话 tab、主题按钮、系统浏览器按钮
13. **纯净模式最近回显**：append/trigger 按 __ckHarnessVisible 路由到 harness 输入框
14. **通知点击聚焦窗口**：renderer.ts notification.on('click')
15. **插件图标**：无 icon 时用标题首字（不再统一小地球）

## ⚠️ 待办（下次会话做）—— 4 项新任务 + 遗留

### 新任务 A：登录安全（"浏览器环境不安全"）
- **现状**：反检测代码已写且已接入——user-agent.ts 的 buildChromeUserAgent（entry.ts:473）、
  buildClientHintsHeaders（entry.ts:480）、buildUserAgentDataFix（bridge/entry.ts:44）。
- **但站点仍提示不安全** → 需**真机抓证**确认漏点：
  - Sec-CH-UA 头是否**真正发到请求**（可能只设了变量没挂 webRequest）
  - 其它指纹：navigator.plugins / hardwareConcurrency / languages / WebGL / Canvas / chrome 对象
  - Electron 特有暴露：window.process、--remote-debugging
- **难度高**（深度逆向），需对着具体站点检测脚本逐项过。

### 新任务 B：性能优化
- **需求不明确**，需用户指明场景：启动慢 / 界面卡 / 长对话卡 / 内存高。
- 已知：backlog 记过"长对话卡是 DeepSeek 自身 O(n²) 渲染，改不了"。

### 新任务 C：工作区删除（只有归档没有删除）
- **现状（已核实，2026-10-12 修正）**：整条删除链路**都不存在**——
  - shell-preload.ts **没有** deleteSessionRecord / deleteProjectRecords（也无对应 IPC 名）；
    仅暴露 setSessionArchived / setProjectArchived（归档/取消归档）。
  - 主进程 ipc/session.ts 只有 set-project-archived / set-session-archived，**无 delete-***。
  - **UI**：pages/workspaces.ts 只有归档/取消归档，**无删除按钮**。
- **做法**：从零补三处 —— ① store 层删除方法（src/session/store.ts）② 主进程 handler（ipc/session.ts）③ preload 暴露（shell-preload.ts）+ UI 删除按钮（workspaces.ts，二次确认）。

### 新任务 D：发布 Releases
- **现状**：CI 已配好！`.github/workflows/release.yml`——打 tag（v*）→ 自动构建 Win+Mac → 创建 Release。
- **做法**：先 push 代码 → `git tag v0.8.12` → `git push origin v0.8.12`（触发 CI）。
- **前提**：fork 的 Actions 有权限。

### 遗留 3 项（backup/pre-ff 有、master 没有）
- 子进程树 taskkill（tools/impl/bash.ts、pwsh.ts）
- IPC 协议白名单（app/ipc/shell.ts）
- 删 fab.ts（0.8.11 又带回）
> ⚠️ **不能 git checkout backup/pre-ff -- 文件**（backup 是 0.8.10 基座，会丢 0.8.11 改动），要逐段挑。

### 重启验证（本会话改动多为主进程，需 npm start）
- 限流关窗口、窗口组跳过忙碌、停止按钮、窗口名、主题/浏览器按钮、纯净模式回显、通知聚焦

## 关键背景

- **依赖铁律**：overlay 不 import bridge/session/app；bridge/session 不依赖 overlay/state；tools 不依赖上层
- **窗口结构**：地址栏在 win.webContents（壳页面），AI 页面在 ctx.view（WebContentsView）
- **生成物禁手改**：*.generated.ts、src/tools/api.d.ts、src/ui/shell.html（改真源 + npm run compile）
- **规则目录**：全局 `~/.cuckoo/rules/`；项目 `<项目>/.cuckoo/rules/`；scanner 只扫这两个（.agents/rules 不被识别）
- 目录：D:DesktopSuper-Filecuckoo-code
- 外网代理：http://127.0.0.1:51081
- CDP 调试：Electron 开 --remote-debugging-port=9333

## 规则遵循自省（下次务必避免）

1. **未挂载 Skills 套件**（~/.agents/skills/）—— 规则要求改代码前读 SKILL.md 并标记 [Auto-Skill]
2. **未建需求档案 / 分支**
3. **未创建 .agents/plan-*.md 计划文档**
4. **未用子代理**（code-reviewer 等）
5. 教训：`git add -A` 易误提交临时文件（本会话犯过两次）——提交前检查 git status

## 验证状态（本会话最后）

- typecheck ✅ / compile ✅ / 测试通过 ✅ / lint 0 errors ✅
- 尚未真机 npm start 验证本会话运行时改动
