---
id: 057
type: fix
title: 二次审计整改：056 R1（stop/error 尾帧仍丢）+ 055 小瑕疵
status: done
branch: fix/057-audit-rectify-r2
created: 2026-10-16
updated: 2026-10-16
---

## 背景

对 v0.8.83（055）、v0.8.84（056）做二次审计，发现：

### 🔴 R1（056 遗留）：stop/error 尾帧实际仍丢
- **原以为修好**：056 让 bridge 层 `stopStreamThrottle(true)` 先 flush pendingText。
- **实际未生效**：bridge flush 后 → manager `onAiStream` 只是 `setTimeout(flushStream, 100)`；紧接着 `ai-stop` 到达 → `onAiStop` 里 `clearTimeout(s.timer)` + `s.text=''` → 排队的 flush 永远不会执行。
- **根因**：`onAiStop` / `onAiError` 清 timer 前**未先把未广播的 `s.text` flush 出去**。
- **修复**：两处终帧里，clearTimeout 后若 `s.text && s.text !== s.sent`，调 `flushStream(pid)` 再清。

### 🟡 N1（055 遗留）：rename-profile 缺"本窗口"校验
- `entry.ts:1409-1410` 只校验 `ctx` 非空，未校验 `profileId === ctx.profileId`。
- 任一窗口的壳页面可改**任意**窗口名。风险低但纵深防御不完整。
- **修复**：加 `if (ctx.profileId !== profileId) return { success:false, error:'非法来源' }`。

### 🟡 ②（055 引入）：update-window-name 隐性截断
- `update-window-name`（DeepSeek 提取用户名）→ `updateProfileName` → 内部 `slice(0, 50)` 静默截断。
- 用户重命名有显式 50 字上限提示；平台提取则无反馈。
- **修复**：加注释说明"名字上限 50 字（用户重命名与平台提取统一约束）"，不改行为。

### 🔵 O1（056）：`dataset.raw` 是死数据（无读取点）
- 复制走闭包 `rawText`，不读 `dataset.raw`。056 已消除流式每帧写入，`finishStreaming`/`addAi` 各写一次仍无效。
- **修复**：删除这两处写入。

### 🔵 O3（056）：bridge timer 触发后未清 pendingText
- timer 回调只清 `streamTimer`，未清 `pendingText`。极端场景（timer 刚触发 → 下一次 onStream 之前）stop → 重复 flush 上次全量。
- 主进程 startsWith 兜底使危害极低；修完 R1 后应一并处理。
- **修复**：timer 回调里补 `pendingText = ''`。

### 🔵 N2（055）：`ensureSigNode` 是死代码
- app.js:517-521 定义后从未调用。
- **修复**：删除。

## 验证

- typecheck / test / lint / compile 全绿
- 子代理审计 + 主代理复核
- 真机验证：stop 后立即看手机端，最后 <100ms 文本不丢

## 备注

R1 是 056 目标未达成的真缺陷；其余为纵深防御/死代码清理。
