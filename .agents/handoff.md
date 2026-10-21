# 最新接续状态 (2026-10-21)

## 已发布 v0.10.43

### 本轮改动 (v0.10.43)

| 版本 | 类型 | 内容 | 影响面 |
|---|---|---|---|
| v0.10.43 | fix | 合法工具代码块（cuckoo/js）内写 JSON/XML 示例误触格式纠错提示（剥离后再检测） | `src/bridge/intercept/observer.ts` |
| v0.10.43 | fix | 插件异步挂载到活动栏后重新应用显隐设置，防止隐藏图标复现 | `activitybar-visibility.ts` / `plugin-shell.ts` |
| v0.10.43 | feat/refactor | 系统 Prompt 重构：ChatGPT/Claude 提示词现代化 + 四大原则 + 统一工具调用与交互边界 | `src/prompt/*.md` |

### 历史版本记录
- v0.10.42: fix(retry) 发送重试提示词前检查输入框，避免覆盖用户手动输入
- v0.10.41: fix(remote) 手机端切换窗口时显示正在同步提示
- v0.10.40: fix(remote) 手机端切窗口后主动补发新窗口历史
- v0.10.31 ~ v0.10.39: 详见 CHANGELOG.md

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
