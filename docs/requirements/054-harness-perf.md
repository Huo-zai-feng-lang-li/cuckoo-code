---
id: 054
type: performance
title: harness 流式渲染 O(n²) + 历史持久化全量同步写卡顿
status: done
branch: perf/054-harness-perf
created: 2026-10-15
updated: 2026-10-15
---

## 背景

审计发现 harness（纯净对话模式，\`src/ui/harness.html\`）有两处**用户可感知的卡顿 bug**：

1. **流式渲染 O(n²)**（L2475-2533）：onStream 每帧带「全量正文/思考」，每帧对**全文**跑 \`renderMarkdown\`（2 次全局正则 + marked.parse + 1 次全局正则）+ \`innerHTML\` 全量重建；think 也每帧 \`textContent = 全量\`。长回复（>2000 字）末端每秒数十次全量解析 → harness UI 卡顿（用户可感知）。
2. **历史持久化全量同步写**（L867-896）：\`pushHist\` 每次（每次回复 / 每次工具 start/end / 每次系统消息）都调 \`saveHist\` → 对**整个 history 数组**（最多 400 条 × 6000 字符/字段 ≈ 数 MB）做 \`JSON.stringify\` + \`localStorage.setItem\`（同步 API），阻塞 harness 渲染进程主线程。长会话下卡顿明显。

## 目标

消除两处 O(n²) / 同步阻塞，保持对外行为不变（含 Markdown 最终渲染、思考展示、历史持久化）。

## 改动

### 1. 流式渲染改增量纯文本 append（核心）
- 新增 \`_streamRenderedText\` / \`_streamRenderedThink\`：记录已渲染的全量文本长度。
- \`onStream\` 非 finished 帧：对 think / text 只 **appendChild(createTextNode(delta))**（delta = 全量.slice(已渲染长度)）；不再每帧 renderMarkdown / innerHTML 重建。
- 回退保护：若全量不以已渲染为前缀（异常重排），清空重来。
- cursor：保留在 body 末尾，每次 append 前插。
- finished 帧：仍走原逻辑 \`cur.body.innerHTML = renderMarkdown(text)\`（全量一次）保证收尾正确。
- 会话切换 / resetConversation 时重置两个渲染标记。

### 2. saveHist 改节流合并
- 新增 \`scheduleSaveHist()\`：500ms 合并窗口，窗口内多次 pushHist 只实际写盘一次。
- \`pushHist\` / 工具 end 路径改调 \`scheduleSaveHist()\`（非关键路径）。
- **关键路径**（会话切换 onSessionChanged、resetConversation、beforeunload）保留立即 \`saveHist()\`，防止丢数据。
- 挂 \`window.addEventListener('beforeunload', ...)\` 兜底 flush 未落盘的 timer。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 用户真机验证：长回复流式流畅度、长会话下多轮工具调用不卡

## 备注

这两项按 053 标准判定为"用户可感知的体验退化（长回复/长会话必现）"，属 bug。
