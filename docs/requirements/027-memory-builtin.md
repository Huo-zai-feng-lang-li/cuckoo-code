---
id: 027
type: feature
title: 记忆功能内置化（从插件改为内置页）
status: done
branch: feat/027-memory-builtin
created: 2026-10-12
updated: 2026-10-12
---

## 背景

「记忆」功能的核心能力（存取、注入系统提示词、remember 工具）一直是**内置**的。但**管理界面**被抽成了独立插件 `cuckoo-memory`，由插件市场安装。

问题：
1. **插件界面有 bug**：旧版用隐藏 `<img onerror>` 触发脚本，但面板默认 `display:none` → `onerror` 永不触发 → 一直"加载中"。
2. **修复脆弱**：手动改插件文件后，插件自动更新（`autoUpdate: true`）会从上游重新拉取，**覆盖本地修复**。
3. **按钮不可用**：插件用原生 `prompt()`/`confirm()`，而 Electron 禁用原生 `prompt`（返回 null）→ 新建/编辑/删除全部无反应。

结论：管理界面不该依赖易变的第三方插件，应内置。

## 目标

把记忆管理界面**内置**到壳页面，与核心记忆数据共享，不再依赖插件。

### 范围

- ✅ 内置记忆页（列表 / 新建 / 编辑 / 删除），复用已有的 `pages/memories.ts` + `pages/memories.html`
- ✅ 活动栏加「记忆」图标
- ✅ 把自定义弹框（ckPrompt/ckConfirm/ckAlert）挂到 `window`，供插件与内置页共用
- ✅ 禁用 `cuckoo-memory` 插件（避免两个入口冲突）
- ✅ 修正关于页文案（"已禁用在线更新" → "支持自动更新"，与实际不符）

## 方案

### 内置页接线（代码已存在，仅需挂载）

- `index.html`：`@include partials/pages/memories.html`
- `main.ts`：`registerTab('memories', loadMemories)`
- `activitybar.html`：加记忆图标（灯泡形状）

### 弹框公共能力

`main.ts` 把 `ckPrompt`/`ckConfirm`/`ckAlert` 挂到 `window`——Electron 禁用原生 `prompt`，插件/内置脚本需要这套自定义弹框。

## 验收标准

- [ ] 活动栏出现「记忆」图标
- [ ] 列表正确显示现有记忆（跨会话保留）
- [ ] 新建 / 编辑 / 删除均正常（弹框可用）
- [ ] 禁用 `cuckoo-memory` 插件后无冲突
- [ ] typecheck + lint + compile + test 全绿

## 遗留

- 插件 `cuckoo-memory` 保留（未卸载），仅禁用；如上游修复可考虑恢复
- 快照（cuckoo-snapshot）仍是插件形态，未纳入本次
