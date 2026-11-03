---
id: 105
type: fix
title: 桌面宠物窗口透明区域拦截鼠标点击（未开 setIgnoreMouseEvents）
status: done
branch: fix/105-desktop-pet-mouse-passthrough
created: 2026-11-03
updated: 2026-11-03
---

# 需求 105：桌面宠物窗口拦截鼠标点击

## 1. 背景

用户真机反馈：主窗口最小化后留在桌面上的宠物，**拖到任意程序图标旁边，那片区域就点不动了**；把宠物拖走，程序又能正常点。截图可见宠物拖到「QMaiWrite」图标右侧后，该区域点击失效。

## 2. 根因

`src/app/pet-window.ts` 创建的 BrowserWindow：

- 尺寸 `boundsFor()` = `max(220, px*1.9)` × `px+220`（默认宠物 96px → **220×316**）；
- `transparent: true` + `frame: false`，**只有宠物本体与气泡是可见像素，其余大片是透明的**；
- **从未调用 `setIgnoreMouseEvents`**。

而 `src/ui/pet-window.html` 里 `#stage { position: absolute; inset: 0; -webkit-app-region: drag }` 铺满整窗。

结果：整块 220×316 的透明矩形都在接收鼠标事件（Windows 上透明窗口的透明像素**不会**自动穿透），把下面的桌面图标/其他程序全挡住了。

对照：`src/app/entry.ts` 的插件覆盖层窗口是同类透明浮窗，但它创建后立即 `ow.setIgnoreMouseEvents(true, { forward: true })` —— 桌面宠物漏了这一步。

## 3. 修法

**默认全穿透 + 悬停命中检测**（Electron 透明浮窗的标准做法）：

1. 窗口创建后立即 `setIgnoreMouseEvents(true, { forward: true })`，让整窗默认穿透；
2. 主进程用定时器（32ms 约 31 FPS）读 `screen.getCursorScreenPoint()`，把光标换算成窗口内坐标；
3. 命中「宠物本体矩形」时 `setIgnoreMouseEvents(false)`，移出时恢复 `true`；
4. **拖动期间锁定为接收**：指针捕获一旦因穿透丢失，`pointerup` 就收不到，拖动会粘死；并在 `blur` 事件上做三重释放兜底；
5. 拖动边界计算联合所有显示器 bounds/workArea，支持多屏跨屏拖拽；
6. 窗口隐藏/销毁时停止定时器，避免空转。

宠物本体矩形由渲染进程上报（渲染层最清楚当前动画的绘制框），主进程只负责坐标换算与开关。

## 4. 关键设计决策

| 决策 | 理由 |
|---|---|
| 不用 CSS 逐元素穿透 | Electron 无「按像素穿透」能力，只能整窗开关 |
| 命中矩形由渲染进程算 | 主进程不知道当前动画的 box（每帧变化），渲染层已有精确值 |
| 轮询而非 mousemove | 穿透状态下窗口收不到任何鼠标事件，只能主动查光标 |
| 拖动期间强制接收 + blur 兜底 | 防指针捕获丢失导致拖动中断，防 Alt+Tab/Win+D 导致 dragLock 死锁 |
| 32ms 轮询 | 平衡交互敏锐度与 CPU/功耗唤醒开销 |
| 多屏联合边界 Clamp | 允许跨屏拖拽，同时防止窗口完全甩出屏幕外丢失 |
| 命中区外扩 4px | 宠物像素画边缘是渐隐的，严格贴矩形会导致「看得到却点不到」 |

## 5. 影响面

- 仅影响桌面宠物浮窗（`pet-window.ts` / `pet-window.html` / preload）；
- 纯净模式宠物、插件覆盖层、主窗口均不受影响。

## 6. 验证

- [x] 宠物拖到桌面图标旁，图标可正常点击
- [x] 宠物本体仍可拖动、左键彩蛋动画、右键恢复主窗口
- [x] 气泡区域不拦截点击
- [x] 窗口失焦时拖动锁定自动重置，穿透正常恢复
- [x] 主窗口恢复后宠物窗隐藏，轮询停止
- [x] typecheck / lint / test / compile 全绿
- [x] 跨屏拖拽与多显示器兼容性验证通过
