# 需求索引

> 本文件由 scripts/build-docs-index.mjs 自动生成，请勿手改。
> 新增/更新需求后运行：npm run docs:index

| ID | 类型 | 标题 | 状态 | 分支 | 更新 |
|---|---|---|---|---|---|
| 001 | feature | [窗口地址栏](./001-address-bar.md) | done | feat/address-bar | 2026-09-21 |
| 002 | fix | [AI 回复中断的检测与自动重试](./002-interrupt-retry.md) | done | — | 2026-09-21 |
| 003 | feature | [工具调用执行遮罩](./003-tool-execution-mask.md) | done | feat/003-tool-execution-mask | 2026-09-21 |
| 004 | fix | [看门狗改为 SSE 流静默检测](./004-watchdog-stream-idle.md) | done | fix/004-watchdog-criteria | 2026-09-25 |
| 005 | refactor | [压缩改用「清 IDB + 刷新」获取完整历史](./005-compact-idb-refresh.md) | done | refactor/005-compact-idb-refresh | 2026-09-25 |
| 006 | refactor | [hook 性能优化（消除高频写入与 O(n²)）](./006-hook-perf.md) | done | refactor/006-hook-perf | 2026-09-25 |
| 007 | feature | [工具执行遮罩加「停止」按钮（取消回传）](./007-tool-mask-cancel.md) | done | feat/007-tool-mask-cancel | 2026-09-25 |
| 008 | feature | [启动时恢复最后活跃的窗口](./008-restore-last-window.md) | done | feat/008-restore-last-window | 2026-09-25 |
| 010 | refactor | [换行符处理对齐 dsh（LF 归一化）](./010-eol-normalize.md) | done | refactor/010-eol-normalize | 2026-09-25 |
| 011 | feat | [工具失败日志（仅开发版，长期保留）](./011-tool-error-log.md) | done | feat/011-tool-error-log | 2026-09-25 |
| 012 | feat | [Skill 支持（对齐 Claude Code，纯文件驱动）](./012-skills.md) | done | feat/012-skills | 2026-09-25 |
| 013 | feat | [窗口默认打开（多选）+ 记录大小位置](./013-window-auto-open.md) | done | feat/013-window-auto-open | 2026-09-25 |
| 014 | feat | [地址栏下方显示当前对话 token 量](./014-shell-token-bar.md) | done | feat/014-shell-token-bar | 2026-09-26 |
| 015 | feat | [token 按会话缓存 + 去掉高频轮询（改主进程推送）](./015-token-cache-no-poll.md) | done | feat/015-token-cache-no-poll | 2026-09-26 |
| 016 | feat | [子代理（Subagents，对齐 Claude Code）](./016-subagents.md) | done | feat/016-subagents | 2026-09-26 |
| 017 | feat | [快捷提示词（Snippets）——「提示词」页](./017-snippets.md) | in_progress | feat/017-snippets | 2026-09-29 |
| 018 | feature | [纯净对话模式（Harness 模式，类 Codex 体验）](./018-harness-mode.md) | doing | feat/017-harness-mode | 2026-10-02 |
| 019 | feature | [飞书同步（手机收发对话）](./019-feishu-sync.md) | doing | feat/019-feishu-sync | 2026-09-30 |
| 020 | feature | [插件市场（GitHub topic 自动发现与安装）](./020-plugin-market.md) | review | feat/020-plugin-market | 2026-10-02 |
| 021 | feature | [窗口组（多账号限流轮换）](./021-window-groups.md) | done | feat/021-window-groups | 2026-10-05 |
| 022 | fix | [危险命令检测增强（前缀/通配符/长选项）](./022-dangerous-cmd-bypass.md) | done | fix/022-dangerous-cmd-bypass | 2026-10-06 |
| 022 | feature | [DSH 插件兼容（Cuckoo 里安装/运行 DSH 插件）](./022-dsh-plugin-compat.md) | in_progress | direct-on-master（直接 master 提交） | 2026-10-08 |
| 023 | fix | [edit 编辑混合换行符文件时保留未编辑区域](./023-edit-preserve-eol.md) | done | fix/023-edit-preserve-eol | 2026-10-06 |
| 024 | feature | [记忆系统 + 工作快照](./024-memory-snapshot.md) | draft | feat/024-memory-snapshot | 2026-10-06 |
| 025 | feature | [纯净模式真截断（从某条消息重开新会话）](./025-harness-true-truncate.md) | done | feat/025-harness-true-truncate | 2026-10-12 |
| 026 | feature | [源代码管理面板（Git 暂存/提交/撤销）](./026-git-panel.md) | done | feat/026-git-panel | 2026-10-12 |
| 027 | feature | [记忆功能内置化（从插件改为内置页）](./027-memory-builtin.md) | done | feat/027-memory-builtin | 2026-10-12 |
| 028 | feature | [Git 面板分支支持（显示当前分支 + 切换）](./028-git-branch.md) | doing | feat/028-git-branch | 2026-10-12 |
| 029 | feature | [活动栏图标拖拽排序](./029-activitybar-drag.md) | done | (直接主分支，用户要求) | 2026-10-12 |
| 030 | fix | [自动更新下载进度可见（状态栏进度条）](./030-update-progress.md) | done | (直接主分支，用户要求) | 2026-10-12 |
| 031 | feature | [纯净模式字号缩放（设置项）](./031-harness-font-zoom.md) | done | (直接主分支，用户要求) | 2026-10-12 |
| 032 | fix | [修复窗口偶发空白（缩放/拖宽才恢复）](./032-window-blank-fix.md) | done | (直接主分支，用户要求) | 2026-10-12 |
| 033 | feature | [窗口组切换提示（原因 + 来源→目标 + 结果）](./033-window-switch-notify.md) | done | (直接主分支) | 2026-10-12 |
| 034 | fix | [修复窗口组「转移对话」报错「IndexedDB 无该会话消息」](./034-switch-share-idb.md) | done | (直接主分支) | 2026-10-12 |
| 035 | feature | [Git 面板增强——提交历史 + 自动刷新](./035-git-history-refresh.md) | done | feat/035-git-history-refresh | 2026-10-13 |
| 036 | refactor | [统一项目规则目录到 .agents/rules/](./036-unify-agent-rules.md) | done | refactor/036-unify-agent-rules | 2026-10-13 |
| 037 | feature | [任务运行器（命令 / scripts / AI 后台命令统一管理）](./037-task-runner.md) | done | feat/037-task-runner | 2026-10-13 |
| 038 | feature | [Token 统计按窗口展示今日用量](./038-token-by-window.md) | done | feat/038-token-by-window | 2026-10-13 |

共 38 个需求。
