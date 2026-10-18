---
id: 083
type: fix
title: 修复停止生成：误点发送按钮 + 假成功
status: done
branch: fix/083-remote-stop
updated: 2026-10-18
---

# 083 fix — 修复停止生成：误点发送按钮 + 假成功

## 问题

远程（手机）点"停止"时存在两个缺陷：

1. **误点发送按钮**：当 AI 并未在生成时，DeepSeek 输入区主按钮是"发送"箭头图标，
   `attachStopFn` 仍按类名 `ds-button--primary` 打分选中它并点击 → 等于替用户发出消息。
2. **假成功**：`stopGeneration` 只要拿到按钮坐标就返回 `success: true`，
   不校验是否真的停住。手机据此显示"已停止"，实际 AI 继续生成。

真机取证（2026-10-18）：
- 日志 `stopDiag` 选中 `DIV.ds-button--primary`，点击后 AI 仍把 1~200 全部输出完毕。
- 生成中与空闲两种状态下该按钮的 SVG 图标不同：
  - 生成中：`<path d="M2 4.88C2 3.68...">`（方块）
  - 空闲：`<path d="M8.3125 0.980206...">`（箭头）
- CDP 真实鼠标点击方块图标可成功停止（3/3 复现）。

## 方案

三层防护，改动集中在停止路径：

### 1. 前置守卫（provider 层）

`src/providers/deepseek.ts` 新增 `getStopFn()`：
- 精确定位 DeepSeek 主按钮（`.ds-button--primary`）
- 检查 SVG path 判断状态：
  - 方块 → 返回 `{ found: true, x, y, generating: true }`
  - 箭头或找不到 → 返回 `{ found: false, generating: false }`
- **不再让空闲态按钮进入候选**

### 2. 点击后校验（app 层）

`src/app/ipc/harness.ts` 的 `stopGeneration`：
- 守卫：`getStopFn` 返回 `found: false` → 直接返回
  `{ success: false, reason: 'not-generating' }`，不点击
- 点击后等 400ms，再调一次定位函数确认按钮已不是方块：
  - 变了 → `success: true`
  - 没变 → 重试 1 次；仍失败 → `success: false, reason: 'still-generating'`

### 3. 移除页面内合成点击

`attachStopFn` 中的 `dispatchEvent` + `el.click()` 序列（页面内合成点击）删除，
只返回坐标，由主进程 CDP 派发真实点击。真机已验证合成点击会干扰状态判断。

### 4. 远程侧消费新返回值

`src/remote/manager.ts` 的 `onPhoneStop`：
- `reason: 'not-generating'` → 广播"当前没有可停止的任务"
- `reason: 'still-generating'` 或其它失败 → 沿用现有"停止未生效，请在电脑上操作"
- 两种都不调 `onAiStop`（不误报已停止）

## 影响范围

| 文件 | 改动 |
|---|---|
| `src/providers/deepseek.ts` | 新增 `getStopFn`（约 40 行） |
| `src/app/ipc/harness.ts` | `attachStopFn` 移除合成点击；`stopGeneration` 加守卫 + 校验（约 30 行） |
| `src/remote/manager.ts` | `onPhoneStop` 按 reason 分支广播（约 10 行） |

本地纯净模式与远程共用 `stopGeneration`，两侧同时受益。

## 不做

- **远程发送自动掐旧任务**：需要在 remote 侧复刻 harness 的待发队列 + 中止代次 +
  事件静默期机制，风险远大于收益。停止修好后，用户点一下停止再发即可达到同样效果。

## 验证

### 单元/集成
- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿

### 真机（CDP 9444 + 远程 WS 7800）
1. 远程生成中点停止 → AI 停住，手机收到 `ai-stop`
2. 远程空闲时点停止 → 手机收到"没有可停止的任务"，页面**未发出任何消息**
3. 本地纯净模式生成中点停止 → 停住
4. 本地纯净模式正常发送 → 不受影响
5. 生成中/空闲交替 5 轮，无假成功、无误发

## 真机验证结果（2026-10-18）

### 关键发现

1. **DeepSeek 停止按钮同一元素两种形态**：`.ds-button--primary` 在生成中显示方块 path
   （`M2 4.88C2 3.68...`），空闲时显示箭头 path（`M8.3125 0.98...`）。
2. **CDP `Input.dispatchMouseEvent` 不能真正停流**：真机实测点击后按钮图标变回箭头，
   但 AI 流仍在继续（8 秒内 +59 帧）。此前的"假成功"正是由此而来。
3. **页面内合成 PointerEvent 序列能真正停流**：实测 8 秒仅 +4 帧。
   故最终点击方式改为「页面内合成 Pointer 事件」，不再使用 CDP debugger。
4. 校验必须依赖定位函数明确表态 `generating === false`；
   定位失败（null / 抛错 / generating 为 null）一律视为"未确认"，不据此报成功。

### 验证矩阵（最终版，含回退路径兼容修复后复测）

| 场景 | 结果 |
|---|---|
| 远程生成中点停止（多轮） | ✅ `method: pointer-event`，stop 后 stream 仅 +2~4 帧 |
| 远程空闲时点停止 | ✅ 提示"当前没有正在生成的任务"，bodyLen 差值 0，未误发消息，未误报 ai-stop |
| 纯净模式发送 | ✅ 输入→发送→按钮变停止态→AI 回复→按钮复位，闭环正常 |

### 自查补修的缺陷

回退路径兼容：`attachStopFn`（通用定位，其它平台或 provider 未实现 `getStopFn` 时使用）
的返回值不含 `generating` 字段，最初版本的校验 `again.generating === false` 永远为假，
会把原本能正常停止的平台误判为 `still-generating`。
已改为按定位函数是否具备 generating 语义分流：
- 有语义（DeepSeek `getStopFn`）→ 必须 `generating === false` 才算停住
- 无语义（通用回退）→ 退化为"找不到可点的停止按钮 = 已停"，与原行为一致

### 四项校验

- `npm run typecheck` ✅
- `npm test` ✅ 129 文件 / 1219 用例全过
- `npm run lint` ✅ 0 error（62 个既有 warning）
- `npm run compile` ✅

## 状态

- 类型：fix
- 分支：`fix/083-remote-stop`
- 状态：done
