# Changelog

> 完整历史按**发布月份**归档在 `changelogs/`，本文件只保留索引与最近 5 个版本。
> **唯一真相源是 `changelogs/YYYY-MM.md`**；发版时把新条目追加到当月文件顶部。
> 查找任意版本：`node scripts/changelog-locate.mjs <版本号>`。

## 版本索引

| 月份 | 版本区间 | 版本数 | 文件 |
|---|---|---|---|
| 2026-11 | 0.10.203 ~ 0.10.251 | 34 | [changelogs/2026-11.md](changelogs/2026-11.md) |
| 2026-10 | 0.8.7 ~ 0.10.202 | 293 | [changelogs/2026-10.md](changelogs/2026-10.md) |
| 2026-09 | 0.2.5-beta.1 ~ 0.8.6 | 24 | [changelogs/2026-09.md](changelogs/2026-09.md) |
| 2026-08 | 1.0.0 ~ 0.2.0 | 2 | [changelogs/2026-08.md](changelogs/2026-08.md) |

## 最近 5 个版本

## [0.10.251] - 2026-11-25

### Added

- **API 窗口 `cuckoo-js` 工具模式**：拒绝原生 `tools` 的上游不再只能纯聊天；模型写 `cuckoo` 代码块，由本地 `JsRunner` 执行 bash/pwsh/read/readLines/write/edit/glob/grep/todoWrite，工具结果回传后继续对话。
- **MCP 接入**：`cuckoo-js` 白名单新增 `mcpListServers`、`mcpGetTools`、`mcpCall`，可查询服务器、读取工具并调用 MCP 工具。
- **Quick 提示词注入**：`quick.md` 新增全局规则、项目规则索引、技能索引、记忆摘要、MCP 章节和工具声明，首条系统提示词不再漏掉这些上下文。

### Changed

- **API 工具模式可切换**：设置里可选 `native` / `cuckoo-js`，模式写入会话快照；已有历史切换模式时新开会话，避免两种协议混用。
- **Quick 会话续接**：`conversation_id` 透传到本地 3000 网关，网关映射默认 24h 持久化，重启后继续同一网页线程。

### Fixed

- **cuckoo-js 图片附件**：网关从最后一条 user 的 `image_url` 提取图片并上传 Quick，不再只发“图片暂不支持”占位。
- **停止未真正停止网页生成**：停止时先调用网关 `/openai/v1/chat/completions/stop` 点网页停止，再中断本地请求。

## [0.10.250] - 2026-11-24

### Changed

- **移除 Claude / ChatGPT 网页平台**：删除 Provider、网络 hook、提示词、图标与专属测试。平台列表只保留 DeepSeek、API Key 和用户自定义 Provider；旧 Claude / ChatGPT 窗口无法再打开。
- **API 会话菜单**：入口移到顶栏左侧、默认收起；`Ctrl+B` 展开/收起，`Ctrl+N` 新建对话，去掉会话项蓝色左边框。

### Fixed

- **API 窗口每次进入都显示“未选择项目目录”**：API 会话快照持久化 `projectDir`，启动优先恢复 active 会话目录，老会话回退全局 `last-project-dir.json`。
- **API 编辑旧消息变成追加**：编辑/重新发送前先截断主进程上下文，删除目标及其后的 assistant/tool，再发送新内容。
- **API 窗口顶栏双竖线**：隐藏网页导航后两个分隔线并排；API 模式只保留靠右那一个。

## [0.10.239] - 2026-11-24

### Changed

- **新建窗口平台选择收敛为 DeepSeek 与 API Key**：Claude / ChatGPT 保留在 Provider 注册表中兼容旧窗口，但不再出现在平台选择页。

### Fixed

- **v0.10.238 安装包启动崩溃 `Cannot find module 'sharp'`**：`sharp` 移入 `dependencies`，electron-builder `asarUnpack` 解包 `sharp` 与 `@img/*` 原生模块；附件模块延迟加载 sharp，缺失时只降级图片物化，不再阻断主进程启动。

## [0.10.238] - 2026-11-24

### Added

- **API Key 直连模式（需求 131）**：新增内置 `api-key` Provider，按窗口隔离 Base URL / Key / 模型；支持 `/chat/completions`、模型列表、原生 `tool_calls` 工具循环、图片/文本附件、用量/TPS 与上下文预算。
- **API 多会话**：左侧常驻会话栏，支持新建、切换、删除与 active 高亮；历史、计划、目标按 profile + session 隔离，旧版单快照自动迁移。

### Fixed

- 图片 400 只按图片相关错误降级当前模型；文本附件纳入上下文预算；Windows `application/octet-stream` 图片按真实 MIME 发送。
- 附件按会话目录独立物化并清理孤儿文件；系统提示词变化按内容指纹重建；API 窗口隐藏网页导航等无效入口。

## [0.10.237] - 2026-11-24

### Fixed

- **开发态 `npm run dev` 下 preload 日志被误静默**：`process.defaultApp` 只在主进程有效，preload 渲染进程里拿不到；改为主进程在非打包态通过 `additionalArguments` 传 `--cuckoo-debug`，preload 读 `process.argv` 保留日志。打包版仍按生产静默。
- **`CUCKOO_DEBUG` 真值判定过窄**：改为大小写归一化，支持 `1` / `true` / `yes` / `on`，避免开发者设置了却仍被静默。
