---
id: 077
type: feature
title: 更新弹窗重设计（版本号 + 更新日志 + 品牌化浮窗）
status: done
branch: feat/077-update-popup-redesign
created: 2026-10-17
updated: 2026-10-17
---

# 077 — 更新弹窗重设计

## 背景
现有「发现新版本」弹窗是通用确认框（kind=update），信息量单薄：只有一行"是否立即更新？将自动下载并重启安装"，缺少版本号、更新内容、体积等用户决策所需的关键信息。

## 目标
把"发现新版本"弹窗做成**专属版式**：品牌化、信息完整、不打扰。
- 保持右下角浮窗定位（不抢焦点）
- 展示：当前版本 → 新版本 + 更新日志条目 + 体积提示
- 视觉方向：单强调色、等宽字体版本号、发丝分隔的日志行、锁定圆角
- 支持下载中状态（真实进度）

## 方案
**扩展通用 confirm-window，而非新建弹窗**——理由：
1. 复用现有的单例、窗口定位、置顶、preload、action 回传机制
2. kind='update' 已存在，只被 updater 使用，无其它调用方受影响
3. 新增**可选字段** version / newVersion / notes / sizeText，仅当传入时才渲染对应区块；旧调用不传即保持原样

### options 扩展（向后兼容）
ConfirmDialogOptions 新增可选字段：
- version?: string       当前版本（如 "0.9.17"）
- newVersion?: string    新版本（如 "0.9.18"）
- notes?: string[]       更新日志条目
- sizeText?: string      体积提示（如 "约 82 MB"）
- state?: 'idle' | 'downloading'   初始状态（默认 idle）

### 主进程 → 渲染进程
- confirm-window.ts 的 did-finish-load 里把新字段一并 send
- confirm-window.html 按字段存在与否切换渲染
- 下载进度：新增 IPC confirm-progress（主进程 → 渲染进程），updater 在 download-progress 事件中推送

## 关键文件
- src/ui/confirm-window.html（版式重做）
- src/app/confirm-window.ts（options 扩展 + 进度转发）
- src/app/confirm-preload.ts（暴露 onProgress）
- src/updater/index.ts（调用方传版本/日志/体积 + 推送进度）

## 验收
- typecheck / test / lint / compile 全绿
- 真机 CDP 验证："发现新版本"弹窗显示版本区 + 日志；点「立即更新」切下载态显示真实进度
- 旧调用（错误重试 / 更新已就绪）不传新字段 → 版式保持不变
