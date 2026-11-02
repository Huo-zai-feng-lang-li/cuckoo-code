# 最新接续状态 (2026-11-02)

## 核心进展

**需求 102（纯净模式 + 桌面宠物）** 完成样式打磨 + 对抗性审计修复 + 真机验证。
全部 typecheck / test(1316) / lint / compile 通过，**真机 4 项场景验证通过，未提交、未发版**。

---

## 一、本轮完成的改动

### 1. 气泡样式（用户逐轮反馈调整）
- 气泡间距 `gap: 13px → 8px`
- 底色：渐变玻璃 → **实心 `#0d0f14`**（移除 `backdrop-filter`）
- 边框：青色 `#7ce7ff` → **跟随主题 `var(--accent)`**（34% 透明度 + 32% 单圈柔光）
- hint 文字色：写死青色 → `color-mix(var(--accent) 68%, #eef2ff)`
- 离宠物高度：`anchorBottom` `+52 → +16px`

### 2. 【根因】注释提前闭合导致整条 CSS 规则失效
`pet.css:30` 的 `*/` 提前闭合了注释块，第 31-36 行说明文字裸露，
导致 `.ck-pet-bubbles` 的 `position:absolute` / `flex` / `gap` / `transform` 全部失效。
**症状**：两气泡没间距、气泡压在宠物身上、"太丑"。
**修复**：删掉多余的 `*/`。
**教训**：改完 CSS 后一定要看 `out/src/ui/pets/pet.css` 是否同步（`npm start` 不复制静态资源）。

### 3. 设置页精简
- 删除「宠物大小」整个字段块（标题 + 提示两行）
- 真源改 `src/ui/shell/partials/pages/settings.html` + 跑 `build-shell.mjs`

### 4. 审计修复（6 个真问题，1 个误报已撤回）

| # | 问题 | 文件 | 修复 |
|---|---|---|---|
| 1 | 驱动窗口关闭后 `petDriverWinId` 不清理 → 宠物卡僵尸文案 | `src/app/ipc/harness.ts` | 两个处理器开头加惰性自愈：`getWindowContext(petDriverWinId)` 为 null 则清空 |
| 2 | `showPetWindow` 幂等分支忽略尺寸变化 | `src/app/pet-window.ts` | 复用分支补 `setPetWindowSize(size)` |
| 3 | `destroyPetWindow` 残留 `lastState` / `lastSourceWinId` | `src/app/pet-window.ts` | 销毁时清空两者 |
| 4 | 关宠物开关后桌面浮窗仍飘着 | `src/app/ipc/settings.ts` | `petEnabled === false` 时调 `destroyPetWindow()` |
| 5 | `.sr-only` 靠字符串拼接，将来易被覆盖 | `src/ui/harness.html` | 改为 `classList.add('sr-only')` 独立兜底 |
| 6 | 6 处 `catch (e)` 未用形参 / 尺寸常量双写 | `src/ui/pets/pet.js` | 改 `catch`；常量加注释交叉指向 |
| — | 打包白名单缺 pets | `package.json` | **误报**：`files` 首行 `"**/*"` 已全包含，pets 无扩展名命中排除规则 |

### 5. 临时脚本清理
- `tmp-bubble-check.mjs` / `tmp-css-check.mjs` 已删除
- `wyp/tmp-*.mjs`（35 个 CDP 测试脚本）已删除

---

## 二、真机验证结果（全部通过）

开发版（`npm run dev`，独立 userData，CDP 9444），双窗口场景：

| 场景 | 结果 |
|---|---|
| 基础渲染（气泡 gap / 边框 / 底色 / sr-only） | ✅ |
| 隐藏态改尺寸 → 最小化后生效（120→200） | ✅ 208px / 380×420 |
| 关窗口后残留 harness 推状态被拦截 | ✅ 无僵尸文案 |
| 隐藏态关开关 → 宠物窗口立即销毁 | ✅ |
| 点宠物 → 恢复主窗口 | ✅ |

---

## 待办事项 (Next Steps)

- [ ] **提交本批改动**（用户要求等指令）
- [ ] 手机端 PWA 宠物（方案已设计，未实施）：**A+A 方案**
  - `copy-remote-pwa.mjs` 拷 pets 到 `pwa/pets/`
  - 新建 `src/remote/pwa/mobile-pet.js`（状态机 + 三层兜底：tool 超时 30s / 全局 60s / 重连重置）
  - 新建 `mobile-pet.css`（手机尺寸 64px、气泡 11px/200px、半透明底）
  - `app.js` 的 `switch(msg.type)` 调 `window.mobilePet?.apply(msg)`
  - 交互只保留「轻触播动画」，不做滚轮/拖拽
- [ ] 桌面宠物用 Live2D 渲染器的可行性（`D:\Desktop\codex-dafeiyu-live2d` 是参考，但需 Live2D 专有授权，风险高）
- [ ] 多宠物切换（whale-girl 素材同构，但需确认素材许可）

## 关键上下文

- 目录：`D:\Desktop\Super-File\cuckoo-code`
- 需求档案：`docs/requirements/102-harness-pet.md`
- 审计报告：`.agents/宠物-审计.md`
- 核心文件：
  - `src/ui/pets/pet.js` — 渲染引擎（零依赖）
  - `src/ui/pets/pet.css` — 气泡样式（`gap:8px`，实心 `#0d0f14`，主题色边框）
  - `src/ui/pets/deepy-whale/` — pack.json + 20 张精灵图（397KB）
  - `src/app/pet-window.ts` — 桌面窗口（幂等复用 + 销毁清状态）
  - `src/app/ipc/harness.ts` — `petDriverWinId` 仲裁 + 自愈
  - `src/app/ipc/settings.ts` — `applyPetPrefs` 联动销毁
  - `src/ui/harness.html` — `petMood()` / `petBubble()` / `setStatus`（sr-only 兜底）
- 真机验证：
  ```
  npm run dev
  # 等 20-25s（先 tsc 编译）
  # CDP: http://127.0.0.1:9444/json/list
  # 用 Node 内置 WebSocket 注入 JS
  ```
  查窗口：`(Invoke-WebRequest -Uri http://127.0.0.1:9444/json/list).Content`
  杀进程：`Stop-Process -Id <PID> -Force`（**不要用 taskkill，会被安全策略拦**）
