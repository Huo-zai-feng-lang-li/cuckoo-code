# 最新接续状态 (2026-11-10 20:40)

## 核心进展

**v0.10.218 已发布**（需求 114 完成）。**需求 115 已建档案，未开工**，等待新对话接手。

- 当前分支：`fix/115-long-text-attachment`（从 master 新建，无改动）
- 当前版本：`0.10.218`
- 上一版：`v0.10.217`

## 已完成：需求 114（v0.10.218）

发送延迟分布改造与默认值统一。详见 `docs/requirements/114-send-delay-distribution.md`。

- 延迟分布 `min(1, len/4000)` → `min(1, sqrt(len/16000))`，工具循环等待减少约 60%
- 抖动 ±20% → ±35%
- 默认值 12/36 → 4/30，三处对齐
- 迁移链数组化，兼容 1/10 与 12/36 两代旧默认
- 额外修正：命中下限的抖动 span 改用 min 自身比例

验证：typecheck / lint(0 errors) / compile / test(135 文件 1399 用例) 全绿。真机体感未验证。

## 待开工：需求 115（长文本改走附件通道）

**档案：`docs/requirements/115-long-text-attachment.md`（已写详尽，含验证步骤与代码索引，接手先完整读它）**

### 一句话目标

用户要**防封号 + 不降模型智商**。当前 Cuckoo 用 `sender.insertText` 一次性"敲"两万字进 textarea，风控眼里是教科书级脚本特征。人类路径是粘贴 → DeepSeek 自动转 `.txt` 附件。

### 最重要的一条发现（省得重新调查）

**项目里已有成熟附件上传通道：`src/app/ipc/cdp-attach.ts` 的 `cdpAttach()`。**
全程无合成事件（CDP 真实鼠标点击 + `Page.setInterceptFileChooserDialog` + `DOM.setFileInputFiles`），已服务于 `harness-attach` IPC 和 `attachFile` 工具。

**不用新造剪贴板方案**，直接复用它。

### 开工前必须先做 3 条验证（阻塞项，档案第三章有细节）

1. **DeepSeek 上传入口能否被 `genericAttachProbe` 探测到**（DeepSeek 没实现 `getAttachProbeSource`，走通用关键词兜底，可能命中不了）
2. **`cdpAttach` 能否真的把 .txt 塞进 DeepSeek 输入区**
3. **最关键：模型能否读全附件内容** —— 上传一个 8000 字符 .txt，问"第 6000~6100 字符写了什么，请原样引用"。读不全 → **方案作废**（踩"不降智商"红线）

### 实现要点（验证通过后）

- 新增 IPC `chat-send-as-file`（主进程收文本 → base64 → 调 `cdpAttach`）
- `src/bridge/api.ts` 暴露 `sendAsFile`
- `src/overlay/chat-input.ts` 的 `setInputContent` 前分流：超阈值（初值 4000）走附件，否则维持原样
- 附件后跟一句短提示词（如"请阅读附件中的工具输出"），让模型知道要读
- 任何环节失败 → 静默回退 `insertTextToChat`

### 关键代码位置

| 用途 | 路径 |
|---|---|
| 当前注入分流 | `src/overlay/chat-input.ts` `setInputContent` L93-196 |
| 原生 insertText IPC | `src/app/ipc/renderer.ts` `chat-insert-text` L113-130 |
| 附件上传主流程 | `src/app/ipc/cdp-attach.ts` `cdpAttach` L28-256 |
| 通用入口探测 | `src/app/ipc/cdp-attach.ts` `genericAttachProbe` L263-306 |
| 附件 IPC 现有入口 | `src/app/ipc/harness.ts` `harness-attach` L539-576 |
| Provider 钩子定义 | `src/providers/types.ts` `getAttachProbeSource` L80-88 |

### 本需求只做 DeepSeek

ChatGPT / Claude 对 paste 与附件处理不同，保持现状，后续单独处理。

## 关于 114 的一点保留意见（供后续决策参考）

114 把延迟下限从 12s 降到 4s，理论上**提高了请求频率**（20 轮工具循环从 10 分钟压到约 4 分钟）。这与"防封号"目标存在潜在张力。

档案里的论证（"恒定慢本身也是机器特征"）逻辑成立但无实证。若用户反馈出现异常（限流、验证码、账号异常），**优先考虑把下限从 4s 提到 6~8s**，保留 sqrt 分布——主要收益（长文本不再贴死上限）不会丢。

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 当前分支：`fix/115-long-text-attachment`（无改动）
- 输出长度硬上限：`JsRunner.ts` `OUTPUT_LIMIT = 20000`；`chat-input.ts` `MAX_OUTPUT = 15000`
- 真机测试：`set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& node_modules\electron\dist\electron.exe . --remote-debugging-port=9444`（background 模式）
- **进程管理**：`taskkill /F /IM electron.exe` 被安全策略拒绝；用 `powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"`。开发版 PID 用 `netstat -ano | findstr :9444` 查
- 打包版 `Cuckoo-Code.exe` 占 7799 端口正常，不要动；开发版 userData 是 `cuckoo-dev-verify` 隔离
- **坑**：`readLines` 默认 limit 2000，读大文件（CHANGELOG 3500+ 行）会截断；必须用 `edit` 精准插入
- **坑**：PowerShell 按 GBK 解码 UTF-8 会中文乱码，读文件显式用 UTF-8
- **坑**：`npx eslint src test --quiet` 无输出 = 0 errors。不要在命令后加 `; echo done`（会把 `;` 当参数传给 eslint）
- **坑**：`cdpAttach` 内部 `wc.debugger.attach()`，若 debugger 已被占用会返回 `debugger-busy`

## 版本号提醒

- 当前 0.10.218。下一版 0.10.219，再下一个 0.10.220（均不含数字 4，可直接用）。
- 版本号禁止含数字 4（任意位置），遇到就跳过。
- 打 tag 前必须汇总 CHANGELOG（Keep a Changelog 格式），三处版本号同步。

## 提交纪律提醒

- 115 开工前先读 `.agents/rules/README.md` 与命中的专项规则
- 改运行时行为（IPC / hook / 工具 / UI）→ 必须真机 `npm start` 验证
