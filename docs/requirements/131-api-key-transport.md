---
id: 131
type: feature
title: API Key / OpenAI 兼容接入（保留网页 Provider 与窗口自动化）
status: draft
branch: feat/131-api-key-transport
created: 2026-11-24
updated: 2026-11-24
---

# 131 API Key / OpenAI 兼容接入（保留网页 Provider 与窗口自动化）

- 状态：需求建档 + 兼容性实测完成；代码未实现
- 日期：2026-11-24
- 目标版本：TBD（当前 0.10.237 不包含本需求）
- 前置：无；与 129/130 的网页反检测线解耦

## 背景

用户当前主要使用 Cuckoo 的网页版 Provider（DeepSeek / Claude / ChatGPT），
窗口自动化、DeepSeek 网页 SSE 解析、overlay、hook 都依赖 AI 网页。

DeepSeek 网页账号出现“违反用户协议禁言”，仅靠环境伪装、拟人化、控制台降噪
无法消除账号级处罚。用户已有两类本地 OpenAI 兼容网关：

- 手机端 Agnes 反代网关：`http://192.168.110.49:8080/v1`
- 本机 `cuko-api-quick`：`http://127.0.0.1:3000/openai/v1`

两者都能返回标准 OpenAI Chat Completions，并支持原生 `tool_calls`。
当前 Cuckoo 237 只有网页 Provider，主对话无法直接填 API Key；
`prompt-enhancer.ts` 虽然支持 OpenAI 兼容 API，但只用于提示词增强，
不是主对话 / Agent 通道。

本需求要新增一个**独立、可选、叠加上去的 API Key transport**，
不替换、不修改现有网页 Provider、窗口自动化和网页 SSE 解析。

## 目标

1. 平台列表新增 `API Key / OpenAI 兼容` 入口，与网页平台并列。
2. 支持 `GET {baseUrl}/models` 与 `POST {baseUrl}/chat/completions`。
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
- 第一版不做附件、多模态、子代理、窗口组完整对齐。
- 不修改 237 的 preload 控制台过滤与 UA-CH 修复。

## 方案

### 1. 模块边界

新增：

```text
src/api-transport/
  config.ts          # baseUrl / apiKey / model / enabled；Key 只在主进程
  client.ts          # fetch、abort、超时、429/5xx 分类
  sse.ts             # 标准 OpenAI SSE 解析（与网页 hook 的 SSE 无关）
  runtime.ts         # 会话状态、请求队列、停止、重试
  harness-adapter.ts # 转 harness-event
  tool-loop.ts       # 第二阶段：原生 tool_calls ↔ Cuckoo 工具
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
- API 默认并发 1、请求间隔 1–2 秒、429/5xx 指数退避 2/5/10 秒加抖动、
  重试上限 3、用户停止立即 abort。
- API Key 为空时不发 `Authorization`；有 Key 时发 `Bearer <key>`。
- Key 优先用 Electron `safeStorage` 加密；至少不得进入 harness 页面、
  渲染日志、仓库或错误提示。

### 3. Harness 事件映射

| API 事件 | harness 事件 |
|---|---|
| SSE `delta.content` | `{ type: 'stream', text, think: '' }` |
| SSE `delta.reasoning_content`（若存在） | `stream.think` |
| 回合结束 | `{ type: 'assistant-done', text, hasTool }` |
| 429/5xx 退避 | `{ type: 'retry-state', state, delayMs, is429, count }` |
| 无工具且收尾 | `{ type: 'task-idle' }` |
| 发送回执 | `{ type: 'send-result', requestId, success, error }` |

`harness-send` 在 API 模式下不再要求 `ctx.view`；`harness-stop` 直接 abort。
现有 `harness-event-report` 只服务网页 bridge，不改。

### 4. 工具调用（第二阶段）

已实测两个网关都支持原生 `tool_calls`，因此优先用原生协议，不把
网页版的 `cuckoo` 代码块协议硬搬到 API：

1. 把 Cuckoo 工具注册表转换成 OpenAI `tools`（function name/description/parameters）。
2. API 返回 `finish_reason=tool_calls` → 解析 `tool_calls[]` → 执行现有工具。
3. 把 `{ role: 'tool', tool_call_id, content }` 回传 API，循环直到无工具。
4. 设最大轮数（建议 12）与总超时；用户停止要同时中止请求和工具回传。
5. 工具执行必须继续走现有权限闸 / `ctx` 项目目录，不得因为 API transport 绕过。

第一版纯文本上线时，工具事件可以不上；但 `hasTool` 必须正确为 false，
避免 harness 状态栏误判。

### 5. 兼容性实测（2026-11-24）

测试对象：

- 手机 Agnes：`http://192.168.110.49:8080/v1`，模型 `agnes-3.0-flash`
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

### 6. 实施顺序

1. 配置 + `client` + `sse` + 单测（不接 UI）。
2. `api-transport` runtime 接 harness，纯文本 / 停止 / 错误 / 重试。
3. 平台入口与 API 会话创建；网页 Profile 不受影响。
4. 全量网页回归 + 现有 1569 用例全绿。
5. 第二阶段原生 `tool_calls` + 现有工具注册表 + 权限闸。
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

- `npm test` 全量通过（当前基线 155 文件 1569 用例）。
- typecheck / lint（0 error）/ compile 通过。
- 网页 DeepSeek 会话：发送、SSE、停止、工具调用、harness 全部不退化。
- `src/providers/**`、`src/bridge/**`、`src/overlay/**` 无行为变更。

## 遗留

- 代码尚未实现；本文件只完成需求与兼容性取证。
- 手机网关是局域网无鉴权服务，不能把 host 暴露到公网；本机 Quick 同样无鉴权。
- Quick 网关依赖 Chrome/Quick 页面，登录态、页面结构和队列会影响 API 时延；
  API transport 需要把 401/503/429 分类透传，不能一律当网络错误。
- 原生 `tool_calls` 与 Cuckoo 现有工具 schema 的映射需要单独设计；
  不能直接把网页版 `cuckoo` 代码块协议混进 OpenAI tools。
- 附件/多模态、子代理、窗口组、计费/额度展示未纳入第一版。
