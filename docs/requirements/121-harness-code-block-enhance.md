---
id: 121
type: feat
title: 纯净模式代码块增强（语法着色 + 独立复制）
status: done
branch: feat/121-harness-code-block-enhance
created: 2026-11-13
updated: 2026-11-13
---

# 需求 121：纯净模式代码块增强（语法着色 + 独立复制）

## 1. 背景

纯净对话模式（harness）此前会把 ```js / ```javascript 块当工具调用一并剥离，用户看不到代码块。上一轮已把 `stripToolBlocks` 收窄为只剥 ```cuckoo（见 `src/bridge/harness-bridge.ts`），代码块现在能正常显示了。

但 `renderMarkdown` 只是 `marked.parse` + sanitizer，**没有任何代码块后处理**：

1. **无语法着色** —— 依赖里没有高亮库，marked 只产出 `<pre><code class="language-x">` 纯文本；
2. **无独立复制按钮** —— 只有整条消息复制（`attachAssistantActions`），无法单独复制某个代码块。

手机端 PWA（`src/remote/pwa/app.js` 的 `decorateContent`）已有「语言标签 + 复制」实现，但同样没有着色。

## 2. 方案

### 2.1 语法着色：highlight.js（按需打包）

- 新增 devDependency `highlight.js`；
- 新增 `scripts/build-hljs.mjs`：用 esbuild 从 `highlight.js/lib/core` 打包，**只注册常用语言**（js/ts/jsx/tsx/python/json/bash/shell/html/css/scss/markdown/yaml/sql/java/c/cpp/csharp/go/rust/php/ruby/kotlin/swift/dockerfile/ini/plaintext），输出 IIFE 到 `src/ui/vendor/hljs/hljs.min.js`，挂 `window.hljs`；
- 仿 `build-sanitizer.mjs`，接入 `npm run compile`。

体积预估：core + 20 余种语言 ≈ 120–180KB（未压缩）/ 60KB 左右 gzip，本地加载无网络开销。

### 2.2 代码块增强（统一出口）

在 `renderMarkdown` 返回前统一调用 `decorateCodeBlocks(html)`，一次改动覆盖全部 6 个渲染入口（流式 / finished 帧 / assistant-done / 历史恢复等）。

- 用 `<template>` 解析 HTML，遍历 `pre > code`：
  - 有 `language-xxx` → `hljs.highlight(code, {language})`；语言未注册 / 高亮抛错 → 降级 `hljs.highlightAuto` 再降级纯文本（**绝不让高亮失败吞掉代码**）；
  - 包一层 `.code-wrapper`，加 `.code-header`（语言标签 + 复制按钮）；
  - 复制按钮不带内联监听，走 **`#stream` 上的事件委托**（`data-ck-copy`），避免流式每帧 `innerHTML` 重建导致监听丢失；
  - 复制文本从 `code.textContent` 取，不读 `innerText`（避免高亮 span 干扰）。

### 2.3 样式

- `.code-wrapper / .code-header / .code-lang / .code-copy-btn` 对齐 PWA 视觉；
- hljs token 配色用 CSS 变量定义明暗两套（跟随 `body[data-ck-dark]`），不引 hljs 自带主题 CSS（其主题写死颜色，与主题系统冲突）。

### 2.4 顺带修复：整条复制 / 删除匹配被头栏污染

加了头栏后，原有的「整条消息复制」与「按文本匹配历史条目删除」都取自 `body.innerText`，
会把语言标签、「复制 / 已复制」文案混进文本。新增 `plainBodyText()`：克隆正文 → 剥掉
`.code-header` → 临时离屏挂进文档量取 `innerText`（脱离文档的节点 innerText 退化为
textContent，会丢段落换行）→ 立刻移除。4 处取文点统一改走它。

### 2.5 产物与打包

- `scripts/build-hljs.mjs` 接入 `npm run compile`；产物 `src/ui/vendor/hljs/hljs.min.js`（126KB / 24 种语言）**随仓库跟踪**，与 katex 同策略（Monaco 因体积单独忽略）；
- 打包无需改配置：`files` 已含 `src/ui/vendor/**`，运行期由 `resolveSrc` 直接从源码目录加载；
- CSP 无需放宽：已允许 `script-src 'self'`。

## 3. 不做的事

- 不改 PWA（手机端另开需求）；
- 不改工具卡片里的代码区（`.tool-pre` 已有自己的样式，与正文代码块语义不同）；
- 不引 Prism / Shiki（体积/异步加载成本更高）。

## 4. 验收

1. 纯净模式回复里的 ```js / ```ts / ```json 等代码块有语法着色；
2. 每个代码块右上角有语言标签 + 复制按钮，点击复制成功并回显「已复制」；
3. 流式输出期间代码块正常着色、按钮可点（不因重建失效）；
4. 未知语言 / 高亮异常时降级为纯文本，代码不丢失；
5. 明暗主题下配色均可读；
6. `typecheck / test / lint / compile` 全绿，真机复验。

## 5. 结果

- 四门禁全绿：146 测试文件 / 1490 用例；lint 0 error（73 条既有 warning）。
- `test/ui/harness-page.test.js` 新增 6 个用例（结构接线、事件委托、降级、CSP、样式 token、头栏剔除）。
- 真机复验：用户实机确认通过（着色 + 复制正常）。
- 已发布 v0.10.227。
