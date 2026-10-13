---
id: 043
type: fix
title: 规则页保存提示撑坏布局（icon-only 按钮被改 textContent）
status: done
branch: fix/043-rule-save-tip
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

v0.8.44 给规则页加了「保存成功后提示新对话生效」。实现是直接改保存按钮的 `textContent`：

```ts
const orig = saveBtn.textContent;
saveBtn.textContent = '已保存 · 新对话生效';
setTimeout(() => { saveBtn.textContent = orig; }, 2000);
```

但保存按钮是 **icon-only**（`.ck-rule-icon-only`，固定 30px 宽，内容是一个 SVG 图标）：
- 改 `textContent` 会**摧毁 SVG 图标**（按钮只剩文字）；
- 长文本在 30px 宽内**竖排换行**，把按钮行撑坏。

## 目标

保存成功后提示「新对话生效」，且**不破坏按钮本身**。

## 设计

- 不改按钮，改为在按钮所在行（`.ck-rule-editor-actions`，flex 容器）**末尾临时插入**一个 `<span class="ck-rule-saved-tip">`，2 秒后 `remove()`。
- CSS：`flex:0 0 auto` + `white-space:nowrap`，横向排布不换行；`--ck-green` 绿色 + `ck-toast-in` 入场动画。

## 验收

- 保存规则后，按钮行末尾出现绿色「已保存 · 新对话生效」，2 秒后消失；
- 保存按钮的 SVG 图标**始终完好**，布局不撑坏。
