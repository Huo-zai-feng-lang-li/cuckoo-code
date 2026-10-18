# 计划：自定义好看 Tooltip 与消息队列 / 导航优化

## 1. 目标与背景
用户提出三个核心问题/需求：
1. **纯净模式右侧导航 hover 判定**：确认右侧导航 hover 是否使用原生 `title`。
2. **消息队列体验优化**：
   - 去掉消息队列的 `title`（包括文本上的 `title="点击编辑"` 等）。
   - hover 底色高度铺满都变色（修复原本只有文字局部背景色、无法铺满整行的问题）。
   - 修复文字垂直居中问题（原本 `align-items: flex-start` 导致操作按钮与文本未在垂直方向居中对齐）。
3. **全局统一自定义 Tooltip**：
   - 彻底告别丑陋的原生 `title`（原生 tooltip 弹出延迟高、Windows 原生黄框/灰框极为粗糙且无法适配主题）。
   - 实现全局统一、自适应主题、平滑淡入淡出、智能防溢出边界定位的现代轻量级 Tooltip 系统。
   - 在纯净模式（Harness）与主窗口 Shell 中均完整接管所有 `title` 属性。

## 2. 详细技术方案

### 阶段一：纯净模式右侧导航与消息队列优化
- **文件**：`src/ui/harness.html`
- **右侧导航分析**：
  - 代码行 2268：`dot.title = full;`。
  - 确认原本确实直接赋了原生 `title`。
  - 在全局 Tooltip 挂载后，该属性会被优雅拦截转为自定义 Tooltip，或者设为 `data-tooltip`，彻底消除原生丑提示。
- **消息队列优化**：
  - 删除 `row.innerHTML` 中的 `title="点击编辑"`。
  - 调整 `.sq-item` 样式：
    - `align-items: center;`（单行/多行展示时按钮与文本垂直几何居中）。
    - hover 样式：`.sq-item:hover` 设置背景色 `var(--surface)` / `var(--surface-hover)`，边框强化，实现 100% 高度铺满变色。
    - 去除 `.sq-text:hover` 的局部孤立底色，使整体铺满一致。
    - `.sq-text` 调整行高与 padding，确保文字与按钮高度完全垂直居中。

### 阶段二：全局自定义 Tooltip 架构设计
- **设计原则**：
  - **零侵入与 100% 拦截**：事件委托监听 `pointerenter`/`pointerover`，一旦遇到 `[title]` 元素，立即将 `title` 值暂存入 `dataset.ckTooltip` 并执行 `removeAttribute('title')`，从源头扼杀浏览器原生 tooltip 弹出的可能。
  - **优雅外观**：
    - 采用暗黑/明亮自适应背景色（深色模式下半透明高质感深灰卡片，高斯模糊毛玻璃 `backdrop-filter: blur(8px)`，细腻发丝边框 `rgba(255,255,255,0.12)` 或 `var(--border-strong)`）。
    - 柔和微投影：`box-shadow: 0 6px 20px rgba(0,0,0,0.3)`。
    - 字体 11.5px，字重 500，内边距 5px 9px，圆角 6px。
    - 支持智能最大宽度 `max-width: 300px`，优雅自动折行（适合导航长标题）。
  - **交互与动效**：
    - 延迟：首个元素悬停 280ms 优雅淡入；若在有 tooltip 的元素间连续滑动（warm mode），立即切换无延迟（40ms）。
    - 动画：微位移 + 透明度淡入 `translateY(-2px) -> translateY(0), opacity 0 -> 1`。
    - 智能边界检测：自动计算 `getBoundingClientRect()`，默认显示在元素下方，若下方距离不足则自适应翻转到上方；左右两侧自动限制在视口边界内，永不出界。
    - 快速销毁：光标离开、点击、页面滚动、窗口失焦时立即隐去。
- **覆盖范围**：
  - `src/ui/harness.html`（纯净模式独立单页）内置该轻量 Tooltip 引擎与样式。
  - `src/ui/shell/`（主窗口 Shell）：在 `src/ui/shell/styles/components.css` 中增加样式，在 `src/ui/shell/scripts/` 中引入全局 Tooltip 引擎；通过 `npm run compile` 自动编译进 `src/ui/shell.html`。

### 阶段三：测试与验证
- 编写/扩充针对纯净模式消息队列、导航及全局自定义 Tooltip 的单测 `test/ui/harness-page.test.js` 和 Shell 单测 `test/ui/tooltip.test.js`。
- 执行 `npm run typecheck`、`npm run lint`、`npm test` 保证全部通过，0 回归。
- 更新 `.agents/handoff.md`。

## 3. 验收结果
- **纯净模式导航判定**：100% 确认为原生 title，现已重构为 `data-tooltip`，彻底接入统一自定义 Tooltip。
- **消息队列优化**：去除文本 `title`；hover 整行铺满变色（`sq-item:hover`）；`align-items: center` 彻底解决单行与多行文字未垂直居中的问题。
- **全局自定义 Tooltip**：跨 Shell、Harness、Platform-Select 全局自动拦截原生 `[title]`，提供微磨砂毛玻璃、智能快捷键微徽标（`ck-tooltip-kbd`）、边界防溢出与上下智能翻转，优雅现代。
- **自动化测试**：94 个测试文件、948 个用例全部通过，TypeCheck 0 错误，Lint 0 错误。

