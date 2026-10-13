---
id: 048
type: performance
title: harness 流式渲染节流（rAF 合并，消除 O(n²)）
status: doing
branch: (直接主分支)
created: 2026-10-14
updated: 2026-10-14
---

## 背景

`src/ui/harness.html` 的 `onStream` 每帧携带**全量正文**，原实现每帧直接 `cur.body.innerHTML = renderMarkdown(text) + 光标`。
`renderMarkdown` 是**全量解析**（marked + KaTeX），逐帧全量重渲 → 单轮回复累计 **O(n²)**，正文越长每帧越贵。

## 目标

降低流式渲染开销，保持渲染结果与交互行为不变。

## 改动

- 非 finished 帧：用 `requestAnimationFrame` 合并（同一帧内多次 SSE 更新只渲染最后一次）
- finished 帧：绕过节流**立即**渲染（去掉光标），保证收尾无延迟
- `_doStreamRender` 加 guard `cur && cur.body === body`（防旧气泡/收尾后的 rAF 把光标画回来）
- `cancelStreamRender` 同时清 body 与 text（显式化隐式契约）
- `clearTransientState`（切会话/新对话）显式调 `cancelStreamRender()`，消除挂起 rAF 的多余滚动副作用

## 验证

- typecheck / test 980 / lint 0 error 全绿
- 真机：注入 3 帧非 finished + 1 帧 finished，最终正文完整、收尾光标正确消失（hasCursor=false）
- code-reviewer 审查：无必须修复项，采纳其 2 条建议（cancel 清 text / clearTransientState 调 cancel）