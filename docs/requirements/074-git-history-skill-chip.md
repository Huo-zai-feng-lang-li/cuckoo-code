---
id: 074
type: fix
title: Git 提交历史高度自适应铺满底部 + 技能 chip 有文字时被吞
status: done
branch: fix/074-git-history-skill-chip
created: 2026-10-16
updated: 2026-10-16
---

# 074 — Git 历史高度自适应 + 技能 chip 显示修复

## 背景
1. **Git 提交历史固定 max-height:320px**：用户希望它自适应铺满侧栏底部；若有暂存改动文件，则保留一个最小历史区高度。
2. **技能 chip 有文字时被吞**：harness `send()` 的气泡文本是互斥 if-else，有文字时技能/工具 chip 标签被丢弃（功能正常——技能已发给 AI，仅界面不显示）。

## 目标
1. Git 面板撑满侧栏高度；提交历史铺满底部（无改动时）；有改动文件时历史保留最小高度（~140px）。
2. harness 气泡同时显示「文字 + 技能/工具标签」。

## 改动文件
- `src/ui/shell/styles/pages.css`（git 面板 flex 布局）
- `src/ui/shell/scripts/pages/git.ts`（如需要，历史渲染不需改）
- `src/ui/harness.html`（气泡文本组装）

## 验收
- Git 面板：无改动时历史铺满底部；有改动时历史保留最小高度、改动列表自身滚动。
- 纯净模式：打字 + `/` 选技能 → 气泡同时显示文字和 `[指令] 技能: xxx`。
- typecheck / test / lint / compile 全绿。
