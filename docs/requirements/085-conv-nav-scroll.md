---
id: 085
type: fix
title: 右侧对话导航滚轮失效（hover 强制正文滚底 + 导航自身压扁不可滚）
status: done
branch: feat/086-remote-fixes-and-nav
updated: 2026-10-19
---

# 085 fix — 右侧对话导航滚轮行为修复

## 现象

鼠标滚轮作用在右侧对话导航区（`.conv-nav`）时：

1. 中间历史消息区（`.stream`）滚动到底部；
2. 右侧导航自身不滚动。

## 根因（两个独立缺陷叠加）

### R1：hover 导航即强制正文滚底

`src/ui/harness.html` 中 conv-nav 区块顶部的 `document.addEventListener('mouseover', …)`（085 修复前位于 :3741-3752，现已删除）

```js
var convNavHovered = false;
document.addEventListener('mouseover', function (e) {
  var isInNav = e.target && e.target.closest && !!e.target.closest('.conv-nav');
  if (isInNav && !convNavHovered) {
    convNavHovered = true;
    pinBottom = true;
    settleScrollBottom(true);   // ← 鼠标进入导航即把正文拉到最底
    _lastScrollTop = stream.scrollTop;
  } else if (!isInNav && convNavHovered) {
    convNavHovered = false;
  }
});
```

鼠标只要进入导航区域，正文就被强制滚到底。这是"滚轮在导航上，正文却滚到底"的直接原因。

历史意图（注释所述）是"hover 导航 → 回到最新消息"，但该职责已由
`#scroll-bottom` 按钮与点击导航条目承担，hover 代劳属于越权交互：
用户想看导航，正文却跑掉了。

### R2：导航条目被压扁，自身无溢出可滚

`src/ui/harness.html:858,863`

```css
.conv-nav { ... max-height: 72%; overflow-y: auto; ... }
.conv-nav-dot { ... display: flex; ... }
```

`.conv-nav` 是 flex 列容器，`.conv-nav-dot` 作为 flex 子项默认
`flex-shrink: 1`。条目一多，容器在 `max-height:72%` 约束下把所有子项压扁，
最终 `scrollHeight == clientHeight` → **没有可滚动溢出**，滚轮无处可去。

（同理需确认 `.cn-bar` 已有 `flex-shrink:0`，dot 本身也需固定不收缩。）

### R3：导航内滚动时 tooltip 不隐藏

`src/ui/harness.html` 中 tooltip 区块的 `window.addEventListener('scroll', …, true)`（085 修复前位于 :5268-5271，现为 :5255 起的捕获监听）

```js
window.addEventListener('scroll', function () {
  if (activeTarget && activeTarget.closest && activeTarget.closest('.conv-nav')) return;
  hideTooltip();
}, true);
```

该分支本意是"正文滚动不打断导航 tooltip"，但 `.conv-nav` 自身内部滚动同样
不触发隐藏 → 导航滚动后 tooltip 位置错位。

## 方案

| # | 改动 | 文件 |
|---|---|---|
| 1 | 删除 hover 强制滚底整段监听（含 `convNavHovered` 变量与注释） | `src/ui/harness.html` |
| 2 | `.conv-nav-dot` 增加 `flex-shrink: 0`，使 `max-height` 真正触发滚动 | `src/ui/harness.html` |
| 3 | 导航自身滚动时隐藏 tooltip（区分"正文 scroll"与"导航内 scroll"） | `src/ui/harness.html` |
| 4 | 新增 `syncConvNavBottom()`：正文贴底时导航同步滚到底，让最新锚点始终可见 | `src/ui/harness.html` |

### 第 4 项细节（同步锚点可见）

用户的核心诉求是"导航也要滚到底，才能看到最新的对话导航"。仅修 R1/R2 只是让导航**可**滚，
不会自动跟随——消息一多仍需手动往下滑。

新增纯函数 `syncConvNavBottom()`，挂到 7 个贴底路径：
- `scrollBottom()` 的 hidden / rAF 两个分支
- `settleScrollBottom()` 的 hidden / 收尾两个分支
- `updateConvNav()` 渲染完新锚点后（`if (pinBottom)`）
- 正文 scroll 事件里"恢复到贴底"的分支

**只单向同步**（正文 → 导航），用户仍可单独在导航上滚轮查看历史锚点，不会被拉回。

改后行为：

- 滚轮在导航上 → 只滚导航列表，正文不动；
- hover 导航 → 不再把正文拉走；
- 导航条目多时可正常滚动，`active` 高亮仍由正文滚动驱动，互不干扰；
- 导航内滚动时 tooltip 正确隐藏；
- **正文贴底时导航自动跟到底，最新锚点始终可见**。

## 影响面

- 仅纯净模式 harness UI（`src/ui/harness.html`，真源非生成物）；
- 不涉及 IPC / 工具 / hook，无跨模块副作用；
- 正文"自动贴底"逻辑（`scrollBottom` / `settleScrollBottom`）不变，
  仅移除 hover 导航这一条触发源。

## 验证

- [x] typecheck / test / lint / compile 全绿
- [x] 真机（CDP 9444）：
  - 导航条目超过 `72%` 高度时滚轮可滚导航（实测 scrollHeight=731 > clientHeight=533）
  - hover 导航正文不跳到底（已移除 hover 监听）
  - 点导航条目仍能跳转对应消息（未改动 fastScrollTo）
  - 正文流式输出仍自动贴底（pinBottom 未被破坏）
  - **正文贴底时导航自动跟到底**（实测 nav.scrollTop 从 0 → 198.4 = max 198）
