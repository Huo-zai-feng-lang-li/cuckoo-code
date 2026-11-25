# Cuckoo Code 接入 AWS Quick：cuckoo-js 工具模式计划（v2）

> 复核结论：当前代码已经是 `v0.10.250`，工作区里的 Claude / ChatGPT provider 移除已经提交，Cuckoo Code 只剩计划文档和 `harness-inline.js` 未跟踪。API 会话新增了“每个会话绑定项目目录”和“编辑旧消息物理截断”，这两点会直接影响 cuckoo-js 的实现，计划已按当前代码修正。

## 当前基线（重新阅读后）

- `cuckoo-code`：`HEAD = 379f5a1`，`v0.10.250` 已合并；`deepseek + api-key` 是仅有的内置 provider；Claude / ChatGPT 已删除。
- `cuckoo-code` 工作区：只有 `.agents/plan-Quick-cuckoo-js模式.md` 和 `.agents/harness-inline.js` 未跟踪；无源码未提交改动。
- `src/api-transport/runtime.ts`：785 行；`SessionState` 已新增 `projectDir`；`persist` 会把项目目录写进会话快照。
- `src/api-transport/session-store.ts`：会话快照/索引已新增 `projectDir`；新增 `setApiSessionProjectDir`；`truncateApiHistory` 会按 user 消息从末尾截断。
- `src/api-transport/context.ts`：`splitTurns` 把每条 `role=user` 都当成新轮次起点。
- `src/api-transport/system-prompt.ts`：仍只有 native 的 `buildApiSystemPrompt`，未接入 cuckoo-js。
- `src/app/ui-prefs.ts`：`ApiConnectionPrefs` 仍没有 `toolMode`。
- `src/api-transport/client.ts`：仍没有 `conversationId`，请求体只发 `model/messages/stream` 等字段。
- `src/ui/harness.html`：API 设置表单仍没有“工具调用方式”字段。
- `cuko-api-quick`：`MAX_PROMPT_CHARS = 32000`；`formatTranscript` 超限时保留**头 12000 字符 + 尾 16000 字符**，不是简单截 32000；`formatChatPrompt` 最后再 `clip` 到 32000。
- `cuko-api-quick`：`chatSessionKey` 已支持 `conversation_id` / `x-session-id` / `x-conversation-id`。
- 测试基线：Cuckoo Code 目标用例 `28 pass`（runtime/session-store/system-prompt）；`cuko-api-quick` 全量 `178 pass / 0 fail`。

## 目标

1. Quick 能完成多轮工具调用：读文件、改文件、执行命令、看结果、继续。
2. 现有 native API 客户端行为完全不变。
3. 现有 DeepSeek 网页模式行为完全不变。
4. `cuko-api-quick` 不改协议；它只收到普通 Chat，不带 tools。
5. 每个 API 窗口独立配置、独立会话；cuckoo-js 与 native 不混历史。
6. 兼容当前 `v0.10.250` 的“项目目录按会话绑定”和“编辑旧消息截断”两个新功能。

## 非目标

- 不做 Quick 的网页 provider；不把 Quick 网页嵌进 Cuckoo Code。
- 不改 `src/bridge/*`、`src/overlay/*`、`src/providers/deepseek.ts`。
- 不改 `cuko-api-quick` 的 OpenAI / Cuko 入口。
- 第一版不开放 `runAgent`、`runAgents`、`attachFile`、`openBrowserWindow`。
- 不做通用网页适配器；网页适配仍是站点专用。

## 架构

```text
Cuckoo Code API 窗口 (profile, toolMode=cuckoo-js)
  → streamChat(messages, tools=[])
  → 解析 ```cuckoo ... ``` 代码块
  → executeCuckooJs（guard + JsRunner）
  → 工具结果作为内部 user 消息追加
  → 再请求 Quick
  → 直到没有代码块，输出最终回答
```

与现有 native 路径并列：

```text
toolMode=native    → 现有 tool_calls 循环，原样保留
toolMode=cuckoo-js → 新分支，纯 Chat + 代码块
```

## 窗口与配置

| 窗口 | Provider | 配置 |
|---|---|---|
| DeepSeek | 内置 `deepseek` | 保持网页模式，不动 |
| AWS Quick | 自定义 API / `api-key` | `baseUrl=http://127.0.0.1:3000/openai/v1`、`model=aws`、`toolMode=cuckoo-js` |

- 只建一个 AWS 窗口；`aws / aws-2` 由 3000 账号池轮换，不需要建两个窗口。
- 不使用 Cuckoo Code 的“窗口组”跑 AWS；窗口组用于共享对话/多账号轮换，和 3000 的池会重复。
- `toolMode` 按 profile 保存，默认 `native`；AWS 窗口显式设为 `cuckoo-js`。

建议初始参数：

```text
工具调用方式：cuckoo-js
允许工具调用：开
最大工具轮数：64（先用 32 也可）
上下文窗口：65536
最大输出 tokens：8192
图片输入：关
推理强度：auto
usage 统计：auto
```

## 代码改动点（按当前代码修正）

| 文件 | 改动 |
|---|---|
| `src/app/ui-prefs.ts` | `ApiConnectionPrefs` 增加 `toolMode: 'native' \| 'cuckoo-js'`；默认 `native`；非法值回退 `native` |
| `src/api-transport/system-prompt.ts` | 保留 `buildApiSystemPrompt` 不动；新增 `buildCuckooApiSystemPrompt`，使用 `providerId: 'quick'` |
| `src/prompt/quick.md` | 新增精简 Cuckoo 提示词；**目标 < 12000 字符**；只列第一版工具签名 |
| `src/api-transport/cuckoo-js.ts` | 新增纯解析/格式化模块：提取 `cuckoo` 块、去代码块、结果文本、输出截断 |
| `src/api-transport/cuckoo-js-exec.ts` | 新增 JS 执行：`guardExecutionCall(event, 'js', { code })` + `jsRunner.run` + `allowedTools` |
| `src/api-transport/cuckoo-js-loop.ts` | 新增 cuckoo-js 循环；不塞进 `runtime.ts` |
| `src/api-transport/runtime.ts` | `readOptions` 增加 `toolMode`；`sendApiMessage` 按 `toolMode` 分流；`getApiHistory` / `truncateApiHistory` 跳过内部 user 消息 |
| `src/api-transport/client.ts` | `ApiChatMessage` 增加 `internal?: boolean`；`StreamChatOptions` 增加可选 `conversationId` |
| `src/api-transport/context.ts` | `splitTurns` 不把 `internal` user 消息当成新轮次起点 |
| `src/api-transport/session-store.ts` | 快照/索引增加 `toolMode`；`trimForPersistence` 从可见 user 消息开始；内部 user 消息不计入可见历史 |
| `src/tools/runtime/JsRunner.ts` | `run` settings 增加 `allowedTools`；主进程 `tool-call` 分支先校验工具名 |
| `src/ui/harness.html` | API 设置增加“工具调用方式”下拉；切换时提示并开新对话 |
| `src/app/ipc/harness.ts` | `harness-api-settings-get/set` 透传/校验 `toolMode`；无需新增 IPC |

不改：

- `src/prompt/api-key.md`
- `src/api-transport/tool-loop.ts` 的 native 执行逻辑
- `src/bridge/parser/js-detector.ts` 的网页模式路径
- `src/providers/deepseek.ts`
- `cuko-api-quick` 任何文件

## 关键设计

### 1. 模式隔离

`toolMode` 必须进入：

- API 连接配置；
- `SessionState`；
- `stateKey`（`profile#window#mode#session`）；
- 会话快照/索引元信息；
- `systemKey`。

切换模式时：

- 不复用旧会话历史；
- UI 提示“工具模式已切换，已新建对话”；
- native 历史里的 `assistant.tool_calls + tool` 不会进入 cuckoo-js 会话；
- cuckoo-js 的 `internal` 工具结果不会进入 native 会话。

旧快照没有 `toolMode` 时按 `native`；`selectApiSession` 遇到模式不一致的会话应拒绝并提示，而不是把两种历史拼在一起。

### 2. 提示词：目标 < 12000 字符

这是当前代码带来的硬约束。

`cuko-api-quick` 的 `formatTranscript` 在超长时保留：

```text
头 12000 字符 + 尾 16000 字符
```

首轮 full transcript 的头部就是 system prompt。如果 `quick.md` 超过 12000 字符，工具签名会被截掉，Quick 就会编造函数名。

因此 `quick.md` 第一版：

- 只保留身份、Cuckoo 代码块规则、平台信息、项目目录、自定义指令；
- 只给 `bash / pwsh / read / write / edit / glob / grep` 的精简签名；
- **不使用** `{{TOOL_API_TYPES}}`、`{{TOOL_SECTIONS}}`；
- **不注入** `{{PROJECT_INTRO_SECTION}}`、`{{SKILLS_SECTION}}`、`{{MEMORY_SECTION}}`、`{{MCP_SECTION}}`；
- 项目规则如需注入，限制在 2000 字符以内，避免把工具签名挤掉；
- 自定义系统提示词在 cuckoo-js 模式截到 2000 字符；
- 构建后检查长度，> 12000 时记录错误并使用内置 compact fallback，不静默截断。

目标：`quick.md` 自身 5k~8k 字符，完整 system prompt 控制在 10k 以内。

### 3. 工具结果必须标记 `internal`

当前 `v0.10.250` 新增了编辑旧消息的“物理截断”：

- `getApiHistory` 会把所有 `user` 消息当作用户气泡；
- `truncateApiHistory` 从末尾数 `user` 消息；
- `context.ts` 的 `splitTurns` 把每条 `user` 当成新轮次；
- `session-store.ts` 的持久化裁剪也从 `user` 边界开始。

cuckoo-js 的工具结果如果直接用 `role:'user'`，会被当成“用户新消息”：

- UI 会多出一条用户气泡；
- 编辑/截断会数错索引，导致“编辑变追加”；
- 上下文裁剪会把工具结果当新轮次，可能丢掉原始任务。

所以给 `ApiChatMessage` 增加：

```ts
internal?: boolean; // true = 模型内部工具结果，不是用户可见消息
```

所有地方统一处理：

- `getApiHistory`：跳过 `internal`；
- `truncateApiHistory`：只数非 `internal` 的 user；
- `splitTurns`：`internal` user 归入当前轮次，不新开轮；
- `trimForPersistence`：从非 `internal` user 开始；
- `saveApiSession` 的 `messageCount` 可排除 `internal`。

### 4. 项目目录按会话

当前 `v0.10.250` 已经让每个 API 会话绑定 `projectDir`：

- `SessionState.projectDir`；
- 快照 `projectDir`；
- `restoreApiProjectDir` / `applyProjectDir`。

cuckoo-js 执行工具时必须用：

```text
st.projectDir || ctx.sessionStore.state.selectedProjectDir || process.cwd()
```

不能只读 `ctx.sessionStore.state.selectedProjectDir`，否则切换会话后可能用错目录。

### 5. 工具执行安全

不能直接 `jsRunner.run`，必须和网页模式一样走权限闸：

```text
构造内部 event（sender=当前 harnessView.webContents）
→ guardExecutionCall(event, 'js', { code })
→ 通过后才 jsRunner.run(code, projectDir, windowId, { sessionId, allowedTools })
→ pushPlanEvent
```

要点：

- 来源校验、workspace 信任、确认弹窗全部复用现有 `guardExecutionCall`；
- `allowedTools` 第一版限制为安全子集，避免 Quick 调用 API 模式不支持的 `attachFile` / `runAgent`；
- 停止按钮调用 `jsRunner.abortAll(windowId)`；
- 输出上限沿用 `JsRunner` 的 20000 字符。

### 6. 会话与结果回传

- 工具结果消息：

```text
role: 'user'
internal: true
content: '跑完了，结果：\n<工具输出>'
```

- 不使用 `role:'tool'`，也不使用 `tool_calls`；
- 失败结果也回传，让模型自己修正；
- 每轮 assistant 代码块和工具结果写入历史；最终回答写入 assistant；
- 不使用 `fillMissingToolResults`，因为 cuckoo-js 没有 `tool_calls`；
- `conversation_id` 用 `st.sessionId`，只在 cuckoo-js 模式发送。

### 7. UI

- API 设置新增“工具调用方式”：

```text
原生 function calling（默认）
Cuckoo 代码块（网页模型）
```

- 选择 `cuckoo-js` 时显示提示：

```text
适用于拒绝原生 tools、但能输出代码块的网页模型；工具在本地执行。
```

- 切换模式时强制新对话；
- 工具执行期间复用现有 `tool-start` / `tool-end` 卡片；
- 流式输出过滤 `cuckoo` 代码块，不能把整段 JS 当正文显示；没有可见正文时显示“正在生成工具脚本…”。

### 8. 3000 侧

`cuko-api-quick` 不改：

- 请求不带 `tools`，`buildToolInstruction` 不会注入“外部工具调用规则”；
- `formatChatPrompt` 只拼普通文本；
- `conversation_id` 已由 `chatSessionKey` 支持；
- 首轮 prompt 控制在 12000 字符以内，避免 `formatTranscript` 的头尾裁剪切掉工具签名。

## 实施阶段

### 阶段 0：基线保护

- [ ] 记录当前 `cuckoo-code` / `cuko-api-quick` 的 `git status` 和 `git diff --stat`。
- [ ] Cuckoo Code 目标测试 28 pass 作为基线；网关 178 pass 作为基线。
- [ ] 确认至少一个 Quick 账号 health=ok；`aws` 异常时先修或临时用 `aws-2` 验证。

### 阶段 1：配置与提示词

- [ ] `ui-prefs.ts` 增加 `toolMode`，默认 `native`，非法值回退。
- [ ] 新增 `src/prompt/quick.md`，目标 < 12000 字符。
- [ ] `system-prompt.ts` 新增 `buildCuckooApiSystemPrompt`，构建后检查长度。
- [ ] `readOptions` 按 `toolMode` 选择 prompt 和 tools。
- [ ] 测试：默认 native 提示词不变；cuckoo 提示词包含 `cuckoo` 和工具签名；长度 < 12000。

### 阶段 2：内部消息与解析

- [ ] `ApiChatMessage` 增加 `internal`。
- [ ] `cuckoo-js.ts`：提取代码块、去代码块、结果格式化、输出截断。
- [ ] `getApiHistory` / `truncateApiHistory` / `splitTurns` / `trimForPersistence` 支持 `internal`。
- [ ] 测试：内部结果不出现在 UI 历史；编辑/截断索引正确；裁剪不把内部结果当新轮次。

### 阶段 3：执行与循环

- [ ] `cuckoo-js-exec.ts`：guard + JsRunner + allowedTools。
- [ ] `cuckoo-js-loop.ts`：多轮循环、停止、轮数上限、状态事件。
- [ ] `runtime.ts` 在 `sendApiMessage` 按 `toolMode` 分流；native 循环不动。
- [ ] `SessionState` / `stateKey` / `persist` / 快照增加 `toolMode`。
- [ ] `client.ts` 增加可选 `conversationId`。
- [ ] 测试：mock `streamChat` 先返回代码块、再返回最终回答；断言请求不带 tools、历史是 internal user 结果、轮数上限、停止。

### 阶段 4：UI

- [ ] API 设置增加 `toolMode` 下拉。
- [ ] 切换模式时提示并开新对话。
- [ ] 流式过滤代码块；工具执行显示现有工具卡。
- [ ] 测试：设置读写、切换模式清空会话、代码块不进入正文。

### 阶段 5：验证

- [ ] `npm test` 全量通过。
- [ ] `npm run typecheck`、`npm run lint`、`npm run compile` 通过。
- [ ] 真机：AWS 窗口问“列出 `D:\Desktop\Super-File\cuko-api-quick` 目录”，Quick 输出 `cuckoo` 块，本地执行，结果回传，最终回答正常。
- [ ] 真机多轮：读文件 → 改文件 → 执行测试 → 汇总。
- [ ] 编辑旧消息：确认 cuckoo-js 内部结果不被计入用户消息，截断后重发不追加旧上下文。
- [ ] 切换 API 会话：确认项目目录跟着会话切换，工具在正确目录执行。
- [ ] 停止按钮能杀 `JsRunner` worker。
- [ ] 3000 日志确认无“外部工具调用规则”；`conversation_id` 命中时只发增量。
- [ ] 网页模式回归：DeepSeek 窗口仍能正常 `cuckoo` 工具调用。
- [ ] native API 回归：mock `tool_calls` 仍正常。

## 验收标准

- [ ] AWS 窗口 `toolMode=cuckoo-js` 能完成至少 2 轮工具调用，不需要人工复制结果。
- [ ] 请求体不带 `tools`，Quick 不再返回“无法使用外部工具”。
- [ ] 代码块不会原样显示在正文；工具结果以 `internal` user 消息回传。
- [ ] native API 窗口、DeepSeek 网页窗口行为不变，现有测试全绿。
- [ ] `toolMode` 切换不会把两种历史混在同一个会话。
- [ ] `quick.md` 构建出的 system prompt < 16000 字符；3000 首轮不丢工具签名。
- [ ] 编辑/截断旧消息时，内部工具结果不参与用户消息计数。
- [ ] 停止、超时、未闭合代码块、工具失败都有明确提示，不产生非法历史。

## 风险与回滚

| 风险 | 处理 |
|---|---|
| Quick 编造工具名 | `quick.md` 给全精确签名；`allowedTools` 拒绝未知工具并回传错误 |
| 提示词被 3000 头尾裁剪 | system prompt 控制在 12k 内；构建后检查长度 |
| 内部结果污染 UI/截断 | `internal` 标记贯穿 history / truncate / splitTurns / persistence |
| 会话混用 | `toolMode` 进会话快照 + 发送前校验 `mode_mismatch`；切换强制新对话 |
| 项目目录用错 | 用 `SessionState.projectDir`，不只读全局窗口目录 |
| 绕过权限 | 必须走 `guardExecutionCall`，禁止直接 `jsRunner.run` |
| 原生 API 回归 | native 分支不动；默认 `native`；现有测试全绿 |
| 网页模式回归 | 不碰 `bridge` / `overlay` / `deepseek`；解析器独立复制 |
| `runtime.ts` 继续膨胀 | 新逻辑放 `cuckoo-js-loop.ts`；runtime 只加入口/字段/内部消息过滤 |
| 回滚 | `toolMode` 默认 native；删除 `quick.md` + 新分支即可；不改 3000 |

## 以后其他网页怎么做

1. **有 OpenAI 兼容 API，且支持 tools**：新建 API 窗口，`toolMode=native`。
2. **有 OpenAI 兼容 API，但拒绝 tools**：新建 API 窗口，`toolMode=cuckoo-js`；按该网关长度限制配精简提示词。
3. **只有网页 UI，没有 API**：要么用 Cuckoo Code 网页 provider（需要为该站点写适配器），要么做一个类似 `cuko-api-quick` 的网关；不要指望“新建窗口”自动解决。

原则：**一个网关一个 API 窗口；网页 provider 只给高频、稳定、必须的站点写，不搞通用网页适配器。**

## 待确认

1. 第一版工具范围是否就按 `bash / pwsh / read / write / edit / glob / grep`。
2. AWS 窗口是否固定 `toolMode=cuckoo-js`，其他 API 窗口保持 `native`。
3. `conversation_id` 第一版是否开启；开则省上下文，但依赖 3000 内存会话 30 分钟 TTL。
4. 是否接受先复制 `extractJsToolBlocks` 到 `api-transport`，而不是本轮改 `bridge` 的解析器。

## 实施结果（2026-11-24）

> 以下为实现后的真实状态，覆盖上面的基线描述；首轮改动随本轮统一提交。

- 新增：`src/api-transport/cuckoo-js.ts`、`cuckoo-js-exec.ts`、`cuckoo-js-loop.ts`、`src/prompt/quick.md`。
- 修改：`runtime.ts`、`session-store.ts`、`context.ts`、`client.ts`、`system-prompt.ts`、`JsRunner.ts`、`ui-prefs.ts`、`harness.html`。
- `toolMode` 最终落在会话快照里，没有改 `stateKey`；发送前如果当前设置和会话快照模式不一致，返回 `mode_mismatch`，空会话例外（没有历史，直接跟随当前模式）。
- 内部工具结果统一标 `internal:true`，并贯穿 `getApiHistory`、`truncateApiHistory`、`importApiHistory`、`splitTurns`、`trimForPersistence`、`deriveSessionTitle`、`messageCount`。
- `quick.md` 约 3KB；`buildPrompt('quick')` 测试断言 `<12000` 字符，工具签名位于前部。
- 同一轮多个 `cuckoo` 块会先全部执行，再合并成一条 `internal` user 消息；避免 3000 的 `formatContinuation` 只发最后一条 user，丢掉前面的工具结果。
- 单条工具结果上限从 20000 收紧到 12000，避免 3000 尾段 16000 字符把结果开头裁掉。
- 动态 `import('./cuckoo-js-loop.js')` 在落用户消息之前执行；模块加载失败不会留下孤儿用户消息。
- 删除会话时优先切到同工具模式的剩余会话；旧索引没有 `toolMode` 按 native，空快照可安全转换。
- 验证：`npm test` 全量 `171 files / 1703 tests` 通过；`npm run typecheck`、`npm run compile` 通过；`npm run lint` 0 error、75 个既有 warning。
- 尚未完成：`3000` 当前未启动，未做真实 Quick 端到端联调；Electron 开发环境未实际点选 UI 下拉。用户自行测试。

## 两个严重问题修复（2026-11-25）

用户实测报告：图片上传后模型看不到；纯净模式点停止后 Quick 网页仍在生成。根因与修复：

1. **图片没有到模型**
   - 根因：`cuko-api-quick` 的 OpenAI 兼容层只把 `image_url` 转成文本占位“图片输入暂不支持”，从未提取 data URL、也从未调用 `handleChat` 的附件通道；Quick 实际一张图都没收到。
   - 修复：`protocol.extractImageAttachments` 从最后一条 user 的 `image_url` / `input_image` 提取 data URL，`handler` 落盘后写入 `payload._attachFiles/_attachMeta`，并把提示词占位替换成“图片附件已上传”。
   - 同时修复 `attachFiles` 的上传完成判定：原逻辑用 requestId 匹配 `/upload/` 永远不命中，图片卡片又没有文件名，导致上传成功却等满 60s 超时；现在按 `files/upload` 完成和“删除附件”数量判断。注入前会清掉输入区残留附件，避免“旧图+新图”串图。
   - 请求体上限 20MB → 32MB，容纳多张压缩图。

2. **停止后网页仍生成**
   - 根因：Cuckoo Code 只 abort 本地 fetch；Electron 主进程这一路不能保证网关侧立即收到 HTTP close，`handleChat` 的断连回调没触发，Quick 页面继续跑。
   - 修复：网关新增 `POST /openai/v1/chat/completions/stop`，按 `conversation_id` 找到活动回合，直接点 Quick“停止生成”按钮再销毁 sink；Cuckoo Code 的 `cancelChatTurn` 在 `stopApiSession` 里先发这个短请求再 abort。两条路径任一命中都能停网页。
   - 实测：显式 stop 返回 `ok:true`，页面 `generating=false`；Cuckoo 式“发 stop 后立刻 abort”即使 stop 请求晚到，网关 HTTP close 也会点停止。
   - 附件失败时清理临时文件，避免重试堆积。

验证：网关 `182 passed / 0 failed`；Cuckoo `171 files / 1705 tests` 全绿；typecheck、compile 通过；lint 0 error、75 个既有 warning。真实 Quick 图片端到端已确认模型能描述图片，真实 stop 已确认页面停止。首轮改动随本轮统一提交。

## 2026-11-25 第二轮：会话持久化与 cuckoo-js 上下文/MCP

用户确认要补两件事：网关会话映射重启后可续接；cuckoo-js 也要能用 MCP，并把全局规则/技能/记忆/MCP 真正注入 quick 提示词。

### 网关（cuko-api-quick）

- `bridge/openai/session-store.js`：默认 TTL 从 30 分钟改为 24 小时滑动过期；新增 `filePath` 选项，`set/get/delete/clear` 后原子落盘（temp + rename，Windows 占用时降级直写）；加载时剪掉过期项；无 `filePath` 保持纯内存，避免测试污染。
- `bridge/openai/handler.js`：默认落盘到 `data/openai-sessions.json`；`CUKO_OPENAI_SESSION_TTL_MS` 可调 TTL，`CUKO_OPENAI_SESSION_FILE` 可改路径，显式设为空串则关闭持久化。
- `test/run.mjs`：测试导入 handler 前把 `CUKO_OPENAI_SESSION_FILE` 设为空串，避免写开发机真实 data 文件。
- 新测试：文件持久化后新实例恢复、滑动 TTL 落盘、重启后过期、坏文件降级为空仓库。
- 真实验证：Chat 请求写出 `providerSessionId=451edcc4-...`；重启网关后同一 `conversation_id` 请求 `PONG2` 成功，文件里的 providerSessionId 未变，网关日志显示“已经在目标会话里，无需导航”。测试映射已清空，网关已用新代码重新启动（PID 见 `data/gateway.pid`）。

### Cuckoo（cuckoo-code）

- `src/prompt/quick.md`：新增 `mcpListServers/mcpGetTools/mcpCall` 声明；新增 `{{PROJECT_RULES_SECTION}}`、`{{SKILLS_SECTION}}`、`{{MEMORY_SECTION}}`、`{{MCP_SECTION}}` 占位符；环境段改为“已尽量注入，截断时 read”。
- `src/session/prompt-builder.ts`：新增 `compact`（quick 默认开启）；规则 3800 字符、技能索引 2200、记忆 800、MCP 1600；超出规则降级为索引；总预算仍受 36000 限制。
- `src/api-transport/system-prompt.ts`：quick 预算 12000 → 16000；显式 `compact:true`；兜底提示词补 MCP 三工具。
- `src/api-transport/cuckoo-js-exec.ts`：`ALLOWED_TOOLS` 增加 MCP 三工具；`JsRunner` 原有的 allowedTools 闸门继续生效。
- 测试：quick 模板含 MCP 声明、注入全局规则/技能/MCP、总长 <=16000；MCP 白名单；兜底提示词含 mcpCall。
- 验证：Cuckoo `171 files / 1708 tests` 全绿；typecheck、compile 通过；lint 0 error、75 个既有 warning（无新增）。
- 额外真实验证：用编译后的 `JsRunner` + 白名单 `['mcpListServers']` 执行，成功返回 `context7/cloudflare/cdp-bridge` 列表；用白名单 `['mcpGetTools']` 执行，成功连接 `context7` 并返回 2 个工具。没有启动 Cuckoo UI 点选，但沙箱注入、白名单闸门和 MCP 客户端链路都已实际跑通。
- 实际生成的 quick 提示词长度 7248 字符：包含完整全局规则（`rule.md` 全文）、项目规则索引、技能章节、记忆摘要、MCP 章节和全部工具签名；未超过 16000 预算。
