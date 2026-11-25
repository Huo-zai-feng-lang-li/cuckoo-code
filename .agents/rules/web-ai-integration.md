---
name: web-ai-integration
description: 接入新 AI 模型 / 网页模型 / 自建 API 网关的决策树、网关契约与验收清单；加平台、改 API 工具模式、写网关前必读
paths:
  - "src/api-transport/**/*.ts"
  - "src/providers/**/*.ts"
  - "src/providers/hooks/**/*.ts"
  - "docs/**/*.md"
---

# 新 AI / 网页模型接入规则

本规则解决一个反复出现的问题：**来一个新模型，到底该加 Provider、加 API 窗口，还是单独立一个网关？**

## 一、先判三档，不要直接写代码

| 上游能力 | 接入方式 | 要不要网关 | 工具协议 |
|---|---|---|---|
| 官方 API，支持 OpenAI `tools/tool_calls` | Cuckoo API 窗口 | 不要 | `native` |
| 官方 API，只收文本、不支持 tools | Cuckoo API 窗口 | 不要 | `cuckoo-js` |
| 只有网页 UI，没有稳定 API | 独立网页网关 + Cuckoo API 窗口 | 要 | `cuckoo-js` |
| 网页 UI，但希望直接在 Cuckoo 网页窗口聊天 | Cuckoo 网页 Provider + hook | 不要 | 网页原生 / hook |

判断顺序固定：**先找官方 API → 再看是否支持原生 tools → 最后才写网页网关/Provider。**
能走 API 就不要写网页自动化；能复用现有 OpenAI 网关就不要为每个站点写 Provider。

## 二、三种接入方式的边界

### 1. 官方 API + native tools

只加 API 窗口配置，不改代码：

- Base URL 指向厂商 `/v1`
- 模型填厂商模型名
- 工具模式 `native`
- 工具走 `tool-loop.ts`，结果写回 `tool` role

### 2. 官方 API + 无 tools

同一个 API 窗口，工具模式切 `cuckoo-js`：

- 不发送 `tools`，不产生 `tool` role
- `buildCuckooApiSystemPrompt` 注入 `quick.md`
- 模型输出 ` ```cuckoo ` 代码块 → `guardExecutionCall + JsRunner` 本地执行
- 工具结果作为 `internal:true` user 消息回传
- 这一档**不需要网关**，只要上游兼容 Chat Completions

### 3. 只有网页 UI

必须有一个“网页网关”把页面变成 OpenAI 兼容 HTTP 服务，再由 Cuckoo API 窗口接：

```text
Cuckoo API 窗口（toolMode=cuckoo-js）
  → OpenAI Chat Completions
  → 网页网关（CDP / 页面注入 / 站点会话）
  → 目标网页模型
```

不要让 Cuckoo Code 直接为每个网页站点写 Provider；Provider 是“网页窗口体验”，网关是“API 复用”，两者不要混。

## 三、网页网关最小契约

新网关至少提供：

- `GET /openai/v1/models`：返回账号池聚合后的模型别名
- `POST /openai/v1/chat/completions`：支持 `stream:true/false`，标准 SSE / JSON
- `POST /openai/v1/chat/completions/stop`：按 `model + conversation_id` 停止页面生成
- `conversation_id` 会话复用：同一会话只发增量，历史由网页侧维护
- 附件通道：图片 / 文本落临时文件，通过页面 `input[type=file]` 或站点上传接口挂载
- 健康检查：登录失效 / 额度 / 风控要映射成明确 HTTP 错误，不能伪装成模型回复
- 页签自愈：目标页缺失时自动补开；停止按钮找不到时不能静默成功

网关只负责“页面 → 文本/SSE”，**不要**在网关里实现 cuckoo 代码块解析；代码块解析属于 Cuckoo 的 `cuckoo-js` 模式。这样换网页模型不用改 Cuckoo 工具循环。

## 四、SSE / WebSocket / CDP 怎么选

优先级从高到低：

1. **页面已有稳定 HTTP SSE**：在页面上下文里 `fetch`，复用 Cookie/Token；Node 侧只做协议转换。注意 token 轮换与 401 重取。
2. **页面已有 WebSocket**：注入页面脚本复用现有连接，或 CDP 监听页面帧；不要自己重放握手字段（token、租户、workingSessionId 经常变）。
3. **只能操作 DOM**：CDP 输入框 + 发送按钮 + 读取流式正文；必须做发送确认、空闲超时、停止按钮、附件上传完成判定。
4. **不要解析原始 TCP / 自己抓包**：除非站点协议稳定且你有完整鉴权生命周期；否则维护成本高于 CDP。

“解析 SSE”只是传输层；真正难的是登录态、页面会话、附件、停止、风控。不要把“能读到 SSE”当成“接入了模型”。

## 五、上下文窗口规则

- 网页端的 context meter 是**权威**；API 设置里的 `上下文窗口` 只是 Cuckoo 本地历史裁剪阈值，不会扩大网页模型的实际窗口。
- `cuckoo-js + conversation_id` 时，历史由网页侧维护；Cuckoo 本地阈值设到网页自动压缩阈值附近即可，不要设成比网页窗口大很多。
- 网页通常会在某个百分比（例如 85%）自动总结；超过该阈值后旧工具结果会被压缩，不能假设细节还在。
- 工具轮数不是越大越好：每轮都会增加上下文和延迟；长任务建议 64–80，最多不超过 120，除非有明确的多轮工具需求。

## 六、加新网页的落地顺序

1. 在**独立网关项目**里新增 `bridge/providers/<site>.js` 或在现有网关加账号适配；不要先改 Cuckoo。
2. 先跑通：新对话 → 发文本 → 收流式 → 停止 → 附件 → 连续第二轮。
3. 再跑通：`conversation_id` 续接、登录失效、页签丢失、长静默、超时。
4. 最后接 Cuckoo：API 窗口 Base URL、模型别名、`toolMode=cuckoo-js`，发一个会触发本地工具的任务。
5. 网关和 Cuckoo 各自补测试与 `.agents/handoff.md`，不要只靠手测。

## 七、验收清单

- [ ] 新对话与续接都正常，`conversation_id` 不串会话
- [ ] 流式首字、结束、错误事件顺序正确
- [ ] 点击停止后网页端真的停止（不是只断本地流）
- [ ] 图片/文本附件真的到模型，模型能描述独有内容
- [ ] 连续 2 轮以上 `cuckoo` 工具调用，结果回到模型
- [ ] 网页压缩后仍能完成当前任务；旧细节丢失有提示
- [ ] 网关重启 / 页签关闭 / 登录失效有明确错误
- [ ] 日志不打印 Key、Cookie、完整会话 URL
- [ ] Cuckoo 全量测试、typecheck、lint、compile 全绿

## 八、禁止事项

- 禁止为了一个网页站点直接改 `runtime.ts` 主循环；网关差异留在网关。
- 禁止把网页 Cookie/Token 写进仓库或日志。
- 禁止用“固定 DOM 选择器 + 死等 60 秒”当上传/停止完成判定；必须有网络事件或 UI 数量变化。
- 禁止把 `contextWindow` 调到远大于网页实际窗口来“假装支持长上下文”。
- 禁止在网关里解析 ` ```cuckoo ` 并执行本地工具；执行边界必须在 Cuckoo 主进程。
