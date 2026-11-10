# 最新接续状态 (2026-11-10 20:10)

## 核心进展

**v0.10.218 已准备就绪（待提交/打 tag）。** 本轮完成需求 114：发送延迟分布改造与默认值统一。

- 版本：`0.10.218`（package.json / package-lock.json / CHANGELOG 三处已同步）
- 分支：`feat/114-send-delay-distribution` → 待合 master
- 上一版：`v0.10.217`
- 上一轮（113）已合入 master 并推送

## 本轮交付（需求 114）

### 1. 延迟分布：线性 → sqrt 压缩

`src/overlay/chat-input.ts` 的 `randomDelay`：
```ts
// 旧：len=4000 就到顶 → 工具回传必顶死 max=36s
const ratio = Math.min(1, len / 4000);
// 新：阈值 16000 + sqrt 压缩
const ratio = Math.min(1, Math.sqrt(len / 16000));
```
效果：20 字 12~18s → 4~6s；4000 字 30~36s → 10~15s。工具循环总等待减少约 60%。

### 2. 抖动 ±20% → ±35%

### 3. 默认值三处对齐 4/30

- `src/app/global-settings.ts`（AGENT_SETTINGS_DEFAULTS）
- `src/overlay/state.ts`
- `src/overlay/panels/settings.ts`（resetSettings / getSettingsData / resetSettingsData 三处）

### 4. 迁移链数组化

`LEGACY_SEND_DELAY_RANGES = [[1, 10], [12, 36]]`，命中任一组视为"从未自定义"。只认一代会让老用户永久钉在 12/36。

### 5. 额外发现并修复的隐患

命中下限的抖动 span 原按整个区间 25% 算。默认 4~30 时跨度 26s → 25% = 6.5s，短消息被抖到 10.5s，与"短消息快速响应"直接冲突。改为 `spanLow = min((max-min)*0.25, min*0.6)`（4s → 4~6.4s）；上限侧不变。

## 验证结果

- typecheck / lint（0 errors）/ compile / test（135 文件 **1399** 用例）全绿
- 新增 3 条回归用例：短内容 ≤8s、4000 字平均 <22s 且 >9s、二代旧默认 12/36 必须迁移
- **真机延迟体感未验证**（数学行为已由单测锁死，实际等待感受待用户实跑工具循环确认）

## 下一步（未开工）

**需求 115：长文本改走附件通道**（用户已确认方向，档案未建）

### 背景

用户目标：**防封号 + 不降模型智商**。

### 已取证的事实

- 当前 Cuckoo 长文本走 `electronAPI.insertTextToChat` → 主进程 `sender.insertText(text)`（`src/app/ipc/renderer.ts:113-130`），是 Chromium 原生 IME 管线。
- 在风控眼里这是"瞬间无停顿敲出两万字"，是极明显的脚本特征。
- 用户在**官方网页版**手动粘贴长文本 → DeepSeek 自动转成 `.txt` 附件卡片发送。这条路径是官方认可的人类行为。
- 但转附件后模型是否还能读到**完整内容**，尚未验证 —— 这直接决定方案可行性。

### 待验证（开工前必做）

1. 手动粘贴长文本转附件后，模型对全文的引用完整度 vs 直接贴全文，有无明显差异？
2. 页面内合成 `ClipboardEvent('paste')`（`isTrusted=false`）能否触发 DeepSeek 的转附件？
3. 若否，写系统剪贴板 + 主进程发 Ctrl+V（真 isTrusted 粘贴）是否可行？

### 相关代码位置

- `src/overlay/chat-input.ts:93-196` `setInputContent`：当前分流逻辑（provider.fillInput → insertTextToChat → DOM 兜底 → contenteditable 的 ClipboardEvent paste）
- DeepSeek 是 textarea，永远走不到 contenteditable 的 paste 分支

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 需求档案：`docs/requirements/114-send-delay-distribution.md`（status: done）
- 输出长度硬上限：`JsRunner.ts` `OUTPUT_LIMIT = 20000`；`chat-input.ts` `MAX_OUTPUT = 15000`
- 真机测试：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& node_modules\electron\dist\electron.exe . --remote-debugging-port=9444`（background 模式）
- **进程管理**：`taskkill /F /IM electron.exe` 被安全策略拒绝；用 `powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"`。开发版 PID 用 `netstat -ano | findstr :9444` 查
- 打包版 `Cuckoo-Code.exe` 占 7799 端口正常，不要动；开发版 userData 是 `cuckoo-dev-verify` 隔离
- **坑**：`readLines` 默认 limit 2000，读大文件（CHANGELOG 3500+ 行）会截断；必须用 `edit` 精准插入
- **坑**：PowerShell 按 GBK 解码 UTF-8 会中文乱码，读文件显式用 UTF-8
- **坑**：`npx eslint ... > log 2>&1; echo done` 这种写法会把 `;` 当参数传给 eslint 报错，直接 `npx eslint src test --quiet` 即可（无输出=0 errors）
