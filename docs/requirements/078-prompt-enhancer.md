---
id: 078
type: feature
title: 纯净模式提示词增强
status: doing
branch: (直接主分支)
created: 2026-10-17
updated: 2026-10-17
---

## 背景

纯净模式（harness）用户常写"帮我写个登录页"这类简短输入，缺少需求细节、约束、输出格式，导致 AI 回复不达预期。参照 Augment / DSH 系列插件做法，提供"提示词增强"：把草稿改写成更清晰、结构化、可执行的提示词。

关键调研结论（网上主流工具一致）：
- **旁路 LLM 调用**，不占主对话轮次（避免污染历史、错乱生成状态机）
- **只回填输入框，不自动发送**（用户保留最终控制权）
- 增强中可取消、可撤销、失败不动原输入

## 目标

纯净模式输入框旁加 ✨ 按钮：调**独立 LLM API**（OpenAI 兼容），把当前草稿 + 最近几轮上下文 + 项目技术栈改写成更清晰的提示词，回填输入框，用户可编辑/撤销/发送。

### 范围

- ✅ 独立 API 旁路调用（不占 AI 网页对话轮次，与 bridge 完全隔离）
- ✅ 上下文：最近 N 轮对话（默认 8）+ 项目 package.json 技术栈
- ✅ 两种力度：温和（缺啥补啥，能不改就不改）/ 激进（强制结构化）
- ✅ 只回填不自动发送；替换后可撤销（3 秒）
- ✅ 增强中禁用输入框/发送（防回填覆盖）；可取消（切会话/新对话自动作废）
- ✅ 配置存主进程 ui-prefs（API URL/Key/模型/力度/轮数/自定义提示词）
- ✅ 失败降级：原输入不动 + 提示
- ❌ 不做：代码库索引注入、流式渲染、自动发送

## 方案

### 数据流

    [点 ✨] → harness 页收集 input + 最近N轮 history
      → harnessAPI.enhancePrompt()
      → ipcMain 'harness-enhance-prompt'
      → prompt-enhancer.ts（读项目技术栈 + 拼 prompt + fetch API）
      → 返回 { success, text }
      → 回填 input.value（不发送）

### 为什么独立 API 而非复用当前对话

复用当前 AI 网页会占用对话轮次、污染历史、搅乱 aiGenerating/发送队列/截断状态机。独立 API 旁路调用彻底隔离。

### 文件清单

新增：
- src/app/prompt-enhancer.ts（增强逻辑：读项目信息 + 拼 prompt + fetch）
- test/app/prompt-enhancer.test.js（真实集成测试：本地 HTTP server）

改动：
- src/app/ui-prefs.ts（加 promptEnhancer 配置字段）
- src/app/ipc/harness.ts（加 3 个 handler）
- src/app/harness-preload.ts（加 3 个 API）
- src/ui/harness.html（✨ 按钮 + 撤销 + 设置字段）

## 验收标准

- [ ] 输入框旁有 ✨ 按钮，空输入提示不调 API
- [ ] 增强成功回填输入框，不自动发送，可撤销
- [ ] 增强失败原输入不动 + 提示
- [ ] 增强中禁用输入/发送；切会话/新对话自动取消
- [ ] 设置可配 API/模型/力度/轮数/自定义提示词
- [ ] 温和模式对简单需求不过度扩写
- [ ] typecheck + lint + compile + test 全绿
- [ ] 真机验证（开发实例 9444）

## 遗留

- 代码库索引注入（Augment 那种）未做
- 流式增强（边生成边显示）未做
