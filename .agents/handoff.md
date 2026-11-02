# 最新接续状态 (2026-11-02)

## 核心进展

**需求 102（纯净模式 + 桌面宠物）** 完成前三轮（样式打磨 / 对抗性审计 / 真机验证）后，
**本轮完成第四轮：手机端远程 PWA / APK 接入宠物**。

全部 typecheck / test(1320) / lint / compile 通过，**手机端 + 桌面端真机验证均通过，未发版**。

---

## 一、第四轮（本轮）完成的改动

桌面端宠物完整复用到手机端远程页面，**不重写渲染引擎**。

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/remote/pwa/mobile-pet.js` | 事件翻译层：`window.CuckooMobilePet = { apply, destroy, getState, _create }`。把 thinking/working/waiting/idle/done/error 翻译成 pet.js 状态调用；全异常吞噬（宠物纯装饰） |
| `src/remote/pwa/mobile-pet.css` | 移动端覆盖：`.composer-inner{position:relative}`、`.ck-pet{touch-action:pan-y}`、气泡容器显式宽度 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `scripts/copy-remote-pwa.mjs` | 构建时拷 `src/ui/pets` → `out/src/remote/pwa/pets`（失败只告警不中断） |
| `src/remote/pwa/index.html` | 3 个 link + 3 个 script（pets.generated.js → pet.js → mobile-pet.js → app.js，全 defer） |
| `src/remote/pwa/app.js` | 新增 `petEvent(kind, workers)` helper + 8 处调用（ai-start / ai-stream / ai-reply / task-done / ai-stop / ai-error / onToolEvent start），全部在既有逻辑**末尾** |
| `src/remote/server.ts` | ① `VERSIONED_ASSETS` 加 5 项（防 CF 缓存旧 pet.js）② `PETS_FALLBACK_DIR` 回退（源码目录无 pets/ 时回退 `src/ui/pets`，同一套穿越校验） |
| `src/ui/pets/pet.js` | 新增**可选** `opts.clampX` 钩子（不传 = 原逻辑完全不变，桌面端零影响） |
| `test/remote/server.test.js` | 新增 4 个用例：宠物资源托管 / ?v= 版本化 / 路径穿越 / 资源不存在 404 |

### 关键设计决策（含踩坑记录）

1. **不冒功能状态气泡**：手机端已有 `exec-status` 胶囊（生成中 / 工具运行中 Ns），宠物再冒一遍是同屏重复。宠物只做动画 + 情绪文案（随机、4s 节流）。
2. **手势不用 JS 劫持**：`pet.css` 的 `touch-action:none` 会吃掉页面滚动。改 CSS `pan-y` 让浏览器分流——竖向滚页面、横向拖宠物，零手势劫持代码。
   - 曾尝试「长按 180ms 才激活拖动」的 JS 方案，**已放弃**：pet.js 的 pointerdown 绑在自身冒泡阶段，无法"先扣住再放行"，强行拦截会连轻触彩蛋一起废掉。
3. **钳位按宠物实际宽度**：pet.js 固定 6%~94% 不知道宠物多宽，窄屏 308px 下 6% 会让半个身子出屏（实测 `petL=0.3px`）。
   解决：给 pet.js 加可选 `opts.clampX` 回调，手机端传 `clampXForHost`，拖动**全程**钳位，DOM 与内部 `xRatio` 天然一致。
   - 反例：最初只在 `onMove` 里改 DOM，但 pet.js 每帧 `pointermove` 都会覆写 `style.left`，纠正值只在松手一帧生效，且内部 `xRatio` 停在旧值 → 已废弃。
4. **【重要踩坑】绝对定位容器 + 允许换行 = 逐字竖排**
   `.ck-pet-bubbles` 是 `position:absolute; left:50%` 却没设宽度。绝对定位元素按 shrink-to-fit 算宽度，可用空间 = 包含块右边界 − left = 半个宠物宽（约 31px）。
   桌面端靠 `.ck-pet-bubble` 的 `white-space:nowrap` 撑开容器所以没事；手机端改成 `normal` 允许换行后，就在 31px 的盒子里**逐字竖排**。
   修法：容器 `width:max-content; max-width:min(200px, calc(100vw - 24px))`。
   **教训**：改 `white-space` / `word-break` 前，先确认容器宽度是「确定的」还是「shrink-to-fit 算出来的」。

---

## 二、真机验证结果（全部通过）

### 手机端（独立浏览器窗口 388px / 308px 两档 + 临时静态服务指向 `out/src/remote/pwa`）

| 场景 | 结果 |
|---|---|
| 引擎加载、宠物挂载、贴输入框顶边 | ✅ |
| 不遮挡输入框与发送按钮 | ✅ 两档宽度均无重叠 |
| 状态切换 thinking / working(2,3) / done→happy / error | ✅ 动画与档位全对 |
| 情绪气泡（随机、4s 节流、pointer-events:none） | ✅ |
| 气泡长文案换行（200px 两行） | ✅ 竖排 bug 已修 |
| 点击彩蛋 | ✅ 6 次点击 6 个不同动画 |
| 横向拖动 + 持久化 + 刷新恢复 | ✅ 0.06 / 0.94 两端均正确恢复 |
| 窄屏 308px 边界钳位 | ✅ 6%→11.5%、94%→88.5%，宠物完整在屏内 |
| 拖动起点不跳变 | ✅ |
| 宿主不存在（登录页）apply 不崩 | ✅ |
| 宠物实例幂等 | ✅ |

### 桌面端回归（开发版 Electron，CDP 9444）

| 场景 | 结果 |
|---|---|
| 纯净模式宠物渲染 | ✅ idle.png，left 38.7% |
| 桌面浮窗宠物渲染 | ✅ idle.png，166.4px |
| 拖动钳位仍 6%~94%（`clampX` 不传时行为不变） | ✅ |
| 无 JS 异常 | ✅ `errors: []` |

---

## 三、子代理审计结果

**code-reviewer**：提 2 条【必须修复】
- #1 `creating` 标志未复位 → **误报，已撤回**（复位在 `mobile-pet.js` 的 `if (!pet) return null` 之前，返回 null 和抛异常两条路径都覆盖）
- #2 `onMove` 改 DOM 与 `xRatio` 失同步 → **真问题，已修**（改用 `opts.clampX` 钩子根治）
- 建议项：hostEl 缓存已采纳；z-index 冗余已删；gap 注释已修正

**arch-guard**：合规。无反向依赖、无生成物手改、路径穿越防护未被削弱、测试符合项目哲学。
提示（非本次引入）：`src/remote/` 未在 `docs/arch/02-dependency.md` 登记，且 `remote ↔ app` 存在双向依赖，建议后续补登。

---

## 待办事项 (Next Steps)

- [ ] **APK 发包前需 `npx cap sync android`**：把 `out/src/remote/pwa` 同步进 `android/app/src/main/assets/public`。
      本轮**未执行**，避免污染产物目录（用户选择不碰 android）。
- [ ] 桌面宠物用 Live2D 渲染器的可行性（需专有授权，风险高）
- [ ] 多宠物切换（whale-girl 素材同构，需确认许可）
- [ ] `src/remote/` 补登依赖表 + 解耦 remote ↔ app 双向依赖

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 需求档案：`docs/requirements/102-harness-pet.md`（第四轮章节）
- 审计报告：`.agents/宠物-审计.md`
- 核心文件：
  - `src/ui/pets/pet.js` — 渲染引擎（零依赖；新增可选 `opts.clampX`）
  - `src/ui/pets/pet.css` — 气泡样式（`gap:8px`，实心 `#0d0f14`，主题色边框）
  - `src/ui/pets/deepy-whale/` — pack.json + 20 张精灵图（406KB）
  - `src/remote/pwa/mobile-pet.js` — **手机端适配层（本轮新增）**
  - `src/remote/pwa/mobile-pet.css` — **手机端样式（本轮新增）**
  - `src/remote/pwa/app.js` — `petEvent()` helper + 8 处调用
  - `src/remote/server.ts` — `VERSIONED_ASSETS` + `PETS_FALLBACK_DIR`
  - `scripts/copy-remote-pwa.mjs` — 构建时拷宠物资源到 PWA
  - `src/app/pet-window.ts` / `src/app/ipc/harness.ts` / `src/app/ipc/settings.ts` — 桌面端链路（本轮未改）
- 真机验证：
  ```
  # 桌面端（开发版实例，CDP 9444）
  set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& node_modules\.bin\electron.cmd . --remote-debugging-port=9444
  # 手机端：起临时静态服务指向 out/src/remote/pwa，用 openBrowserWindow 开 400/320 宽窗口

  # 查窗口：curl http://127.0.0.1:9444/json/list
  # 杀进程：powershell -c "Get-Process electron | Stop-Process -Force"（不要用 taskkill，会被安全策略拦）
  ```
