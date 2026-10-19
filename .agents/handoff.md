# 最新接续状态 (2026-10-20)

## 已发布 v0.10.39（本轮 9 个提交，含 3 类修复 + 1 次发版事故补救）

### 本轮全部改动（9 个提交，v0.10.31 ~ v0.10.39）

| 版本 | 类型 | 内容 | 影响面 |
|---|---|---|---|
| v0.10.31 | fix | 手机端表格横滚（td 补 `white-space:nowrap`）+ 系统消息断词 + 滚动条美化 | `src/remote/pwa/style.css` |
| v0.10.32 | fix | 文件预览（Monaco）跟随应用内主题（不再只读系统 matchMedia） | `preview-monaco.ts` / `theme-presenter.ts` |
| v0.10.33 | feat | 项目文件面板支持外部变更自动刷新（复用 Git watcher） | `pages/files.ts` |
| v0.10.34 | fix | 补 v0.10.33 漏写的 `filesDirty` 声明（隐式全局） | 同上 |
| v0.10.35 | perf | 自动刷新接入合并机制（800ms 防抖 + in-flight 守卫 + 队列） | 同上 |
| v0.10.36 | fix | 切项目竞态（代际守卫）+ in-flight 击穿 + TDZ + 加载占位 | 同上 |
| v0.10.37 | docs | 补 CHANGELOG 缺失的 [0.10.35] 章节 | `CHANGELOG.md` |
| v0.10.38 | fix | **工具超时后永久卡死**：超时杀进程后 800ms 强制 resolve | `src/infra/run-captured.ts` |
| v0.10.39 | chore | 补 v0.10.38 遗漏的 `package.json` 版本号（代码同 v0.10.38） | `package.json` |

### 关键教训

1. **发版必须同步版本号**：v0.10.38 打 tag 时忘了改 `package.json`，CI 会构建出内部版本号错误的包。v0.10.20 犯过一次，v0.10.38 又犯了。**发版前先检查 `findstr version package.json` 是否与 tag 一致**。
2. **不要挪已推送的 tag**：正确做法是发新版本覆盖（v0.10.39 补救 v0.10.38）。
3. **`src/ui/shell/scripts/` 不在 tsc 检查范围**：这个目录的 TS 只靠 esbuild 打包，未声明变量、误删函数这类错误 typecheck 抓不到。本轮踩了两次（`filesDirty` 漏声明、误删 `onProjectDir` 回调整段）。**改这个目录后必须人工读一遍改动的函数，不能只靠编译通过**。
4. **超时杀进程不等于 Promise 会 resolve**：孙进程继承 stdout/stderr 管道时 `close` 事件永不触发。必须加强制 resolve 兜底。
5. **iOS Safari 忽略 `::-webkit-scrollbar`**：手机端滚动条美化在 iPhone 上不生效，只影响 Android / 桌面。

### 验证状态

- 每个版本：compile / test(1225) / lint(0 errors) 全绿
- v0.10.31 真机（Chromium 390x844）：表格 scrollW 766 > clientW 348、td.nowrap、系统消息换行不裁切、scrollbarWidth=thin、深色 token 跟随
- v0.10.36 / v0.10.38：仅静态审查 + 子代理复核，**未真机验证**（用户待测）

### 待用户验证（重要）

见本次交付的测试清单。重点：
1. 工具超时后是否还会卡死（v0.10.38 核心修复）
2. 项目文件面板外部变更自动刷新（v0.10.36）
3. 文件预览跟随主题（v0.10.32）
4. 手机端表格横滚 / 滚动条（v0.10.31）

### 已知遗留（有意不修）

- CRUD 后有一次冗余目录扫描（内容相同、用户无感，修要加抑制窗口，出错面更大）
- `mcpCall` 无显式超时（靠 JsRunner 60s 看门狗兜底，不会永久卡界面，但 MCP 请求会泄漏）
- `run-captured.ts` 内层 `setTimeout` 未 unref（仅浪费一个 timer）
- 本轮发版节奏偏碎（v0.10.31~39 共 9 个），下次应合并发版

---

## 历史（v0.10.30 及之前）

见 CHANGELOG.md。master 在 v0.10.30 时为 `e89b72b`。
