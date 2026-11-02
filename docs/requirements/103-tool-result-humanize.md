---
id: 103
type: fix
title: 工具结果回传文案拟人化（降低服务端内容特征识别）
status: done
branch: fix/103-tool-result-humanize
created: 2026-11-02
updated: 2026-11-02
---

# 需求 103：工具结果回传文案拟人化

## 1. 背景

每次工具执行完，框架会往 AI 输入框回传一段结果文本。这段文本作为**对话历史**的一部分，会随下一次 completion 请求完整发给 DeepSeek 服务端，服务端可明文读到。

当前文案是典型的「系统报表」形态：

```
【JS 执行结果汇总】(共 2 个脚本)

—— 脚本 1 ——
✅ 成功
<path>...</path>
```

真人聊天不会产生这种消息。相比请求节奏（已有拟人化延迟覆盖），**这是内容特征**，服务端无需行为分析即可判定为自动化框架在驱动。

## 2. 目标

降低回传文案的机械感，**不改变 AI 解析所依赖的结构**。

### 必须保留（AI 靠这些工作）

- `<path>/<type>/<content>` envelope —— 工具返回原文，一字不动
- 失败时的修正指令语义（「请重新输出 cuckoo 代码块」）

### 改掉的（服务端一眼识别为框架的部分）

| 当前 | 改为 |
|---|---|
| `【JS 执行结果汇总】(共 N 个脚本)` | `刚跑完 N 段代码，结果如下：` |
| `—— 脚本 N ——` | `第 N 段：` |
| `✅ 成功` | `成功` |
| `❌ 失败` | `失败了` |
| `(脚本执行完成，无输出)` | `（没有输出）` |
| `错误原因: xxx` | `报错：xxx` |

去掉 `【】` / `✅❌` / `——` 三类最像系统报表的符号（`types.ts` 注释亦记载「含 emoji / XML 标签 / 命令行痕迹的长文本可能触发风控」）。

## 3. 方案

直接改生成逻辑 `src/overlay/chat-input.ts` 的 `sendCombinedJsResultsToChat`，**不用** `transformToolResult` 钩子。

**理由**：该钩子拿到的是已拼好的完整字符串，只能正则后处理，等于把生成逻辑复制一份改文案，维护双份、易漏。三平台共用这套文案，不存在某平台需要保留机器味。

同步更新 4 个 prompt 模板里的示例（`deepseek.md` / `claude.md` / `chatgpt.md` / `default.md`），否则示例与真实回传不一致，AI 可能困惑。

## 4. 影响面

| 文件 | 改动 |
|---|---|
| `src/overlay/chat-input.ts` | `sendCombinedJsResultsToChat` 文案 |
| `src/prompt/deepseek.md` | 示例同步 |
| `src/prompt/claude.md` | 示例同步 |
| `src/prompt/chatgpt.md` | 示例同步 |
| `src/prompt/default.md` | 示例同步 |

## 5. 边界（明确不做）

只降低「内容特征的机械感」，**不能消除**。`<path>` / `<content>` 等标签本身仍是机器味，彻底拟人化需改工具返回契约，代价过大且 AI 未必还认得。本需求止步于「外壳拟人化」。

## 6. 验证

- typecheck / test / lint / compile 全绿
- 真机跑一轮工具调用，确认 AI 仍能正确解析 `<path>` 结果并继续工作
- 确认失败路径的修正指令仍生效
