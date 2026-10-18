# 全局自定义 Tooltip 与消息队列/导航优化 — 审计报告

> 审计对象：**未提交的工作区改动**（暂存区为空，技能默认审计 `git diff --cached`，此处按工作区 diff 审计）
> 功能线：`.agents/plan-自定义好看Tooltip与消息队列导航优化.md`
> 审计时间：2026-10-12

## 一、变更清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/ui/shell/scripts/tooltip.ts` | 新增 | 全局 Tooltip 引擎（shell 用，TS 模块） |
| `src/ui/shell/scripts/main.ts` | 改 | 引入并初始化 `initGlobalTooltip()` |
| `src/ui/shell/styles/components.css` | 改 | `.ck-tooltip` / `.ck-tooltip-kbd` 样式 |
| `src/ui/shell.html` | 生成物 | 由 `npm run compile` 复现（**已实测 fc 无差异**，非手改 ✅） |
| `src/ui/harness.html` | 改 | 队列去 title / hover 铺满 / 垂直居中；导航圆点改 `data-tooltip`；内联 Tooltip 引擎 |
| `src/ui/platform-select.html` | 改 | 手写源，内联 Tooltip 样式+引擎 |
| `test/ui/tooltip.test.js` | 新增 | Tooltip 守卫测试 |
| `test/ui/harness-page.test.js` | 改 | 队列/导航守卫测试 |
| `.agents/handoff.md`、`.agents/plan-*.md` | 改/新增 | 文档 |

## 二、闭环判定：**基本闭环，有 2 处不一致**

| 链路 | 状态 |
|---|---|
| shell：main.ts 引入 → tooltip.ts 引擎 → components.css 样式 → shell.html 打包 | ✅ 闭环 |
| harness：内联样式 + `initHarnessTooltip` + 圆点 `data-tooltip` | ✅ 闭环 |
| platform-select：内联样式 + 引擎 | ⚠️ 闭环但**功能与另两处不一致**（见 B1） |

## 三、Bug / 风险清单

### A. 无严重 Bug

### B. 中风险

**B1. 三份 Tooltip 实现不一致（维护风险）**
- shell/harness 有**快捷键 kbd 徽标**（`renderTooltipContent` 解析 `(Ctrl+...)`），**platform-select 版没有**（直接 `tip.textContent = text`）。
- 三份引擎逻辑近乎重复（约 100 行 × 3）。shell 是 TS 模块，harness/platform 是独立 HTML 无法 import → 只能内联，属**设计取舍**，但应记录：**改一处需同步改三处**。

**B2. 队列项文本去掉 `title="点击编辑"` 后无任何提示（可发现性下降）**
- plan 明确要求"去掉文本 title"，属**有意为之**；但未补 `data-tooltip="点击编辑"` → 用户 hover 文本**无提示**，不知可点击编辑。
- **建议**：文本改 `data-tooltip="点击编辑"`（既去原生 title，又保留可发现性）。

**B3. 动态 title 文案可能显示过期**
- 引擎在 `pointerover` 时把 `title`→`data-tooltip` 后**不再回写**。若元素已被 hover（`activeTarget===el`）时业务代码改了 `el.title`（如发送按钮 `发送`↔`中止` 切换），因 `if (activeTarget === el) return;` 不刷新 → tooltip 显示旧文案。
- 影响**轻微**（需 hover 状态下切换），且 toast 类提示不常用。

### C. 低风险

**C1. `positionTooltip` 每次显示触发 1 次 reflow**（读 `offsetWidth/offsetHeight`）。Tooltip 显示频率低，**可接受**。

**C2. `platform-select.html` 引擎缺 `role="tooltip"`**（ensureTip 里没设，shell/harness 版设了）。无障碍性小瑕疵。

**C3. 全局拦截的破坏面已排查——无影响** ✅
- `harness.ts:421` / `cdp-attach.ts:284` 读 `title`，但作用在 **`ctx.view`（AI 页面）**，不是 Cuckoo 壳/harness 页 → **不受全局拦截影响**。
- shell 页内自身 `el.title=xxx` 被转成 `data-tooltip` 后由自定义 Tooltip 呈现，属预期。

## 四、性能评估

| 项 | 评估 |
|---|---|
| 事件监听 | document 捕获级 `pointerover/out`，每次 `closest()` 选择器查询；路径短，**开销可忽略** |
| reflow | 每次显示 Tooltip 一次测量 reflow，频率低，可接受 |
| 内存 | 单例 `tipEl`，无累积；`showTimer` 有 clear，**无泄漏** |
| 圈复杂度 | `handlePointerOver` ≈ 8（<9 ✅）；`positionTooltip` ≈ 4 ✅ |
| 副作用 | 全局删除 `title` 属性不可逆，但已确认无逻辑依赖 |

## 五、待清理项（非本轮代码，但同工作区）

`?? temp_deepseek.html / temp_deepseek_share.json / temp_diff.patch / temp_scrape.js`
→ **临时调试文件，不应提交**，提交前删除或加 `.gitignore`。

## 六、验证结果（本次实跑）

- `npm run typecheck` ✅ 0 错误
- `npm test -- --run` ✅ **948 passed**
- `npm run lint` ✅ 0 errors（53 warnings，均在非核心目录）
- `npm run compile` ✅ 生成物可复现（`fc` 无差异）

## 七、结论与建议

1. **可提交**，核心功能闭环、无严重 Bug、性能可接受。
2. 提交前处理：
   - 删 `temp_*` 临时文件（勿提交）。
   - （建议）B2：队列文本补 `data-tooltip="点击编辑"`。
   - （建议）B1：三份实现加注释互相指引"此处同步 tooltip.ts"。
3. 提交范围：本功能线 8 个文件 + 文档；**与 `entry.ts` 留白修复已分开提交**（互不掺和）。
