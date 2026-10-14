---
id: 049
type: feature
title: 提交详情 diff 结构化渲染（摘要卡 + 文件列表 + 行号 + 降噪）
status: doing
branch: (直接主分支)
created: 2026-10-14
updated: 2026-10-14
---

## 背景

需求 046 的提交详情展示的是 `git show` **原始输出**逐行着色，噪点多、看不懂：
commit 全 hash / Merge / Author / Date / index / --- / +++ 都直接显示，`@@ -1,8 +1,23 @@` 这种记号看不懂，红绿代码混在灰色文本里。

## 目标

把 diff 变成**结构化、一眼看懂**的展示。

## 改动

### 解析层（git.ts）
- `parseDiff()`：把 git show 输出解析成 `{ subject, author, date, short, files[], adds, dels }`，每个文件含 hunks[]，每行含 `{ t: ctx|add|del, o:旧行号, n:新行号, text }`
- 降噪：丢弃 commit/index/---/+++/new file mode 等内部标记

### 渲染层（git.ts）
- `renderDiffHtml()`：摘要卡 + 文件列表 + 逐文件正文（双列行号 + +/- 符号）
- 文件列表项可点击 → 跳到对应文件正文
- 文件头 sticky（滚动时吸顶）

### 样式（pages.css）
- 对比度修正：正文用主文字色（原用 --ck-text-2 发灰）、行号去掉叠加 opacity、增删背景加深

## 验证

- typecheck / test 980 / lint 0 error / compile 全绿
- 真机：打开提交详情 → 摘要卡（subject+hash+作者+统计）、文件列表（每文件增删）、正文（行号+符号）；codeColor=主文字色、lnOpacity=1