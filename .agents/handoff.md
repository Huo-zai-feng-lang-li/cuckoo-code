# 最新接续状态 (2026-11-10 15:40)

## 核心进展

**v0.10.216 已发布。** 本轮修了 4 类问题：截断自救、幽灵发送、并发被覆盖、默认延迟上调。

- 版本：`0.10.216`
- 分支：`master`
- 上一版：`v0.10.215`

## 本轮交付的 4 项改动

### 1. 截断自救（防模型降质）
- `src/tools/runtime/JsRunner.ts`：截断处（`OUTPUT_LIMIT = 20000`）追加警告语，禁止 AI 盲目重试全量。
- `src/overlay/chat-input.ts`：截断处（`MAX_OUTPUT = 15000`）同步追加相同警告语。
- 四个 prompt 文件（default/deepseek/claude/chatgpt）：在「本地数据前置精炼」下新增**截断自救强制纪律**。

### 2. 幽灵发送（纯净模式草稿被吃掉）
- **真凶**：`findInputArea()` 的兜底逻辑按 `document.querySelectorAll('textarea')` 抓第一个可见 textarea，纯净模式的 `<textarea id="input">` 也在 DOM 里 → 工具结果被填进用户草稿框并触发发送。
- **修法**：`src/overlay/chat-input.ts` 的 `findInputArea` 过滤 `id === 'input'` 与占位符含「输入消息」的 textarea；contenteditable 同样过滤。

### 3. 子代理并发被改回 3
- **真凶**：壳页面 `collectSettings()` 用 `parseInt(...) || 0`，空值变 0 提交，主进程 `toConcurrency(0, 3)` 兜底成默认 3。
- **修法**：`src/ui/shell/scripts/pages/settings.ts` 全字段改为「空值返回 undefined」，不再提交空 delta。

### 4. 默认发送延迟 6-36 → 12-36
- `src/overlay/state.ts`：`sendDelayMin: 6000 → 12000`
- `src/app/global-settings.ts`：`sendDelayMin: 6 → 12`
- `src/overlay/panels/settings.ts`：重置逻辑 + 读取兜底同步
- 测试断言同步：`test/app/global-settings.test.js`、`test/overlay/extra.test.js`

## 验证

- typecheck / lint(0 errors) / test(135 文件 1395 用例) / compile 全绿。
- **待用户真机确认三项**：
  - 纯净模式输入框打草稿不点发送，跑工具回传，看草稿是否还在
  - 设置里延迟默认值是否为 12-36
  - 子代理并发数是否保持用户设定值不被覆盖

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 当前分支：`master`
- 版本：`0.10.216`
- 输出长度硬上限：`JsRunner.ts` 的 `OUTPUT_LIMIT = 20000`；`chat-input.ts` 的 `MAX_OUTPUT = 15000`
- 真机测试：`$env:CUCKOO_SESSION_DIR='cuckoo-dev-verify'; Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.','--remote-debugging-port=9444'`
- 打包版 `Cuckoo-Code.exe` 占 7799 端口正常，不要 kill；开发版用 `cuckoo-dev-verify` userData 隔离
- 已知坑：PowerShell 按 GBK 解码 UTF-8 会导致中文乱码，读文件显式用 UTF-8
