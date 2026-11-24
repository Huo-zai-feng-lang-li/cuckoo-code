# Cuckoo API 模式多厂商接入与长任务闭环计划

> 结论先行：这轮不追求“菜单全绿”，只把 API 模式做成可长期跑项目的独立通道。核心是 **按窗口隔离连接配置、接入系统提示词、按上下文预算控制轮数、能力驱动隐藏 UI、图片按需物化**。网页模式、网页 bridge、原 Cuckoo 会话链路不改。

## 执行状态（2026-11-24）

- 已完成：API 设置模型自动获取（`/models`）、搜索过滤、空配置默认第一、关闭弹窗自动保存、移除底部保存按钮；思考块流式/展开贴底，内层滚动链恢复（仅 `.stream` 保留 `overscroll-behavior: contain`）。
- 已完成：API 历史续聊链路——主进程按 profile 落盘、`getApiHistory` 回传、harness 空历史时恢复 UI；当前 dev 快照 5 条正文可在设置外读取。
- 已完成：API 多会话——左侧常驻会话栏、新建/切换/删除、active 高亮；历史/计划/目标按 profile + session 隔离，旧版单快照自动迁移。
- 未完成：没有独立 `capabilities.ts`；当前能力矩阵由 `body.ck-api-mode` + CSS + harness 分支驱动。
- 已完成（审计加固）：API 本地 history/plan/goal 按 profile 隔离，新建对话保留 `'api'` 作用域；图片输入默认开启且关闭图片时文本附件仍可用；图片 MIME 按 sharp 真实格式；`/models` 端点兼容已带 `/chat/completions` 或 `/models`；system 变更按 prompt hash 重建；会话持久化按 user 轮次裁剪并修复孤儿 tool；文本附件计入预算；reset/dispose 防幽灵写盘与幽灵工具轮；图片 400 仅按图片相关错误禁用当前模型；SSE 支持数组正文。
- 验证（2026-11-24）：全量 `npm test` 167 文件 / 1670 条通过；`typecheck`、`lint`（0 error / 75 warnings）、`compile` 通过；真机验证模型下拉、关闭自动保存、滚轮链、历史恢复。


## 目标

1. 不同厂商的 Key / 模型 / 上下文窗口可以分别配置，互不串线。
2. API 模式真正读取全局规则、项目规则、技能、记忆、项目介绍和 MCP 说明。
3. 512K 上下文模型不再被 24 条历史、20 轮工具硬限制卡死。
4. API 窗口只显示当前连接真正支持的功能；不支持的直接隐藏。
5. 图片附件不把 base64 长期塞进历史，不因网关不支持 vision 而撑爆上下文。
6. 长任务在纯净模式下保持流畅：流式渲染不抖、工具输出不堆 DOM、历史不反复全量序列化。
7. 原有网页模式行为不变，现有测试全部通过。

## 现状根因

- `src/api-transport/runtime.ts:39-44` 只有固定四行 `API_SYSTEM_PROMPT`，不读取规则/技能/记忆/MCP。
- `src/api-transport/runtime.ts:37` 硬编码 `MAX_HISTORY_MESSAGES = 24`；`:77-84` 按消息条数裁剪，不按 token。
- `src/api-transport/runtime.ts:105-118` 读取全局 `apiTransport`，轮数钳制 20。
- `src/api-transport/config.ts:36-55` 主对话配置为空时回退提示词增强配置，耦合两套东西。
- `src/app/ui-prefs.ts:101-112` 只有一套全局 `apiTransport`；`:230-241` 轮数上限 20。
- `src/ui/harness.html:1196-1268` API 设置和提示词增强混在同一个 `#enh-mask`；`:5622-5626` API 模式直接拒绝附件。
- `src/api-transport/client.ts:234-242` 请求体没有 `reasoning_effort`、`max_tokens`、`stream_options`，也没有 usage 结果。
- `src/api-transport/tool-loop.ts:16-17` 排除 `attachFile/runAgent/runAgents`，但系统提示词仍可能提示这些能力。
- `src/ui/shell/scripts/toolbar.ts:85-94` 只给壳页面加了 `ck-api-mode`，没有能力矩阵；左侧菜单仍全部显示。
- `src/session/prompt-builder.ts:192-353` 已有完整提示词组装能力，但 API runtime 没有调用。

## 核心方案

### 1. 连接配置按 API 窗口隔离，不按 Key 字符串隔离

**最优选择：每个 API profile（即每个 API 窗口）保存一份独立连接配置。**

原因：Key 只是凭证；同一 Key 下不同模型、不同网关的上下文窗口、vision、reasoning 支持都可能不同。按 Key 分组会把“凭证”和“能力”混在一起，后续无法表达“同一 Key 切模型”。

数据形态：

```ts
interface ApiConnectionPrefs {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;       // tokens，默认 131072；512K 填 524288
  maxOutputTokens: number;     // 默认 8192
  maxToolRounds: number;       // 1..500，默认 64
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
  vision: boolean;             // 该连接是否支持图片 content part，默认 true；缺字段按默认回退
  toolsEnabled: boolean;
  usageReporting: 'auto' | 'on' | 'off';
  systemPrompt: string;        // 追加自定义系统提示词，空 = 只用内置
}
```

存储：

- `ui-prefs.json` 增加 `apiTransport.byProfile: Record<profileId, ApiConnectionPrefs>`。
- 旧版 `apiTransport.baseUrl/apiKey/model/...` 迁移为 `apiTransport.defaults`，已有 API 窗口继续可用；新窗口继承 defaults。
- 每个 profile 的 Key 分别用 `safeStorage` 加密；`apiKeyEncrypted` 按连接保存，渲染进程永远拿不到明文。
- `get-ui-prefs` 不返回所有连接；新增 `api-settings-get` / `api-settings-set`，由主进程按当前 `ctx.profileId` 定位，渲染进程不能传任意 profileId。
- 彻底删除 `resolveTransportInput` 对 `promptEnhancer` 的回退。提示词增强和主对话 API 是两套配置，互不借用。

### 2. API 系统提示词接入现有组装器

新增 `src/prompt/api-key.md`，并给 `buildPrompt` 增加可选参数：

```ts
buildPrompt({
  providerId: 'api-key',
  selectedDir,
  mode: 'api',
  includeAgents: false,
  includeToolSections: false, // 工具定义由原生 tools schema 提供，避免 JS 调用格式误导
  excludedTools: ['attachFile', 'runAgent', 'runAgents'],
  maxChars: 60000,
})
```

API 系统提示词按以下顺序组装：

1. `api-key.md` 固定段：本机代码助手、原生 function calling、工具结果以 tool message 返回、不要输出 JSON 工具块。
2. 用户自定义 `systemPrompt`（最多 8000 字符，追加在固定段后）。
3. 平台信息、项目介绍 `CUCKOO.md`。
4. 全局规则 + 项目规则。
5. 技能清单（只给名字、描述、路径，模型按需 `read SKILL.md`）。
6. 用户记忆。
7. MCP 能力与调用流程。
8. 明确说明：API 模式没有网页，不存在子代理；不要调用 `runAgent/runAgents/attachFile`。

实现位置：新增 `src/api-transport/system-prompt.ts`，负责调用 `buildPrompt`、追加自定义段、过滤不支持能力。`runtime.ts` 在新建会话 / 项目变更 / 配置变更时重建，并替换 `messages[0]`；不要在每条消息前重复组装。

规则、技能、记忆编辑后，新会话生效；API 设置里提供“重新加载系统提示词”按钮，避免长任务中途变提示词导致缓存前缀失效。

### 3. 上下文预算，不再只靠固定轮数

新增 `src/api-transport/context-budget.ts`，纯函数，不依赖 Electron。

预算公式：

```text
可用预算 = floor(contextWindow * 0.85) - maxOutputTokens
固定占用 = 系统提示词 + tools schema + 当前用户消息
历史可用 = 可用预算 - 固定占用
```

策略：

- `maxToolRounds` 允许 1..500，默认 64；512K 模型建议 120~250。轮数只是安全阀，真正兜底是 token 预算。
- 每次请求前估算 messages + tools + 图片 token；估算超预算时，按“完整 turn 组”从最旧开始裁剪，绝不留下孤儿 `assistant(tool_calls)` 或孤立 `tool` 消息。
- 保留 system、最近用户目标、最近工具结果；旧工具结果压缩为“结果已压缩，需要细节重新 read/执行”的短文本。
- 裁剪仍超预算时，返回 `context_limit` 并提示用户新开会话，不静默截断到非法历史。
- 使用服务端返回的 `usage.prompt_tokens` 校准估算比例；没有 usage 时用保守估算（中文约 1.2 token/字，英文/代码约 4 字符/token）。UI 标注“精确/估算”。
- UI 状态条和 Token 页显示：当前上下文 tokens、预算百分比、是否发生过裁剪；不再显示假的 0。

首轮闭环只做确定性裁剪，不做“再调一次模型生成摘要”。模型摘要压缩单独评估，避免长任务在压缩阶段再卡一次。

### 4. 图片附件：base64 不是上下文，错误用法才是

**结论：base64 字符本身不会按文本 token 全部计入上下文；OpenAI 兼容接口按图片 token 计费。但如果网关不支持 vision，把 data URL 当普通文本处理，就会非常严重。**

最优流程：

1. 渲染进程只传附件描述，不把 base64 塞进历史：
   - `{ name, mime, size, path?, data? }`
   - 文件选择/拖拽优先用 Electron `webUtils.getPathForFile(file)` 拿本地路径；剪贴板图片没有路径时，主进程落临时文件，后续只存路径。
   - 文本文件读成文本并截断，不当 base64 传。
2. 主进程 `src/api-transport/attachments.ts` 用项目已有 `sharp` 处理图片：
   - 自动旋转，长边缩到 1568px（可配 1024），不放大。
   - 有 alpha 用 PNG，否则 JPEG quality 80；单图最大 2MB。
   - 生成图片 token 估算，纳入上下文预算。
3. 请求前才物化 data URL：
   - 历史里只存附件描述；每次请求由 `buildRequestMessages()` 按路径重新读取、压缩、生成 `image_url` content part。
   - 不把 base64 写进 `ui-prefs`、JSONL 会话、localStorage、日志。
   - 文件被删除时降级为 `[图片已删除]` 文本占位，不让请求崩。
4. 能力门控：
   - 连接 `vision=false` 时隐藏附件按钮，明确提示该连接不支持图片输入。
   - 单条消息最多 4 张图；活跃上下文最多 8 张图；超出时丢弃最旧图片并写占位。
   - 不做 PDF/Office 原生解析；文本附件只支持可读文本格式。

按 1568px 长边、high detail 估算，单图约 1k~1.5k tokens；4 张约 4k~6k，对 512K 不严重。真正危险的是把 10MB base64 当文本塞进 content，或网关不支持 vision 却强行发送。

### 5. 能力矩阵统一驱动 UI 隐藏

新增 `src/api-transport/capabilities.ts`，主进程只输出一份能力对象，壳页面和纯净页面都消费它，不在各处散落 if。

```ts
interface ApiCapabilities {
  web: false;
  menus: {
    workspaces: boolean; files: true; git: true; tasks: true;
    snippets: true; memories: true; skills: true; plugins: true;
    agents: false; rules: true; mcp: true; windows: true;
    token: boolean; remote: false; settings: true; about: true;
  };
  attachments: { image: boolean; text: boolean };
  subagents: false;
  promptEnhancer: false;
}
```

- `shell.ts` / `shell-preload.ts` 的 `shell-api-mode` 事件携带 `capabilities`。
- `toolbar.ts` 把 `data-api-cap` 写到 body；`base.css` 用 `body.ck-api-mode [data-tab="agents"]` 等规则隐藏。
- `harness.html` 根据能力隐藏附件、提示词增强、工具斜杠菜单；附件仅在 image/text 能力为真时显示。
- 明确显示：工作区、项目文件、Git、任务、快照、提示词、记忆、技能、插件、全局规则、MCP、窗口、Token、设置、关于。
- 明确隐藏：子代理、远程控制、网页导航、API 窗口的提示词增强、vision=false 时的附件、toolsEnabled=false 时的工具入口。
- 工作区只有在 API 会话持久化落地后才显示；未落地前不显示空列表假装支持。

### 6. API 设置与提示词增强彻底拆开

- `harness.html` 新增独立 `#api-mask`，移出 `#enh-mask` 里的 `#api-base-url`、`#api-transport-key`、`#api-transport-model`、`#api-tools-enabled`、`#api-max-tool-rounds`。
- `#btn-api-settings` 只打开 `#api-mask`，提示词增强按钮仍走 `#enh-mask`。
- API 表单字段：连接名称、Base URL、Key、模型、上下文窗口（32K/64K/128K/256K/512K/1M/自定义）、最大输出 tokens、最大工具轮数（1~500）、推理强度、vision 开关、工具开关、自定义系统提示词、连接测试。
- 保存走 `api-settings-set`，主进程按当前 profile 写入 `byProfile`，Key 加密；不经过 `set-ui-prefs`。
- 不再显示“三项全空复用提示词增强”的文案和逻辑。
- `reasoningEffort !== 'auto'` 时请求体才加 `reasoning_effort`；不支持该字段的网关会返回 400，界面提示改回 auto，不静默失败。
- `maxOutputTokens` 非空时请求体加 `max_tokens`；`usageReporting !== 'off'` 时尝试 `stream_options.include_usage=true`，网关拒绝则本次关闭并改用估算。

### 7. 会话持久化与纯净模式长任务流畅

新增 `src/api-transport/session-store.ts`：

- 每个 profile 一个目录：`userData/api-sessions/<profileId>/`。
- 每个会话一个 append-only `.jsonl`，每行一条消息；只追加，不在热路径全量 `JSON.stringify`。
- 消息里只存附件描述，不存 base64。
- 新对话生成新的 `api-<timestamp>-<rand>` sessionId，并登记到现有 `sessionStore` 的 session-dir 映射，工作区页可列出。
- 窗口启动加载当前 profile 最后一个会话；重启恢复历史；最后一条 `assistant(tool_calls)` 缺 tool 结果时补 `ERROR: cancelled`，保证历史合法。
- 关闭窗口 / 新对话前 flush；不做同步写盘阻塞 UI。

长任务流畅措施：

- `runtime.ts` 的流式回调按 30ms 合并发送，最终帧立即发；避免每个 SSE token 一次 IPC。
- API 模式不再把完整历史反复写 `localStorage`；历史以主进程 JSONL 为准，渲染层只保留最近显示窗口。
- 初始恢复只渲染最近 100 条，旧记录按需加载；工具输出卡片默认折叠，单卡最多显示 8k 字符，完整内容按需展开/重新读取。
- 工具回传模型的内容默认上限从 50k 降到可配置 20k；旧工具输出在上下文中压缩。
- 保留现有 80ms 流式 markdown 节流，不在长任务中改成逐 token 全量渲染。

## 实施任务

- [ ] 任务 0：基线保护
  - 文件：无源码改动。
  - 动作：记录当前未提交 API WIP 的 `git diff --stat` 和 `git status`；生成 `.agents/api-wip-baseline.patch` 作为本地回滚参考。
  - 验证：patch 可 `git apply --check`；不 commit、不 push。

- [ ] 任务 1：连接配置模型与迁移
  - 文件：`src/app/ui-prefs.ts`、`src/app/ipc/settings.ts`、`src/api-transport/config.ts`。
  - 新增 `ApiConnectionPrefs`、`byProfile`、`defaults`、`resolveApiConnection(prefs, profileId)`、`normApiConnection`。
  - 旧字段迁移；多 Key 加密/解密/脱敏；删除 `resolveTransportInput` 回退。
  - 测试：`test/app/ui-prefs-api.test.js` 覆盖迁移、双 profile 不同 Key、默认回退、Key 不回传。
  - 验证：`npm test -- test/app/ui-prefs-api.test.js`。

- [ ] 任务 2：API 系统提示词
  - 文件：`src/prompt/api-key.md`、`src/session/prompt-builder.ts`、`src/api-transport/system-prompt.ts`、`src/api-transport/runtime.ts`。
  - 增加 `mode/includeAgents/includeToolSections/excludedTools/maxChars` 可选参数；网页默认行为不变。
  - API 模板只讲原生 function calling，不出现 `cuckoo` 代码块。
  - 缓存 system prompt，按 profile + projectDir + 自定义 prompt hash 失效。
  - 测试：`test/api-transport/system-prompt.test.js` 覆盖规则/技能/记忆/项目介绍进入提示词，agents 与不支持工具不出现，自定义提示词追加，缓存失效。
  - 验证：`npm test -- test/api-transport/system-prompt.test.js`。

- [ ] 任务 3：上下文预算与轮数
  - 文件：`src/api-transport/context-budget.ts`、`src/api-transport/runtime.ts`、`src/app/ui-prefs.ts`。
  - 删除 `MAX_HISTORY_MESSAGES=24` 的实际裁剪路径；保留 system + 最近完整 turn；超预算返回 `context_limit`。
  - `maxToolRounds` 1..500，循环边界改为 `< maxToolRounds`；每次请求前计算预算。
  - 测试：`test/api-transport/context-budget.test.js` 覆盖 32K/128K/512K、tool_calls 配对、系统提示词保留、超限。
  - 验证：`npm test -- test/api-transport/context-budget.test.js`。

- [ ] 任务 4：图片与文本附件
  - 文件：`src/api-transport/attachments.ts`、`src/api-transport/client.ts`、`src/api-transport/runtime.ts`、`src/app/ipc/harness.ts`、`src/app/harness-preload.ts`、`src/ui/harness.html`。
  - 渲染层传附件描述；主进程用 sharp 压缩；请求前物化图片 content part。
  - 历史/JSONL/localStorage 不出现 base64；vision=false 拒绝并隐藏入口。
  - 测试：`test/api-transport/attachments.test.js` 覆盖缩放、透明图、超限、路径丢失、base64 不落盘。
  - 验证：`npm test -- test/api-transport/attachments.test.js`。

- [ ] 任务 5：API 设置独立弹窗
  - 文件：`src/ui/harness.html`、`src/app/ipc/settings.ts`、`src/app/harness-preload.ts`。
  - 新增 `#api-mask` 与字段；`#enh-mask` 只保留提示词增强。
  - 新增 `api-settings-get/set`；按 sender 的 profile 定位，禁止渲染进程传 profileId。
  - 测试：`test/ui/harness-api-settings.test.js` 覆盖两个弹窗互不串、Key 不回填、轮数 500 保存、上下文窗口保存。
  - 验证：`npm test -- test/ui/harness-api-settings.test.js`。

- [ ] 任务 6：能力矩阵与菜单裁剪
  - 文件：`src/api-transport/capabilities.ts`、`src/app/ipc/shell.ts`、`src/app/shell-preload.ts`、`src/ui/shell/scripts/toolbar.ts`、`src/ui/shell/styles/base.css`、`src/ui/harness.html`。
  - 主进程输出能力对象；壳页面按 `data-tab` 隐藏 agents/remote 等；纯净页按能力隐藏附件/增强/工具入口。
  - 测试：`test/api-transport/capabilities.test.js`、`test/ui/harness-page.test.js` 覆盖 API 窗口隐藏 unsupported、网页窗口不受影响。
  - 验证：`npm test -- test/api-transport/capabilities.test.js test/ui/harness-page.test.js`。

- [ ] 任务 7：会话持久化与长任务流畅
  - 文件：`src/api-transport/session-store.ts`、`src/api-transport/runtime.ts`、`src/app/entry.ts`、`src/ui/harness.html`。
  - JSONL 追加、启动恢复、新对话轮换、中断 tool_calls 补齐。
  - API 模式绕过 localStorage 全量历史；恢复只渲染最近 100 条；工具卡折叠 + 8k 显示上限；流式事件 30ms 合并。
  - 测试：`test/api-transport/session-store.test.js`、`test/api-transport/runtime.test.js` 覆盖重启恢复、新对话不串、坏 JSONL 回退、长历史渲染上限。
  - 验证：`npm test -- test/api-transport/session-store.test.js test/api-transport/runtime.test.js`。

- [ ] 任务 8：推理强度与请求参数
  - 文件：`src/api-transport/client.ts`、`src/api-transport/runtime.ts`、`src/ui/harness.html`。
  - `reasoning_effort`、`max_tokens`、`stream_options.include_usage` 可选下发；400 时提示并允许关闭。
  - 测试：`test/api-transport/client-options.test.js` 检查请求体字段、auto 不发送、usage 解析、stream_options 关闭回退。
  - 验证：`npm test -- test/api-transport/client-options.test.js`。

- [ ] 任务 9：全量验证与真机验收
  - 跑 `npm test`、`npm run typecheck`、`npm run lint`、`npm run compile`。
  - 起本地 mock OpenAI 兼容服务，验证两个 API 窗口不同 Key/模型/contextWindow：
    - 512K 配置、200 轮上限、模拟 50 轮工具调用不崩；
    - 规则/技能/记忆进入首条 system message；
    - 图片压缩后请求体为 `image_url`，历史无 base64；
    - 重启恢复、工作区可见、Token 显示精确/估算；
    - agents/remote 隐藏，files/git/tasks/mcp/token 可用。
  - 验收：无新增 TypeScript 错误，lint 通过，现有 1600+ 用例全绿，真机截图/日志留档。

- [ ] 任务 10：文档与收口
  - 更新 `docs/requirements/131-api-key-transport.md`、`CHANGELOG.md`。
  - 记录配置字段、能力矩阵、图片策略、已知限制。
  - 不 commit、不 push，等用户真机验收。

## 关键文件

- `src/api-transport/runtime.ts`：系统提示词、上下文预算、轮数、usage、会话状态。
- `src/api-transport/config.ts`：连接配置解析，删除提示词增强回退。
- `src/api-transport/context-budget.ts`：token 估算与完整 turn 裁剪。
- `src/api-transport/attachments.ts`：图片路径、sharp 压缩、content part、附件描述。
- `src/api-transport/system-prompt.ts`：API 提示词组装与缓存。
- `src/api-transport/session-store.ts`：JSONL 会话持久化。
- `src/api-transport/capabilities.ts`：能力矩阵。
- `src/app/ui-prefs.ts`：per-profile 配置、Key 加密迁移。
- `src/app/ipc/settings.ts`：API 设置 IPC、按 sender 定位 profile。
- `src/app/ipc/harness.ts`：API send 附件参数、send-result。
- `src/app/harness-preload.ts`：sendMessage 附件参数、API 设置 IPC。
- `src/app/ipc/shell.ts`：能力事件、Token 状态推送。
- `src/ui/harness.html`：独立 API 设置弹窗、附件入口、工具卡折叠、API 历史恢复。
- `src/ui/shell/scripts/toolbar.ts`：能力驱动壳页面隐藏。
- `src/ui/shell/styles/base.css`：API 模式菜单隐藏。
- `src/session/prompt-builder.ts`：可选 API 模式参数，不改网页默认。
- `src/prompt/api-key.md`：原生 function calling 模板。

## 验收标准

- [ ] 两个 API 窗口分别配置不同 Base URL / Key / 模型 / contextWindow，互不影响；Key 不出现在渲染进程或日志。
- [ ] API 首条系统提示词包含全局规则、项目规则、技能清单、记忆、项目介绍、MCP 说明；不包含 agents 和不支持工具。
- [ ] 512K 配置下不再受 24 条历史 / 20 轮硬限制；`maxToolRounds` 可设到 500，预算超限时明确提示 `context_limit`，不产生非法 tool 历史。
- [ ] 图片附件只以 `image_url` content part 发送；单图压缩到长边 1568、2MB 内；历史与 JSONL 无 base64；vision=false 时入口隐藏并明确提示。
- [ ] API 窗口隐藏 agents/remote/网页导航/无效附件；显示 files/git/tasks/mcp/token/rules/skills/memories 等真实可用入口。
- [ ] API 设置与提示词增强是两个独立弹窗；API 配置不再回退提示词增强 URL/Key/模型。
- [ ] 长任务：模拟 50 轮工具调用时 UI 不冻结、流式不中断、工具卡不无限膨胀；重启后会话恢复。
- [ ] 网页模式回归：原有测试全绿，`src/bridge` 与网页 provider 无行为变化。
- [ ] `npm test`、`npm run typecheck`、`npm run lint`、`npm run compile` 全部通过。

## 非目标

- 不做 API 原生子代理；`runAgent/runAgents` 继续排除。
- 不做远程控制；API 窗口隐藏 remote。
- 不做 PDF/Office 原生解析；附件首轮只支持图片和文本。
- 不做自动探测模型能力；contextWindow、vision、reasoning 由用户显式配置。
- 不做“再调一次模型生成摘要压缩”；首轮用确定性裁剪，避免长任务被额外请求拖慢。
- 不改网页模式、网页 bridge、网页会话恢复、网页附件注入链路。

## 风险与回滚

- `sharp` 与 Electron ABI 已在现有依赖中；打包后需真机验证图片压缩，失败时回退 `nativeImage`。
- `webUtils.getPathForFile` 在剪贴板图片场景可能拿不到路径；回退主进程临时文件，仍不把 base64 写历史。
- `stream_options` / `reasoning_effort` 可能被部分网关 400；配置可关闭，错误原样提示，不静默吞。
- token 估算不是精确 tokenizer；用 usage 校准并保留 15% 安全余量。
- 系统提示词缓存可能让规则编辑在新会话才生效；提供“重新加载系统提示词”按钮。
- 所有改动只在 `api-key` provider 分支生效；出现回归时可按 `.agents/api-wip-baseline.patch` 回退，不触碰网页模式。

## 2026-11-24 UI 收尾（当前）

- API 会话从顶部下拉改为左侧常驻栏：栏内“＋ 新对话”、会话列表、active 高亮、删除入口；顶部“会话”按钮只负责收起/展开，切换/新建/删除都不会自动收起。
- 顶栏不再显示 `API N tok`，token 只保留壳层右下角状态条；`#api-usage` 在 API 模式强制隐藏。
- API 设置弹窗：两列表单改为 label 顶对齐 + 输入框底对齐（`margin-top:auto`），模型触发器与相邻输入框同高；弹窗加宽到 520px，减少 label 换行挤压。
- 顶栏与会话项移除原生 `title` tooltip；会话行 hover 改为整行底色、active 左侧 accent 条，删除按钮改为低对比垃圾桶图标、hover 变红。
- 模型列表刷新时不再覆盖已保存但暂不在 `/models` 返回中的模型，只有原本为空才默认第一项。
- 验证：`npm test` 167 文件 / 1670 用例通过；`typecheck`、`compile` 通过；`lint` 0 error / 75 warnings；dev 真机确认左侧栏、设置对齐、顶栏无 token、无 hover tooltip。
