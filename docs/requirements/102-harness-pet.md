---
id: 102
type: feature
title: 纯净模式输入框宠物（气泡互动 + 可拖动）
status: done
branch: (直接主分支，用户要求先做最优端且不提交)
updated: 2026-11-02
---

# 纯净模式输入框宠物

## 背景

dsh-Go 在输入框上方有一只宠物（Deepy 小鲸鱼），随任务状态播不同动画、点一下有反应。
Cuckoo 纯净模式（harness）是产品默认入口，输入框上方留白较多，同样适合放一只。

本次只做**纯净模式**；手机端 PWA 留待后续（复用同一份 `pet.js` 与资源）。

## 目标

1. 纯净模式输入框上边缘显示宠物，随输入框长高自然上移。
2. 状态由既有事件派生，不新增 IPC 数据通道：
   - 工具运行 → `working`（并行数决定 tiers 档位）
   - 模型出字 → `thinking`
   - 其余 → `idle`（空闲 60s 睡觉、偶发 idle-look / idle-spout）
   - 一轮结束 → `attention`（完成表情）；工具失败 → `error`
3. 设置页可开关、可调大小（小 / 标准 / 大），改完即时生效。
4. 宠物纯装饰：初始化失败、资源缺失一律静默降级，绝不影响对话。

## 设计要点

- **资源真源**：`src/ui/pets/<id>/pack.json` + 精灵图 PNG（取自 dsh-Go 的 Clawd on Desk 主题包，作者授权）。
  `scripts/build-pets.mjs` 把它压成运行时数据 `pets.generated.js`（逐帧压平、去掉 Flutter 专用字段）。
- **构建**：`npm run compile` 增加 build-pets + copy-pets 两步；`scripts/copy-pets.mjs` 把资源拷到 `out/src/ui/pets`（非 TS，tsc 不输出）。
- **定位**：作为 `.composer-inner`（`position: relative`）的绝对定位子元素，`bottom: 100%` 贴其顶边。
  输入框长高时随布局自然上移 —— 等价于 dsh-Go 的 `PetPerch` 层内跟随，但不需要 JS 跟随或 rAF 轮询。
- **渲染**：逐帧切 sprite sheet（`background-position` + `image-rendering: pixelated`），单条 rAF 驱动状态机；
  页面 `document.hidden` 时冻结，回来不跳帧、不耗电。
- **偏好**：`ui-prefs.json` 新增 `petEnabled`（默认 true）与 `petSize`（默认 medium）；
  改设置时主进程推 `harness-pet-prefs`，harness 重建宠物（不重载页面）。

## 文字互动（第二轮，按用户反馈补）

初版只做动画，缺了 dsh-go 宠物的核心价值。第二轮补齐并**移除右上角状态条**：

1. **右上角状态条视觉隐藏**（`.status.sr-only`，DOM 保留——它是运行态载体，
   `generating` 由 `setStatus` 写入，删 DOM 会断掉忙闲通知与进度条）。
2. **全部状态文案迁到宠物气泡**：
   | 原状态条文案 | 气泡 |
   |---|---|
   | 就绪 | 不冒泡（宠物回 idle 已表达） |
   | 生成中… | 常驻「生成中…」 |
   | 工具运行中 12s… | 常驻，每秒刷新秒数 |
   | 结果待发送（工具 Ns · 延迟 Ns） | 常驻，每秒刷新 |
   | 等待自动重试… | 常驻「限流了，Ns 后自动重试」 |
   | 重试已达上限 | 瞬时「重试到头了，手动再试一次？」 + error 表情 |
   | 已发送，等待 AI 响应… | 常驻；有专属说明则用 FW_BUBBLE 表（回传工具结果 / 压缩上下文 / 自动续跑等） |
   | 这轮结束（task-idle） | 瞬时「这轮做完了」 + attention 表情 |
   | 工具失败 | 瞬时「出错了，点开看看」 + error 表情 |
3. **气泡不挡点击**：`pointer-events: none`，不遮输入框与「回到底部」按钮。
4. **横向拖动 + 位置记忆**：默认偏左 18%（原先居中，被「回到底部」按钮压住），
   拖动超过 4px 才算拖（否则触发点击反应），松手写 `ui-prefs.json` 的 `petX`（钳 6%~94%）。
5. **长按菜单不做**：只有一只宠物，没有可切换对象。

## 第三轮：点击彩蛋 + 桌面宠物（按用户反馈补）

1. **点击彩蛋**：点一下宠物从 8 个动画里洗牌轮播（吐水 idle-spout / 撒花 react-double /
   翻跟头 roam-hop / 唱歌 music / 拍手 conducting / 递东西 carrying / 醒神 waking / 瞟一眼 idle-look），
   播完一圈重新洗牌，不会连续重复。拖动超 4px 才不算点击。
2. **气泡高度**：底部对齐 `contentBox` 顶边再 +14px（原先贴着 canvas 顶边，离鲸鱼 30px）。
   稳态间距 14px，尾巴有落点。
3. **秒数强调**：`<b>` 包裹（14px / 800 粗 / 等宽数字 / 主题蓝），与状态条同语义，跳秒不抖。
   气泡支持 `opts.html`，调用方保证内容可控（文案是程序拼的，无用户输入）。
4. **桌面宠物独立窗口**：
   - 设置 › 外观新增「最小化后桌面显示宠物」（默认关）。
   - 主窗口 minimize → 右下角弹出无边框透明置顶窗口；restore/show → 隐藏。
   - 文案与纯净模式同源（harness 的 `petBubble` 顺带经 `harness-pet-state` 推给主进程）。
   - 可拖动（`-webkit-app-region: drag`），悬停显关闭按钮。
   - **坑**：`pet-window.html` 的 CSP 漏了 `'unsafe-inline'`，内联脚本被拦，宠物完全不出现；
     且主进程 `did-finish-load` 早于页面监听器注册，init 消息会丢 —— 改为页面先按默认尺寸建宠物，
     收到 init 若尺寸不同再重建。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/ui/pets/deepy-whale/*` | 新增：pack.json + 20 张精灵图（约 422 KB） |
| `src/ui/pets/pet.js` | 新增：渲染器 + 状态机 |
| `src/ui/pets/pet.css` | 新增：定位与像素化样式 |
| `src/ui/pets/pets.generated.js` | 生成物（build-pets 产出） |
| `scripts/build-pets.mjs` | 新增：pack.json → 运行时数据 |
| `scripts/copy-pets.mjs` | 新增：拷贝到 out/ |
| `package.json` | compile 加两步 |
| `src/ui/harness.html` | 引入 css/js、挂载宠物、按事件驱动、读偏好 |
| `src/app/ui-prefs.ts` | 新增 petEnabled / petSize |
| `src/app/harness-preload.ts` | 新增 onPetPrefs 订阅 |
| `src/app/ipc/settings.ts` | 宠物偏好变化时推送 |
| `src/ui/shell/partials/pages/settings.html` | 开关 + 大小下拉 |
| `src/ui/shell/scripts/pages/settings.ts` | 读写偏好 + 联动置灰 + 恢复默认 + 桌面宠物开关 |
| `src/app/pet-window.ts` | 新增：桌面宠物独立窗口 |
| `src/app/pet-window-preload.ts` | 新增：桌面宠物 preload |
| `src/ui/pet-window.html` | 新增：桌面宠物页面 |
| `src/app/entry.ts` | minimize/restore 联动桌面宠物 + 注册 IPC |
| `src/app/ipc/harness.ts` | `harness-pet-state` 转发 + 忙闲同步 |
| `src/app/harness-preload.ts` | `setPetState` |

## 真机验证（开发版实例，CDP 实测）

| 项 | 结果 |
|---|---|
| 宠物挂载 / 精灵图切帧 | ✅ 距输入框顶边 2px，idle.png 正常缩放 |
| 不与「回到底部」重叠 | ✅ 默认偏左 18% |
| 拖动 + 持久化 | ✅ 18%→72%，重启后 `petX=0.837` 原样恢复 |
| 双层气泡 | ✅ 状态层贴宠物（14px）、提示层在上，互不覆盖 |
| 气泡秒数强调 | ✅ 14px / 800 粗 / 主题蓝 |
| 点击彩蛋 | ✅ 6 次点击 6 个不同动画 |
| 状态条隐藏 | ✅ sr-only，宽度 1px |
| 桌面宠物窗口 | ✅ 最小化弹出、恢复隐藏、文案同源、可拖动、可关闭 |

## 验证

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿。
- 真机（开发版实例）：宠物显示、三态切换、结束表情、设置开关即时生效。

## 第四轮：手机端（远程 PWA / APK）

桌面端宠物完整复用到手机端远程页面，**不重写渲染引擎**。

### 方案

| 环节 | 做法 |
|---|---|
| 资源 | `scripts/copy-remote-pwa.mjs` 构建时把 `src/ui/pets/` 拷进 `out/src/remote/pwa/pets/`；Capacitor `webDir` 就是该目录，APK 打包自动带上 |
| 适配层 | 新增 `src/remote/pwa/mobile-pet.js`：`window.CuckooMobilePet = { apply, destroy, getState }`，把对话事件翻译成 pet.js 状态调用 |
| 样式 | 新增 `src/remote/pwa/mobile-pet.css`：`.composer-inner{position:relative}`、`.ck-pet{touch-action:pan-y}`、气泡容器显式宽度 |
| 事件 | `app.js` 新增 `petEvent(kind, workers)` 单点转发，在 ai-start / ai-stream / ai-reply / task-done / ai-stop / ai-error / tool(start) 分支**末尾**各加一行 |
| 缓存 | `server.ts` 的 `VERSIONED_ASSETS` 增加 5 个新文件，避免 CF 边缘缓存旧 pet.js |
| 开发期 | `server.ts` 加 `PETS_FALLBACK_DIR`：源码目录没有 pets/ 时回退 `src/ui/pets`，与 PWA_DIR 同一套穿越校验 |

### 关键设计决策（含踩坑记录）

1. **不冒功能状态气泡**：手机端已有 `exec-status` 浮动胶囊（"生成中…" / "工具运行中 Ns…"），宠物再冒一遍是同屏重复、窄屏噪音。宠物只做动画 + 情绪文案（随机、4s 节流）。
2. **手势不用 JS 劫持**：`pet.css` 的 `touch-action:none` 会吃掉页面滚动（手指从宠物上划过，消息列表纹丝不动）。改成 CSS `pan-y`，浏览器自己分流——竖向滚页面、横向拖宠物，零手势劫持代码。
   - 曾尝试「长按 180ms 才激活拖动」的 JS 方案，**已放弃**：pet.js 的 pointerdown 绑在自身冒泡阶段，无法"先扣住再放行"，强行拦截会连轻触彩蛋一起废掉。
3. **钳位按宠物实际宽度**：pet.js 的固定 6%~94% 不知道宠物多宽，窄屏 308px 下 6% 会让半个身子出屏（实测 `petL=0.3px`）。
   给 pet.js 加**可选** `opts.clampX` 回调（不传 = 原逻辑完全不变，桌面端零影响），手机端传入 `clampXForHost` 后拖动全程钳位，DOM 与内部 `xRatio` 天然一致。
   - 反例：最初只在 `onMove` 里改 DOM，但 pet.js 每帧 `pointermove` 都会覆写 `style.left`，纠正值只在松手一帧生效，且内部 `xRatio` 停在旧值 → 已废弃。
4. **【踩坑】气泡容器必须有确定宽度**：`.ck-pet-bubbles` 是 `position:absolute; left:50%` 却没设宽度，绝对定位元素按 shrink-to-fit 算出的可用宽度只有半个宠物宽（约 31px）。桌面端靠 `.ck-pet-bubble` 的 `white-space:nowrap` 撑开容器所以没事；手机端一旦改成 `normal` 允许换行，就在 31px 的盒子里**逐字竖排**。
   修法：容器 `width:max-content; max-width:min(200px, calc(100vw - 24px))`，换行才发生在正确宽度上。

### 涉及文件（第四轮）

| 文件 | 改动 |
|---|---|
| `scripts/copy-remote-pwa.mjs` | 增：拷 `src/ui/pets` → `out/src/remote/pwa/pets`（失败只告警） |
| `src/remote/pwa/mobile-pet.js` | 新增：事件翻译 + 钳位 + 延迟创建 + 全异常吞噬 |
| `src/remote/pwa/mobile-pet.css` | 新增：移动端覆盖样式 |
| `src/remote/pwa/index.html` | 增：3 个 link + 3 个 script（pets.generated → pet.js → mobile-pet.js → app.js） |
| `src/remote/pwa/app.js` | 增：`petEvent()` helper + 8 处调用（均在既有逻辑末尾） |
| `src/remote/server.ts` | 增：`VERSIONED_ASSETS` 5 项 + `PETS_FALLBACK_DIR` 回退 |
| `src/ui/pets/pet.js` | 增：可选 `opts.clampX` 钩子（默认分支行为不变） |
| `test/remote/server.test.js` | 增：宠物资源托管 / ?v= 版本化 / 路径穿越 / 404 四类用例 |

### 真机验证（第四轮）

开发版实例 CDP + 独立浏览器窗口（388px / 308px 两档宽度）：

| 项 | 结果 |
|---|---|
| 引擎加载（CuckooPet / CUCKOO_PETS / CuckooMobilePet） | ✅ |
| 宠物挂载、贴输入框顶边、不遮挡输入框与发送按钮 | ✅ |
| 状态切换（thinking / working(2,3) / done→happy / error） | ✅ 动画文件与档位全部正确 |
| 情绪气泡（随机、4s 节流、pointer-events:none） | ✅ |
| 气泡长文案换行（200px 两行，不竖排、不溢出） | ✅ 竖排 bug 已修 |
| 点击彩蛋（6 次点击 6 个不同动画） | ✅ |
| 横向拖动 + 位置持久化 + 刷新恢复 | ✅ 0.06 / 0.94 两端均能正确恢复 |
| 窄屏 308px 边界钳位 | ✅ 6%→11.5%、94%→88.5%，宠物完整在屏内 |
| 拖动起点不跳变（DOM 与内部状态一致） | ✅ |
| 宿主不存在（登录页）时 apply 不崩 | ✅ |
| 宠物实例幂等（重复 create 不泄漏 DOM） | ✅ |
| 桌面端回归（纯净模式 + 桌面浮窗） | ✅ 渲染正常、拖动仍 6%~94%、无 JS 异常 |

### 验证

- `npm run typecheck` / `npm test`（1320 passed）/ `npm run lint` / `npm run compile` 全绿。
- 子代理审计：code-reviewer 提 2 条【必须修复】——#1 `creating` 未复位经复核为**误报已撤回**（复位在 L108，两条路径都覆盖）；#2 `onMove` 改 DOM 与 `xRatio` 失同步为**真问题已修**（改用 `opts.clampX` 钩子根治）。
- arch-guard 结论：合规，无反向依赖、无生成物手改、路径穿越防护未被削弱、测试符合项目哲学。

## 后续

- APK 发包前需 `npx cap sync android` 把 `out/src/remote/pwa` 同步进 `android/app/src/main/assets/public`（本轮未执行，避免污染产物目录）。
- 可选：拖动换位、App 外悬浮（dsh-Go 的 `PetOverlay` 部分），本需求不做。
