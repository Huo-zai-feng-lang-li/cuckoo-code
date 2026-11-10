---
id: 111
type: fix
title: 认知节奏发送管线与延迟配置合规加固
status: done
branch: feat/111-cognitive-delay-pipeline
created: 2026-11-10
updated: 2026-11-10
---

# 需求 111：认知节奏发送管线与延迟配置合规加固

## 一、背景与动机
- **当前状态**：已完成 (Done)
- **核心痛点**：
  1. 原有延迟是「瞬间填满输入框 → 干等 6~16 秒 → 点发送」，最像机器人的行为（真人不会秒打几千字后发呆才点发送）；
  2. 需求 110 新增的拟人延迟函数用了**硬编码区间**（0.8~3.5s / 0.3~1.5s / 1.2~2s），完全绕过用户配置的 `sendDelayMin/Max`（默认 6~16s），导致「设置无效」；
  3. 纯净模式「用户手动发送」与快捷提示词被加了随机延迟，反而制造「每次都落在固定区间」的机器特征（真人手动操作立即发）；
  4. 原生 insertText 分段注入只在首段失败时回退，长消息中途失败会静默丢内容；
  5. 短文本经认知模型钳制后永远恰好等于 `min`（固定节拍指纹）。
- **目标**：
  1. 总延迟**严格遵守**用户配置区间，拆成 R（填充前反应停顿）+ S（填充后犹豫停顿），R 占比与上一条 AI 回复长度相关；
  2. 手动发送 / 快捷提示词回归 0ms；
  3. 原生分段注入任一段失败 → 整体回退 DOM，并校验最终长度；
  4. 边界钳制后补均匀抖动，杜绝固定节拍。

## 二、方案设计

| 阶段 | 含义 | 时长 |
|---|---|---|
| R 反应 | AI 回复结束 → 开始输入 | total × ratio，ratio = clamp(0.3 + 回复长度/8000, 0.3, 0.55) |
| T 输入 | 原生 insertText 分块注入（4000 字/块） | 自带自然耗时 |
| S 犹豫 | 输入完 → 点发送 | total − R |

- `total = randomDelay(msg)`，已 clamp 到用户配置 `[sendDelayMin, sendDelayMax]`；
- 短文本钳制到边界时，改为 `min ~ min+25%区间` 均匀抖动；
- `fixedDelay` 显式传入（格式纠正等系统即时指令传 0）→ 不拆分，保持旧行为；
- 手动发送（harness）/ 快捷提示词 → 0ms。

## 三、涉及文件
- `src/overlay/chat-input.ts`：`planSendTiming`、`interruptibleWait`、`doSendToChat` 三段时序；`randomDelay` 边界抖动；原生注入完整性校验；初始提示延迟改走 `randomDelay`；`insertSnippet` 0ms
- `src/bridge/intercept/observer.ts`：AI 回复长度透传 `contextLen`
- `src/bridge/harness-bridge.ts`：手动发送回退 0ms
- `start.js`：修正 `--dev` 注释（不再自动开 9444）
- `src/app/net-identity.ts`：debugger 复用归属注释

## 四、验证
- typecheck / lint / test / compile 全绿
- 真机验证（开发版 + CDP）：工具回传总耗时落在配置区间、手动发送即时性、长消息完整性
