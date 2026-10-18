# 需求档案 081：打开窗口/会话自动滚动到底部

- **编号**：081
- **类型**：fix
- **标题**：打开窗口/会话自动滚动到底部
- **状态**：done
- **分支**：(直接主分支)
- **更新**：2026-10-18

---

## 一、背景与问题

用户反馈：“打开窗口 怎么总是需要滚动到最底部，没有自动滚动吗”。
排查发现系统存在以下两层核心缺陷：

### 1. 纯净模式（Harness，系统默认启动模式）
1. **时序与尺寸脱节**：主进程创建 `harnessView` 时，初始大小为 `{ x: 0, y: 0, width: 0, height: 0 }`。
2. **提前同步执行**：`harness.html` 在 DOM 解析后同步执行 `restoreHist()`，末尾执行 `stream.scrollTop = stream.scrollHeight;`。此时由于视口宽高还是 0，`scrollHeight` 极小，设置了无效值。
3. **主进程延迟布局**：主进程在 100~300ms 后才通过 `layoutView()` 将视图撑大至 1200×800，DOM 重新排版撑高，但 `harness.html` 没有监听 `resize`，无法再次滚到底部。
4. **`pinBottom` 误判阻断**：视口撑大导致容器触发原生 `scroll` 事件，此时 `scrollTop` 仍是 0，导致 `isNearBottom()` 算出 `false`，系统误以为“用户正主动往上翻看历史”，将 `pinBottom` 标记为 `false`，并弹出了向下滚动按钮，从此彻底阻断自动滚底。
5. **缺少 resize 与 focus 响应**：切回窗口、最大化、缩放窗口时均未响应保持贴底。

### 2. 原版网页模式（WebContentsView 加载的官方网页）
`src/bridge/scroll-follow.ts` 仅处理了“切走再切回”的增量跟随，对于“初次打开窗口”或“点击侧边栏切换历史会话 URL”，快照为空，没有触发页面加载完成后的初次智能滚底。

---

## 二、架构方案与技术设计

### 1. 纯净模式（`src/ui/harness.html`）
- **退火式连续多帧与稳定检测**：
  在 `restoreHist()` 和 `onSessionChanged()` 后，使用多次 rAF 梯度贴底（如 0ms, 60ms, 180ms, 400ms），并在初始排版尚未稳定前开启 `suppressPin`，防止视口从 0 变大撑高时将 `pinBottom` 误改写为 `false`。
- **响应式视口贴底**：
  监听 `window.addEventListener('resize')` 与 `window.addEventListener('focus')`，当 `pinBottom === true` 时自动保持贴紧最底部。
- **ResizeObserver 监听内容容器高度稳定**：
  若内容容器或视口发生排版变化且处于 `pinBottom` 状态，平滑吸附底部。

### 2. 原版网页模式（`src/bridge/scroll-follow.ts`）
- **增加初次打开/会话切换后的智能寻底**：
  在页面完成加载或 URL 变更后，提供 `ensureInitialScrollToBottom()`，通过递增探测检测主滚动容器，当容器生成并有可滚动高度时平滑滚到底部，确保用户直接看到最新消息。

---

## 三、修改清单

- `docs/requirements/081-auto-scroll-to-bottom.md`：需求档案
- `src/ui/harness.html`：纯净模式初始化多帧贴底、尺寸变更防误杀与响应式吸底
- `src/bridge/scroll-follow.ts`：原版模式初次加载与切会话智能滚底
- `test/bridge/scroll-follow.test.js`：单元测试补齐

---

## 四、验证标准

1. `npm run typecheck` + `npm test` + `npm run lint` + `npm run compile` 全绿。
2. 单元测试覆盖初次滚底与状态保护。
