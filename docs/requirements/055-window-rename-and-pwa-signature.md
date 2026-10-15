---
id: 055
type: fix
title: 窗口组下拉配色 + 窗口名编辑 + 手机端 AI 尾部签名
status: done
branch: fix/055-window-rename-and-pwa-signature
created: 2026-10-15
updated: 2026-10-15
---

## 背景

用户反馈三处问题：

1. **窗口组「添加窗口」下拉框配色**：深色主题下 option 文字看不清（浅色文字 + 浅色背景），无法分辨可用窗口。
2. **窗口名不可编辑**：窗口卡片只能删除/勾选默认打开，改不了显示名；\`profile.ts\` 已有 \`updateProfileName()\` 但未对外暴露 IPC。
3. **手机端 AI 消息视觉不一致**：电脑端每条 AI 消息顶部有 \`✦ Cuckoo\` 前缀，手机端没有；用户要求把 \`✦ Cuckoo\` 放到**消息尾部**代替流式光标（一物两用：流式期间充当光标，结束后作为署名）。

## 目标

- 窗口组下拉在深色主题下可读；
- 窗口卡片支持改名（持久化到 profile-list.json）；
- 手机端 AI 消息尾部固定 \`✦ Cuckoo\`（用电脑端同款四角星 SVG），流式光标用此签名替代。

## 改动

### 1. 窗口组下拉配色（\`src/ui/shell/styles/components.css\`）
- 现有 \`.ck-set-input option\` 已做深色处理（L255-258）；扩展为通用 \`select.ck-input option\` 也跟随 color-scheme，避免「添加窗口」下拉文字看不清。

### 2. 窗口名编辑
- **主进程**：\`src/app/ipc/shell.ts\` 新增 IPC \`rename-profile\` → 调用 \`profileManager.updateProfileName()\`；同步更新当前窗口标题（若正在改名的是当前窗口）。
- **preload**：\`src/app/shell-preload.ts\` 暴露 \`renameProfile(profileId, name)\`。
- **类型**：\`src/ui/shell/scripts/shell-api.ts\` 补 \`renameProfile?\`。
- **UI**：\`src/ui/shell/scripts/pages/windows.ts\` 的 \`renderWindowItem\` 增加编辑入口（点击窗口名进入编辑态，或加编辑小图标）；用现有 \`ckPrompt\` 复用通用输入弹窗；改名后重新渲染列表。

### 3. 手机端 AI 尾部签名
- \`src/remote/pwa/app.js\`：
  - 新增 \`SIG_HTML\` 常量（同电脑端四角星 SVG + \`Cuckoo\` 字样）。
  - \`startStreaming\`：不再创建 \`.cursor\`，改为创建 \`.msg-sig\` 节点，流式时保持末尾。
  - \`appendStreaming\`：把新增文本 append 到 sig 之前（保持 sig 始终在末尾）。
  - \`finishStreaming\` / \`addAi\`：渲染后追加 sig 节点。
  - 移除 \`.cursor\` 相关逻辑（\`clearOrphanCursor\` 等），或保留为兼容旧消息。
- \`src/remote/pwa/style.css\`：删除 \`.cursor\` + \`starFlow\` 动画；新增 \`.msg-sig\` 样式（小字、accent 色、四角星图标、与正文同基线）。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机验证：窗口组下拉可读、窗口改名生效、手机端消息尾部签名正确

## 备注

三项分别独立，可单独回滚。
