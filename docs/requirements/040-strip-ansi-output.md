---
id: 040
type: fix
title: 任务输出剥离 ANSI 控制码
status: done
branch: fix/040-strip-ansi-output
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

任务页跑 `npm test` / `vitest` 等彩色输出的命令时，输出里显示 `[90m`、`[2m`、`[22m` 等"乱码"。

## 根因

实为 **ANSI 转义序列**（原文 `\x1b[90m`，ESC 不可见字符被吞后只剩 `[90m`），**非 GBK/UTF-8 编码问题**。`decodeOutput` 只做编码解码，不剥控制码，项目也无 `strip-ansi` 依赖。探测证实 vitest 输出字节流首个 ESC 在第 1 字节，含 `\u001b[1m\u001b[30m\u001b[46m RUN`。

## 修复

`src/infra/decode-output.ts` 新增 `stripAnsi()`，剥离三类 ANSI 转义序列：
- **CSI**：`\x1b[ + 参数字节 + 终止字母`（颜色/光标）
- **OSC**：`\x1b] + 内容 + BEL/ST`（设窗口标题）
- **单字符转义**：`\x1b + 单字符`

`decodeOutput()` 统一调用（UTF-8 与 GBK 分支都走）→ 任务页输出 / bash / pwsh 工具 / 命令 IPC 全部受益。

## 验收

- 构造 `\x1b[90m hi \x1b[0m` → 任务输出 = `hi`，无 ESC、无 `[90m` ✓
- 16 个单测全过（含真实 vitest 片段、GBK 分支）✓
