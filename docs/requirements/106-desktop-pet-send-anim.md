---
id: 106
type: fix
title: 桌面宠物浮窗在「结果待发送」阶段动画卡死不动
status: done
branch: fix/106-desktop-pet-send-anim
created: 2026-11-04
updated: 2026-11-04
---

# 需求 106：桌面宠物浮窗在等待发送阶段动画卡死

## 1. 背景

用户反馈：主窗口最小化后桌面上的宠物，在「结果待发送（工具 Ns · 延迟 Ns）」阶段**动画一动不动**，只有气泡里的秒数在跳。

纯净模式下（主窗口内的宠物）同一阶段是逐 4s 轮换动画的（听音乐 / 抱着结果 / 比心 / 搭积木），两边行为不一致。

## 2. 根因

**同一份渲染引擎，两套业务调度，且只有一份实现了轮播。**

- 渲染引擎（`src/ui/pets/pet.js` + `pets.generated.js` + pack 精灵图）两个窗口共用；
- 业务调度（决定此刻播哪个动画）各写各的：

| 窗口 | 等待发送期间的动画决策 |
|---|---|
| 纯净模式（`harness.html`） | `renderSendTick()` 每秒跑，按 `SEND_ANIM_POOL = ['juggling','carrying','react-double','building']` 每 4s 轮换，但**只操作本窗口的 pet 实例，从不通知桌面浮窗** |
| 桌面浮窗（`pet-window.html`） | `applyState()` 只按主进程推来的 `state` 映射：`working→working` / `thinking→thinking` / `else→idle`。等待发送期间 harness 推的 state 恒为 `'thinking'` → **动画恒定在 thinking** |

## 3. 修法

**决策单点留在 harness，经 hint 通道下发编码后的动画指令；浮窗只做翻译。**

hint 通道此前已存在但**从未被消费**（`setPetState` 的 hint 参数 → `lastState.hint` → `pushState` → preload `onState` → 浮窗 `applyState`，最后一环一直没读它）。本次让 producer 真正赋值、consumer 真正解析。

### 改动 1：`src/ui/harness.html` petBubble（L3312-3331）

签名新增第 5 参 `animHint`，透传为 `api.setPetState({... hint: animHint || ''})`。

原写法 `hint: sticky ? '' : undefined` 有两个问题：
- 等待发送期间 `sticky=true` → hint 被无条件清空；
- 非 sticky 时传 `undefined` → 主进程按「未传则沿用 `lastState.hint`」语义保留旧值。

改为永远显式给字符串，杜绝陈旧 hint 污染。

### 改动 2：`src/ui/harness.html` renderSendTick（L3136-3159）

`animName` 计算从原来的 `if (pet) {...}` 块内**上移**到 `petBubble` 之前，然后：

```js
petBubble('等待发送 ' + petSec(sendSec), true, 0, true,
  (SEND_ONESHOT[animName] ? 'react:' : 'state:') + animName);
```

**分派规则编码进 hint**，复用已有的 `SEND_ONESHOT = { 'react-double': 1, 'building': 1 }`。浮窗不需要维护动画清单 → 单一真相源，新增动画只改 harness 一处。

### 改动 3：`src/ui/pet-window.html` applyState（L61-107）

```js
var m = /^(react|state):(.+)$/.exec(hint);
if (m && msg.state !== 'idle') {
  if (hint !== lastAnimHint) {
    lastAnimHint = hint;
    if (m[1] === 'react') { pet.setState(msg.state); pet.react(m[2]); }
    else { pet.setState(m[2]); }
  }
  pet.randomMood('waiting');
} else { /* 原有 state 映射 */ }
```

### 改动 4：`src/ui/pet-window.html` applySize（L144-157）

`boot(s)` 重建 pet 实例后补 `lastAnimHint = null`，再 `applyState(lastState)`。否则去重会跳过播放，新宠物停在初始 idle。

### 改动 5：`src/app/ipc/harness.ts` harness-set-busy（L721）

`setPetState(busy ? 'working' : 'idle', '', true)` → 补 `false, ''`。忙闲是粗粒度兜底信号，不携带动画指令，必须显式清空 hint，否则会拿到上一轮残留的 `state:carrying`。

## 4. 关键设计决策

| 决策 | 理由 |
|---|---|
| 用 hint 通道而非新增 IPC | 通道早已贯通，只是从未被消费；零新增契约 |
| 编码 `state:` / `react:` 前缀而非裸动画名 | `juggling` 在 `pack.states` 里但 `pack.animations` 里没有（tiers 解析成 music）；`react-double` / `building` 反之。裸名无法判断走 setState 还是 react，浮窗维护清单又会变成两处真相源 |
| 命中 hint 时**跳过** `setState(msg.state)` | `pet.js` 的 `setState` L391 `if (state !== 'idle') transient = null`，会把 `react()` 播的一次性动画在下一帧（每秒刷新）掐断 |
| `react:` 分支**先** `setState(msg.state)` **再** `react` | 只 react 不立 base 的话 `base` 停在 `'idle'`，`pet.js` 的 `idlePool` 在 90s 后（`base==='idle' && t>=idleAt`）会随机插播 idle-look / idle-spout 打断轮播。`setState` 清 transient 后 `react` 立即重设，同一帧两次 pickAnim，用户看不到中间帧 |
| 非 sendTick 路径统一 `hint: ''` | 主进程 `setPetState` L291 是「未传则沿用旧值」语义，不显式清空会残留 |

## 5. 影响面

| 面 | 影响 |
|---|---|
| 纯净模式内嵌宠物 | **零影响**（只是 `setPetState` 多传一个字段，本地渲染路径未变） |
| 手机端 PWA | **零影响**（`mobile-pet.js` 走独立 WebSocket 链路，不走这条 IPC） |
| 主进程 IPC 契约 | **向后兼容**（`hint` 字段早已在链路上贯通，只是从"传空"变成"传值"） |
| 鼠标穿透（`hitRect`） | 动画切换会 `emitHitRect()`，命中矩形随真实绘制框走。`building` 的 box 是 50×50（满画布），比 `thinking` 的 47×44 略大，属预期 |
| 现有测试 | **零影响**（`whale-pet-*.test.js` 测的是 `pet.js`，本次未改） |

## 6. 验证

- [x] `npm run typecheck` 通过
- [x] `npm run lint` 0 errors（67 warnings 为既有基线）
- [x] `npm run compile` 通过
- [x] `npm test` 131 文件 1320 用例全部通过
- [x] 架构合规审查（arch-guard）：生成物禁手改 / 依赖方向 / D12 / IPC 契约 全合规
- [ ] 真机验证：最小化主窗口，跑一轮带工具的会话，确认 4 段动画逐 4s 轮换、气泡秒数同步、透明区仍可穿透点击

## 7. 已知遗留（非本次引入）

- `juggling` 的 tiers 解析：纯净模式 `workers` 保持进入等待前的值（可能 ≥2 → `conducting`），浮窗 `workers` 恒为 0 → `music`。两边这个动画可能不同，属既有 tiers 语义差异，与"卡死不动"无关。
- 情绪文案节流起点不同（两边各自 4s 节流），可能短暂不一致，属可接受差异。
