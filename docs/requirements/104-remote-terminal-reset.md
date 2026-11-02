---
id: 104
type: fix
title: 手机端「延迟发送」永久卡死（终态事件被窗口过滤丢弃）+ 手机宠物气泡间距过高
status: done
branch: (直接主分支，用户要求先真机验证，不提交)
created: 2026-11-02
updated: 2026-11-02
---

# 需求 104：手机端延迟发送卡死 + 手机宠物气泡间距

## 1. 背景

用户真机反馈两个问题：

1. **手机端「延迟发送 Ns…」卡到几百秒不消失**，而电脑端已经正常跑完好几轮工具。手机与电脑状态彻底脱节。
2. **手机端宠物气泡离宠物头顶太远**，看着悬空。

## 2. 根因（问题 1，真 bug）

`src/remote/pwa/app.js` 的 `handleServerMessage` 里，**所有**终态分支都走 `isMyProfile(msg.profileId)` 严格过滤：

```js
function isMyProfile(pid) {
  if (!profilesReady || !currentProfileId) return true;  // 连接初期：宽松
  return pid === currentProfileId;                       // 收到窗口列表后：严格
}
```

而「延迟发送」计时器的**唯一**停表途径就是这些终态事件（`ai-start` / `ai-reply` / `task-done` / `ai-stop` / `ai-error` / `sys`）。一旦手机端 localStorage 里的 `cuckoo-last-profile` 与电脑端广播的 profileId 失配（换过窗口 / 新建对话 / 旧值过期），**所有能停表的事件全被静默丢弃**，而 `setInterval` 本身没有任何自停条件 → 永久数秒。

致命组合：
- 开始计时（`tool: sending`）发生在**宽松期**（`profilesReady` 尚未置真）→ 进来了；
- 停表事件发生在**严格期** → 全被丢弃。

`isMyProfile` 的"宽松→严格"切换本身是为首屏不丢消息，但终态收尾被一起卷进了严格判定。

## 3. 根因（问题 2）

`src/ui/pets/pet.js` 的 `anchorBottom()` 里气泡间距**硬编码 16px**：

```js
return visibleH + 16;
```

（注释还写着"故留 52px"，与代码早已不一致。）

桌面宠物 `petDesktopSize` 默认 160~215px，16px 相对不显；手机端宠物固定 64px，同样的 16px 就是明显悬空。

## 4. 方案

### 4.1 延迟发送：三层防线

| 层 | 做法 | 作用 |
|---|---|---|
| 兜底 | `startSendTick` 增加 `sendHardStopTimer`（45s） | 任何情况下都不会再挂几百秒（正常延迟仅 6~16s） |
| 治本 | 终态事件（`ai-reply`/`task-done`/`ai-stop`/`ai-error`/`sys`）**不再做 profileId 判定** | 收尾动作对所有窗口都安全，杜绝漏收 |
| 拆分 | `sys` 分支：复位无条件执行，仅**文案显示**仍按窗口过滤 | 原实现一条判定同时管两件事，窗口过期时连复位一起吞 |

`ai-start` 也把 `stopSendTick / stopToolTick` 提到过滤之前（幂等动作，先停表再判内容）。

**为什么不担心串窗口**：终态事件只做"停表 + 隐藏执行条 + 复位按钮"，不含对话内容。误收最多提前收尾一次，下一轮 `ai-start` 立即重建。真正会污染界面的流式内容（`ai-start` 后续逻辑 / `ai-stream` / `tool` / `history`）**仍走严格 `isMyProfile`**。

### 4.2 气泡间距：可配置

`pet.js` 的 `create()` 新增可选 `opts.bubbleGap`（默认 16，**不传时桌面端行为完全不变**），`anchorBottom` 改用它。`mobile-pet.js` 传 `bubbleGap: 8`。

同时把那段"52px"的过期注释改成与代码一致的说明。

## 5. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/remote/pwa/app.js` | 常量 `SEND_TICK_MAX_MS=45000`；变量 `sendHardStopTimer`；`startSendTick` 加硬超时；`stopSendTick` 清理它；终态分支去掉 profileId 判定；`sys` 拆分复位与文案；`ai-start` 停表前置 |
| `src/ui/pets/pet.js` | 新增 `opts.bubbleGap`（默认 16）；`anchorBottom` 使用它；修正过期注释 |
| `src/remote/pwa/mobile-pet.js` | 创建宠物时传 `bubbleGap: 8` |

## 6. 验证

| 项 | 结果 |
|---|---|
| typecheck / lint / compile | ✅ 0 错误（lint 65 warnings 为既有基线） |
| test | ✅ 1320 passed / 131 files |
| `node --check` 三个改动文件 | ✅ 语法通过 |
| 产物校验 | ✅ `out/src/remote/pwa/app.js` 含 `SEND_TICK_MAX_MS` / `sendHardStopTimer` |
| 手机端 PWA（浏览器窗口，CDP 验） | ✅ 已在线、宠物渲染 62.4px、**气泡 gap 反推 = 8.0000** |
| 桌面端回归（纯净模式） | ✅ 宠物 124.8px、**气泡 gap 反推 = 16**（未受影响） |

**未覆盖**：手机真机跑一轮真实工具循环（验证"延迟发送"不再卡死）。根因推理基于代码路径排除，需真机确认。

## 7. 遗留

- `isMyProfile` 的"宽松→严格"切换本身仍可能导致**流式内容**在窗口选择过期后不显示。本次只解决了终态收尾（会造成僵尸执行条的严重问题），流式串窗口属另一议题。
- 未查证"为什么 profileId 会失配"——需真机复现时抓具体值。
