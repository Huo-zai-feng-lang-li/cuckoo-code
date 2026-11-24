---
id: 131
type: feature
title: API Key / OpenAI 兼容接入（保留网页 Provider 与窗口自动化）
status: implemented
branch: feat/131-api-key-transport
created: 2026-11-24
updated: 2026-11-24
---

# 131 API Key / OpenAI 兼容接入（保留网页 Provider 与窗口自动化）

- 状态：本地实现完成（未推送）；按 profile 隔离配置、系统提示词、token 预算、附件、usage/tps、原生 `tool_calls`、API 会话快照恢复、历史 UI 回填、模型列表自动获取/搜索/默认第一、关闭设置弹窗自动保存均已落地。剩余：独立 capabilities 模块。
- 日期：2026-11-24
- 目标版本：`0.10.238`（本版本包含 API 会话列表与多会话管理）
- 前置：无；与 129/130 的网页反检测线解耦

## 背景

用户当前主要使用 Cuckoo 的网页版 Provider（DeepSeek / Claude / ChatGPT），
窗口自动化、DeepSeek 网页 SSE 解析、overlay、hook 都依赖 AI 网页。

DeepSeek 网页账号出现“违反用户协议禁言”，仅靠环境伪装、拟人化、控制台降噪
无法消除账号级处罚。用户已有两类本地 OpenAI 兼容网关：

- 手机端 Agnes 反代网关：`http://192.168.110.212:8080/v1`（手机换网后 IP 从 `.49` 变更）
- 本机 `cuko-api-quick`：`http://127.0.0.1:3000/openai/v1`

两者都能返回标准 OpenAI Chat Completions，并支持原生 `tool_calls`。
当前 Cuckoo 237 只有网页 Provider，主对话无法直接填 API Key；
`prompt-enhancer.ts` 虽然支持 OpenAI 兼容 API，但只用于提示词增强，
不是主对话 / Agent 通道。

本需求要新增一个**独立、可选、叠加上去的 API Key transport**，
不替换、不修改现有网页 Provider、窗口自动化和网页 SSE 解析。

## 目标

1. 平台列表新增 `API Key / OpenAI 兼容` 入口，与网页平台并列。
2. 支持 `POST {baseUrl}/chat/completions`；`GET {baseUrl}/models` 仅用于兼容性实测，不在主对话 UI 强制调用。
3. 支持非流式与 SSE 流式；解析标准 OpenAI `data:` 帧和 `[DONE]`。
4. API Key 可选：本地无鉴权网关可留空；有鉴权服务填 Bearer Key。
5. API 模式只创建 harness 会话，不创建 AI 网页 `WebContentsView`。
6. 把 API 流映射成 harness 现有事件：
   `stream` / `assistant-done` / `retry-state` / `task-idle` / `send-result`。
7. 网页 Provider、网页窗口自动化、`src/providers/**`、`src/bridge/**`、
   `src/overlay/**`、129/130 的指纹与日志修复全部保持原样。
8. 工具调用分阶段：先纯文本，再接原生 `tool_calls` 与现有工具注册表。

## 非目标

- 不把 Cuckoo 改成纯 API 客户端，不删除网页版。
- 不在网页 Provider 里硬塞 API Key 字段；两套 transport 分开。
- 不做 API 失败后静默切网页版的自动回退。
- 不承诺任何平台“绝不封号”；API 只改变通道，不改变平台规则。
- 附件/多模态已接入；子代理、窗口组完整对齐仍不做。
- 不修改 237 的 preload 控制台过滤与 UA-CH 修复。

## 方案

### 1. 模块边界

新增：

```text
src/api-transport/
  config.ts          # baseUrl / apiKey / model / enabled；Key 只在主进程
  client.ts          # fetch、abort、超时、429/5xx 分类
  sse.ts             # 标准 OpenAI SSE 解析（与网页 hook 的 SSE 无关）
  runtime.ts         # 会话状态、请求队列、停止、重试、harness 事件适配（未单独拆 harness-adapter）
  tool-loop.ts       # 原生 tool_calls ↔ Cuckoo 工具
```

小改：

- `src/app/entry.ts`：平台入口与 API 会话创建分支
- `src/app/ipc/harness.ts`：`harness-send` / `harness-stop` 的 API 分支
- `src/app/ui-prefs.ts`：API 配置持久化
- `src/ui/harness.html`：API 平台卡片 / 配置入口（尽量少改）

明确不动：

- `src/providers/**`
- `src/providers/hooks/**`
- `src/bridge/**`
- `src/overlay/**`
- `src/app/bridge-args.ts`、`src/bridge/console-filter*.ts`

### 2. Transport 语义

- 网页 transport：保留现有 WebContentsView、DOM/网络拦截、拟人化等待。
- API transport：不打开 AI 网页；直接 HTTP 请求。
- API 模式不做拟人鼠标/键盘/随机停顿；只做请求节奏控制。
- API 默认并发 1、用户停止立即 abort、单次请求总超时 5 分钟。
- 429/5xx 退避：默认 2 次重试，基础间隔 2s / 5s（±20% 抖动），
  429 若带 `Retry-After` 优先使用；不做无限重试。
- API Key 为空时不发 `Authorization`；有 Key 时发 `Bearer <key>`。
- Key 由 Electron `safeStorage` 加密落盘；`ui-prefs` 回传渲染进程时只给
  `hasApiKey` 占位，不把明文回填 harness 页面，也不进仓库或错误提示。

### 3. Harness 事件映射

| API 事件 | harness 事件 |
|---|---|
| SSE `delta.content` | `{ type: 'stream', text, think: '' }` |
| SSE `delta.reasoning_content`（若存在） | `stream.think` |
| 回合结束 | `{ type: 'assistant-done', text, hasTool }` |
| 429/5xx 退避 | `{ type: 'retry-state', state, delayMs, is429, count }` |
| 无工具且收尾 | `{ type: 'task-idle' }` |
| 发送回执 | `{ type: 'send-result', requestId, success, error, code }` |

`code` 用于区分 `stopped` / `rounds_limit` / `tools_disabled` /
`not_configured` / `request_failed` / `empty`：已入队后的失败不回填草稿，
避免重发造成重复用户消息或重复工具副作用。

`harness-send` 在 API 模式下不再要求 `ctx.view`；`harness-stop` 直接 abort。
现有 `harness-event-report` 只服务网页 bridge，不改。

### 4. 工具调用（已实现，待用户实测）

已实测两个网关都支持原生 `tool_calls`，因此优先用原生协议，不把
网页版的 `cuckoo` 代码块协议硬搬到 API：

1. 把 Cuckoo 工具注册表转换成 OpenAI `tools`（function name/description/parameters）。
2. API 返回 `finish_reason=tool_calls` → 解析 `tool_calls[]` → 执行现有工具。
3. 把 `{ role: 'tool', tool_call_id, content }` 回传 API，循环直到无工具。
4. 最大轮数默认 12（可在窗口右上角「API 设置」或「增强设置 → 主对话 API 接入」调 1~20），用户停止同时中止请求并杀掉窗口前台工具进程。
5. 工具执行构造内部 IPC event 走现有 `guardExecutionCall`，来源校验 / workspace 信任 / 弹窗确认全部保留，不绕过权限闸。
6. 模型是否可见工具由「允许工具调用」开关控制（默认开）；关闭后请求不发送 `tools`。

### 4.1 API 窗口 UI 裁剪

API 模式没有真实 AI 网页，窗口壳与 harness 分别收口：

- 壳页面：`body.ck-api-mode` 隐藏后退/前进/刷新/地址栏/外部打开/网页模式入口，
  由 `shell-api-mode` 事件与 `shell-get-api-mode` 初始查询双通道驱动。
- Harness：API 模式隐藏「网页模式」按钮；附件入口始终保留，关闭图片输入只过滤图片，文本附件仍可发送；图片在发送前按真实 MIME 压缩为 data URL，
  文本附件按文本注入；空态改为 API 说明；保留新建对话、项目选择、API 设置。
- API 模式强制保持 harness，不允许切回无 bridge 的占位网页。
- 纯网页 Provider 不设置 `ck-api-mode`，浏览器栏与网页功能保持原样。

工具事件已接入；`hasTool` 由「允许工具调用」开关与工具注册表共同决定。

### 5. 兼容性实测（2026-11-24）

测试对象：

- 手机 Agnes：`http://192.168.110.212:8080/v1`，模型 `agnes-3.0-flash`（原 `.49` 已随手机换网失效）
- 本机 Quick：`http://127.0.0.1:3000/openai/v1`，模型 `aws`

结果：

| 检查项 | 手机 Agnes | 本机 Quick |
|---|---|---|
| `/models` | 200，13 个模型，含目标模型 | 200，1 个模型 `aws` |
| 非流式 chat | 返回 `OK`，usage 正常 | 返回 `OK`，usage 正常 |
| SSE 流式 | 4 个事件，`finish_reason=stop`，`[DONE]` | 3 个事件，`finish_reason=stop`，`[DONE]` |
| 工具链 | 4 轮 / 3 次调用：`lookup_user` → `list_orders` → `make_report` | 4 轮 / 3 次调用：同名三步 |
| 工具参数 | JSON 合法，`u-1001` / `o-1,o-2` 正确 | 相同 |
| 多轮上下文 | 追问“哪个用户”回答 `u-1001` | 相同 |
| `tool_calls` 形状 | 标准 `id/type/function.name/arguments` | 标准同形 |

额外验证：

- Cuckoo 现有 `prompt-enhancer.ts` 用 `cfgOverride` 指向手机网关，
  `agnes-3.0-flash` 增强成功并返回文本，证明现有 API 调用代码可通。
- 两个网关都返回标准 OpenAI Chat Completions；差异仅在额外 metadata/usage 字段，
  不影响客户端按标准字段解析。

### 5.1 本机应用级验证（2026-11-24）

在 `npm run dev` 的真实 Electron 窗口里验证（非单测 / 非脚本模拟）：

- API 窗口 provider=`api-key`，URL=`about:blank#cuckoo-api`；不创建 AI 网页。
- 顶栏「API 设置」打开后，配置块位于设置弹窗最上方，字段可读写：
  Base URL=`http://192.168.110.212:8080/v1`、Key 空、模型=`agnes-3.0-flash`、
  允许工具调用=`true`、最大工具轮数=`12`。
- 点顶栏「新建对话」后 harness 流清空，日志无 `initial-prompt` / `framework-preparing`，
  不再卡在“系统提示词准备中”；启动自动恢复 API 窗口同样不注入 initial-prompt。
- 发送“必须用 read 工具读取 package.json”后，harness 显示 `read` 工具卡片，
  实际读取 20 行，模型最终回答 `name`=`cuckoo-code`；工具执行走现有权限闸。
- 全量 `npm test`：167 文件 / 1652 用例通过；typecheck、compile 通过；lint 0 error（75 条历史 warning）。
  注：当前 PowerShell 工具会话 PATH 缺少 `System32` 时，`run-captured` 的 `taskkill` 用例会误报；
  补回 `C:\Windows\System32` 后复跑通过，应用启动也需同样补 PATH。
- 审计修复：停止/抢占补齐缺失 tool 结果；API Key safeStorage 加密且不回填 DOM；
  关窗 dispose 会话；请求总超时 5 分钟；429/5xx 重试状态回传；API 失败 codes 防重复草稿；
  API 模式首次必须选项目目录；窗口组空列表保护。

### 5.2 审计后加固补充（2026-11-23）

- 停止/抢占后立刻新建对话：旧 turn 未收尾时先标记 `pendingReset`，等 finally 统一清空，
  防止旧 turn 把 tool 结果留进新历史（新增 runtime 单测覆盖）。
- API 模式“用该项目新建对话”写入 `selectedProjectDir` 后必须 `pushHarnessState`：
  否则页面仍停在“首次对话需选择项目目录”，初始化按钮不消失、输入框不恢复
  （新增 new-conversation 源码契约测试；真机用强制 stale UI + 新建对话复验）。
- `harness-send` 的 IPC 返回值补齐 `code`；`send-result` 事件也带 `code`，
  harness 对 `stopped` / `rounds_limit` / `tools_disabled` / `request_failed`
  不回填草稿，只有 `not_configured` / `empty` 才回填。
- API 模式壳侧导航 IPC 也拒绝 `shell-navigate` / `shell-back` / `shell-forward` /
  `shell-reload` / `shell-home` / `web-navigate-session`，不依赖 UI 隐藏。
- API 模式 `addFiles()` 接受图片与文本附件，PDF/Office 明确拒绝；图片按 vision 开关与 8 张上限物化，
  不写入网页附件通道；`buildOpenAiTools()` 不向模型暴露 `attachFile` / `runAgent` / `runAgents`
  （API 模式没有可驱动的网页子代理链路），即使模型幻觉出这些工具也会被 `executeApiToolCall()` 拒绝。
- 配置错误提示从“增强设置”统一改为“API 设置”，避免文档与 UI 入口不一致。

### 6. 实施顺序

1. 配置 + `client` + `sse` + 单测（不接 UI）。
2. `api-transport` runtime 接 harness，纯文本 / 停止 / 错误 / 重试。
3. 平台入口与 API 会话创建；网页 Profile 不受影响。
4. 全量网页回归 + 现有 162 文件 1608 用例全绿。
5. 原生 `tool_calls` + 现有工具注册表 + 权限闸（已实现并实测）。
6. 最后再评估附件、多模态、子代理、窗口组。

## 验收标准

### 纯文本

- API 平台可选，网页平台仍可正常创建与使用。
- API 平台发消息后，harness 流式显示；停止在 2 秒内生效。
- 429/5xx 显示重试状态并遵守退避；401/403 显示明确错误，不自动换账号。
- Key 留空时无 `Authorization` 头；填 Key 时只由主进程发出。
- API 错误不会污染网页 Provider 的事件流。

### 工具

- 原生 `tool_calls` 能驱动现有工具至少 3 轮，参数与结果正确回传。
- 工具执行中停止，不继续回传；无重复气泡、无并发重复执行。
- 工具权限闸、项目目录、`windowId` 与网页版一致。

### 回归

- `npm test` 全量通过（当前基线 162 文件 1608 用例）。
- typecheck / lint（0 error）/ compile 通过。
- 网页 DeepSeek 会话：发送、SSE、停止、工具调用、harness 全部不退化。
- `src/providers/**`、`src/bridge/**`、`src/overlay/**` 无行为变更。

## 遗留

- 代码已实现（本地未推送）；纯文本 + 工具调用待用户实测后再提交/推送。
- 手机网关是局域网无鉴权服务，不能把 host 暴露到公网；本机 Quick 同样无鉴权。
- Quick 网关依赖 Chrome/Quick 页面，登录态、页面结构和队列会影响 API 时延；
  API transport 需要把 401/503/429 分类透传，不能一律当网络错误。
- 原生 `tool_calls` 与 Cuckoo 现有工具 schema 的映射需要单独设计；
  不能直接把网页版 `cuckoo` 代码块协议混进 OpenAI tools。
- 附件/多模态已接入；子代理、窗口组、计费/额度展示仍未纳入。

## 2026-11-24 UI 验收补充

- 多会话：左侧常驻会话栏，支持新建、切换、删除、active 高亮；顶部“会话”按钮仅收起/展开。
- token：只保留壳层右下角状态条，API 顶栏不再重复显示。
- API 设置：两列表单 label 顶对齐、输入框底对齐，模型触发器与相邻输入框同高。
- 交互：顶栏/会话项不显示原生 hover tooltip；会话行 hover 有整行高亮，删除使用垃圾桶图标和危险色 hover。
- 配置默认：上下文窗口留空 131072、最大输出留空 8192、最大工具轮数留空 64；保存时分别夹在 8192–2097152、256–32768、1–500。
