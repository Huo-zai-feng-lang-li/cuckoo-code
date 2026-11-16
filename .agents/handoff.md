# 最新接续状态 (2026-11-16 v0.10.228 已发布 / 需求 123 待合并)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`refactor/123-prompt-budget`（123 已提交待合并；master 仍为 122 发布态）
> 当前版本：`0.10.228`（版本号任意位置禁含数字 4）

---

## 0. 总览

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| 123 提示词/回填 4 万字上限防护 | 🟡 代码完成，待合并发版 | 36k 总预算 + 四级降级；回填 26k 总预算 + 头尾截断；四门禁全绿 |
| 122 系统提示词工具段去重 | ✅ 已发布 v0.10.228 | 工具段 18,029 → 15,036（省 2,993）；四门禁全绿 |
| 121 纯净模式代码块增强 | ✅ 已发布 v0.10.227 | |
| 120 CHANGELOG 按月拆分 | ✅ 已合并 master | |
| 119 初始化提示词瘦身 | ✅ 已发布 v0.10.226 | |

---

## 1A. 最近一轮改动（需求 122）

详见 `docs/requirements/122-prompt-dedup.md`。

- `scripts/build-tool-api.mjs` 的 `render()`：JSDoc **一律压成单行**（`/** xxx */`），多行 doc 空白折叠为一行；语义（doc/paramDocs/returnsDoc/throws）一字不删。67 个 JSDoc 块归一化比对 **0 不一致**。
- `src/tools/api.d.ts`：11,972 → **11,489** 字符（行 436 → 257）。
- 删除 `TOOLS_LIST` 三重重复：
  - `src/session/prompt-builder.ts` 删 `getFormattedJsApiForPrompt()` 调用与 `{{TOOLS_LIST}}` 占位符；
  - 模板 `deepseek.md` / `default.md` / `claude.md` 删「可用工具函数」章节；**`chatgpt.md` 本就没有该占位符**；
  - `ToolRegistry.getFormattedJsApiForPrompt()` 方法**保留**（测试覆盖、插件可能复用）。
- 实测：工具段总字符 18,029 → 15,036（−16.6%），首屏提示词约 41KB → ~38KB。
- 静态验证（两个不同临时目录 buildPrompt）：工具段恒定、项目段各自注入、互不污染、无占位符残留。
- 四门禁全绿：typecheck 0 错 / test 146 文件 1490 用例 / lint 0 error（74 既有 warning）/ compile 通过。
- **未做**：真机 `npm start` 抓实际 prompt（静态 buildPrompt 验证已等价覆盖组装逻辑）。

### 1.1 后续可选（非本轮范围）

- 模板里 `- 所有工具函数都是异步的…` 与 `api.d.ts` 头部「使用规则速览」重复，可再合一处。
- `api.d.ts` 每个 interface 字段的 JSDoc 对 tsc 无用、对 AI 有用，可评估合并。

---

## 1B. 需求 123（未发版）

详见 `docs/requirements/123-prompt-budget.md`。

**背景取证**：2026-11-16 媒体与用户实测，DeepSeek App/网页端单次输入约 **4 万字**（不是 token，也不是模型上下文；官方尚无正式公告；API 不受影响）。本项目提示词 35,053 字符，仅余约 5,000；20KB CUCKOO.md 的项目已越线。

**改动**：
- `prompt-builder.ts`：总预算 36,000 字符 + 4 级降级；分段上限 CUCKOO.md 6,000 / 规则 7,000 / 技能 4,000 / 子代理 1,200 / 记忆 2,500 / DSH 3,000；工具契约永不裁剪。
- `rules/prompt.ts`、`skills/prompt.ts`、`agents/prompt.ts`：增加 `indexOnly` / `maxDesc` / `namesOnly` 降级渲染。
- `overlay/result-budget.ts`：单条仍 15,000，多段按 26,000 均分；截断改头尾保留（65/35）+ 自救标记。
- `chat-input.ts`：发送前 39,000 硬拦截；DOM 回退读回长度校验；初始提示遇长度类失败不再重试 30 次。
- 文档：`chatgpt.md` 不再指向不存在的 `systemPrompt.md`；`forgetMemory` 不再提示不存在的 `listMemories` 工具；清理 backlog/arch/prompts 的 `{{TOOLS_LIST}}` 残留。

**实测**：本项目 35,053 / 空项目 26,438 / 胖项目 27,579（25KB CUCKOO.md + 18KB 规则，已信任）。
**门禁**：typecheck 0 错 / 147 文件 1505 用例 / lint 0 error（73 既有 warning）/ compile 通过；`api.d.ts` 重跑 SHA256 稳定。
**未做**：真机 `npm start` 验证首条提示词完整填入、无长度告警。

---

## 2. 待办

- **需求 123 分支待合并 master + 发版**（CHANGELOG 追加 `changelogs/2026-11.md` 顶部，版本号禁含 4；下一版建议 0.10.229）。
- **需求 123 真机验证**：新建对话确认首条提示词完整填入；多段工具结果确认总长度与截断提示。
- **真机验证待补（v0.10.222）**：启用代理/指纹时附件通道恢复需真机复验（v0.10.223 已改 `shouldAttach` 纯文本恒 false，前提已变）。
- **附件失败静默降级**：建议至少记录显式告警。

## 3. 已知限制

- `changelogs/2026-10.md` 2716 行，超 `readLines` 默认 2000 行上限。查历史用 `node scripts/changelog-locate.mjs <ver>`。

## 4. 环境注意

- 探针脚本（`temp_probe_*.mjs`）已被 `.gitignore` 忽略，本轮临时探针已清理。
- 全局 `~/.agents/rules/rule.md` 不在项目 git 内，换机器需手动同步。
