# 最新接续状态 (2026-10-13 20:00)

## 核心进展

本轮连续推进 **v0.8.46 → v0.8.49**（4 个版本），已全部提交、打 tag、推送 origin。最新 tag **v0.8.49**。

**v0.8.49 是子代理审查（code-reviewer）发现问题的修复**——见下方「子代理审查结论」。

前序 v0.8.40 → v0.8.45（任务页 + Token 统计 + 自动更新）已全部真机验证通过。

## 版本清单（本轮）

- **v0.8.46**：任务页停止态修复（stopping 纳入 TaskInfo + 渲染签名）+ 运行后滚动 + 更新安装并发保护（标记文件 + 版本拦截）
- **v0.8.47**：任务输出剥离 ANSI 控制码（decode-output 新增 stripAnsi，处理 CSI/OSC/单字符；UTF-8 与 GBK 分支都走）
- **v0.8.48**：运行任务后滚动定位到「刚运行的任务卡片」（原滚到面板底部，任务多时看到最旧的，看不到刚运行的）
- **v0.8.49**：子代理审查修复——更新门禁锁死（installAndRestart 无参→target 空→新版被拦 10 分钟）+ 任务停止兜底 exitCode + expanded 裁剪

## 本轮修复详情（v0.8.46）

### 1. 任务「停止」按钮卡在「停止中…」
- **根因**：渲染层手动改按钮 DOM（`textContent='停止中…'; pointerEvents='none'`），但 `renderTasks` 按签名去重——签名（id|status|exitCode|command）在进程真退出前不变 → 不重建 DOM → 按钮停在手动态；要等进程退出/3.5s 兜底才恢复。
- **修法**：`TaskInfo` 增 `stopping?: boolean`；`stop()` 置位后 `notifyChange()`；`toInfo` 透出；`finish()`（进程退出）清 `stopping=false`。渲染层：签名纳入 `stopping`；`renderTaskItem` 据 `running && stopping` 渲染「停止中…」(disabled)；停止 handler 不再手改 DOM。
- **验证**（CDP）：停止→`stopping:true`+按钮「停止中…」disabled→进程退出(PID 消失)→`stopping:false`+按钮恢复移除键。✓

### 2. 运行命令/脚本后看不到运行状态（v0.8.46 初版 → v0.8.48 修正）
- **v0.8.46 初版**：`scrollToTaskList()` 滚 `.ck-panel-body` 到底部。
- **v0.8.48 修正**：任务列表**新任务在顶部**（list() 按 startedAt 倒序），滚到底部在任务多时看到的是**最旧**任务，看不到刚运行的。改为 `scrollToTask(taskId)` → `item.scrollIntoView({behavior:'smooth', block:'start'})` 定位**新任务卡片**，配合已有的自动展开输出，直接看到执行过程。
- 调用点：scripts 按钮 + 手动命令运行。
- **验证**（CDP 真实 UI 路径）：输入命令点运行 → scrollIntoView 被调一次，参数 `{behavior:'smooth', block:'start'}`，id 正是刚运行任务；该卡片输出已展开。✓

### 3. 更新静默安装期间可重复启动旧 exe
- **风险**：安装窗口期（应用退出、文件被替换）用户再双击旧图标 → 与安装程序争用文件锁 → 安装失败/版本混乱。
- **修法**：`updater/index.ts` 新增标记文件 `<userData>/update-pending.json`（记录目标版本 + 时间戳）：
  - `markUpdatePending()`：`installAndRestart()` 安装前写标记。
  - `isUpdatePending()`：启动检查——当前版本 < 目标版本 且未超 10 分钟 → true；版本达标/超时/损坏 → 清理并放行。
  - 三处 `quitAndInstall` 归一为 `installAndRestart()`。
  - `entry.ts`：`whenReady` 开头检查，命中则 `showMessageBoxSync` 提示 + `app.quit()`。
- 未真机验证（需跨版本，下次发版验证）。

## 子代理审查结论（v0.8.49）

用 code-reviewer 审查 v0.8.46~48 改动，发现 1 必须修复 + 4 建议 + 4 参考。已处理：

- 🔴 **必须修复 #1**：`checkForUpdates` 的"已下载完成"分支 `installAndRestart()` 无参 → `targetVersion` 空 → 更新成功后新版启动被 `isUpdatePending` 判"未完成"拦截，**锁死最长 10 分钟**（本次引入的真实回归）。
  - 修：`update-downloaded` 记 `downloadedVersion`；`installAndRestart` 带目标版本；标记增 `fromVersion`；`isUpdatePending` 判定改「版本已变/达目标/数据不完整」都放行；标记原子写。
  - 验证：抽取判定逻辑跑 7 个分支用例（含"更新成功→版本已变→放行"）全过 ✓
- 🟡 #2：`stop()` 兜底超时/!pid 分支未设 exitCode、未清 stopping → UI「退出码 undefined」。已补 `exitCode ?? null` + 清 stopping；渲染层 `exitCode == null` 归「已结束」。真机冒烟 ✓
- 🟡 #3/#4：注释修正 + 标记原子写（已随 #1 处理）
- 🟡 #5：`expanded` 清空后裁剪（防无界累积）+ 修正陈旧注释
- 🔵 #6 stripAnsi 边界测试 / #7 冗余声明（已删）/ #9 entry 兜底（已有 try/catch）
- ⏭️ **#8 未做**：`isUpdatePending` 测试——`src/updater/**` 被 vitest 排除（需 Electron 运行时），写测试必须深 mock electron，违反「只写真实集成测试」规则，故不做，靠真机验证。

## 关键设计（沿用）

- 任务管理器 `src/infra/task-manager.ts`：进程表 + 进程树杀（Win `taskkill /T /F`，**stop 里不能同时 child.kill()**）。输出 `decodeOutput`（GBK 兼容）。
- 窗口结构：AI 页面用 `ctx.view.webContents`，不是 `ctx.win.webContents`。
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`。

## ⚠️ 待排查（重要，未修）

**全局规则第 4 条未注入**：`~/.cuckoo/rules/global-override.md` 有「4. 复杂代码修改后使用子代理检查，主代理审计」及第 46 行「> 也可派出子代理检查，你在审计」，但系统提示词注入的 global-override 里这两行丢失。疑似规则注入被截断/旧缓存。**待排查**。

## ⚠️ 工作区遗留（勿动）

- `src/ui/shell/scripts/pages/rules.ts` + `src/ui/shell/styles/components.css` 有**另一条功能线**的未提交改动（规则页保存提示改插 span，避免改 icon-only 按钮）。**不属于本轮，勿顺手提交**。
- **预存在测试失败**：`test/plugins/installer.test.js > installPlugin: 不残留临时目录`——clean master 上同样失败（已 stash 验证），与 v0.8.46~49 无关，待排查。

## 待办事项 (Next Steps)

- [ ] **排查规则注入丢失 bug**
- [ ] 真机验证 v0.8.46~49 更新并发保护（跨版本：装 v0.8.49 后等下个版本发布验证）
- [ ] 确认 CI（tag v0.8.40~v0.8.49）Win+Mac 构建成功
- [ ] 真机复核 v0.8.47（任务输出无 ANSI 乱码）、v0.8.48（运行后定位到新任务）——需装打包版验证
- [ ] 排查预存在失败 `test/plugins/installer.test.js`

## 关键上下文

- 目录: D:\Desktop\Super-File\cuckoo-code
- 远端: origin=Huo-zai-feng-lang-li；tag 推送触发 `.github/workflows/release.yml`（Win+Mac）
- 生成物禁手改：`*.generated.ts`、`src/tools/api.d.ts`、`src/ui/shell.html`（改真源 + `npm run compile`）
- 全局规则：`~/.cuckoo/rules/global-override.md`（第 4 条：复杂改动后派子代理检查 + 主代理审计——**注入丢失待查**）
- 发版流程：写 CHANGELOG → `npm version X --no-git-tag-version` → commit → `git tag -a vX` → push master + push tag
- git 钩子：`.githooks/pre-commit`（重建生成物 + 刷新需求 INDEX）；`.githooks/post-commit`（自动 push master）
- **用户偏好**：改完代码主动 commit / push / 递增版本打 tag 发布，并汇报改动与验证结果
- **真机验证注意**：本机常驻 **7 个 Cuckoo-Code.exe（打包版）**，占单实例锁 → 开发版 `npx electron .` 拿不到锁会静默退出。验证开发版需 `CUCKOO_SESSION_DIR=cuckoo-dev-verify npx electron . --remote-debugging-port=9444` + Node CDP 直连。
