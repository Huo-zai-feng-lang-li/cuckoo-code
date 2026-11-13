# 最新接续状态 (2026-11-13 v0.10.227 需求 121 代码块增强已发布)

> 本文档为多任务接续文档。新窗口开工前**完整读一遍**。
> 当前分支：`master`（121 已合并并发布）
> 当前版本：`0.10.227`（版本号任意位置禁含数字 4）

---

## 0. 总览

四门禁全绿（146 测试文件 / 1490 用例，编译/类型检查/规范全绿）。

| 任务线 | 代码状态 | 备注 |
|---|---|---|
| 121 纯净模式代码块增强 | ✅ 已发布 v0.10.227 | 语法着色 + 独立复制；用户真机验证通过 |
| 120 CHANGELOG 按月拆分 + 内容规范 | ✅ 已合并 master | 根文件 184KB → 6.4KB |
| 119 初始化提示词上下文瘦身 | ✅ 已发布 v0.10.226 | 总省 3892 字符 |

---

## 1A. 最近一轮改动（需求 121，已发布）

详见 `docs/requirements/121-harness-code-block-enhance.md`。

- `scripts/build-hljs.mjs`：esbuild 打包 hljs core + 24 种语言 → `src/ui/vendor/hljs/hljs.min.js`（126KB，挂 `window.hljs`），已接入 `npm run compile`，产物随仓库跟踪。
- `src/ui/harness.html`：
  - `highlightCodeEl` / `decorateCodeBlocks` / `enhanceCodeBlocksHtml`，在 `renderMarkdown` 的 sanitizer + 数学恢复之后统一增强（6 个渲染入口全覆盖）；
  - 复制走 `#stream` 事件委托（流式重建不丢监听）；未知语言/高亮异常/空块一律降级不丢代码；
  - 新增 `plainBodyText()`：整条复制与「按文本匹配历史」不再被头栏（语言标签/复制文案）污染；实现要点是克隆后临时离屏挂进文档量 `innerText`（脱离文档会退化为 textContent 丢换行）；
  - 配色用 `--hl-*` CSS 变量两套，不引 hljs 主题。
- `src/bridge/harness-bridge.ts`：`stripToolBlocks` 收窄为只剥 ````cuckoo（js/javascript 块是正常示例代码，此前被误吞）。
  - ⚠️ `src/bridge/intercept/observer.ts` 里另有一份同名 `stripToolBlocks`，仍剥 js/javascript —— 那是**格式误报检测**语义，用途不同，**有意保留**，勿"统一"。
- 用户真机验证通过；四门禁全绿。

### 1.1 已知待办（本轮观察，非阻塞）

- 无语言标签的代码块走 `hljs.highlightAuto`，中文目录树/日志类内容有概率被染成杂乱颜色。属产品取舍，若用户反馈再考虑改为"仅显式语言才着色"。

---

## 1B. 更早一轮（需求 120）

- 新增 `changelogs/{2026-08,09,10,11}.md`，340 个版本按发布月份归档，内容零差异。
- 根 `CHANGELOG.md` 重建为：说明 + 版本索引表 + 最近 5 版。
- 新增 `scripts/migrate-changelog.mjs`、`scripts/changelog-locate.mjs`。
- 规则更新（`.agents/rules/project.md` 发版纪律）：条目写当月归档、根文件只维护索引 + 最近 5 版、单版 ≤15 行、只用标准六类。

---

## 2. 已知限制

- `changelogs/2026-10.md` 2716 行（当月 293 个版本），超 `readLines` 默认 2000 行上限。
  查历史用 `node scripts/changelog-locate.mjs <ver>` 定位后再分段读，不要读全量。

## 3. 历史遗留待办（转入）

- **真机验证待补（v0.10.222）**：启用代理/指纹时附件通道恢复需真机复验。注意 v0.10.223 已把 `shouldAttach` 改为纯文本恒返回 `false`，前提已变，先确认当前策略。
- **附件失败静默降级**：建议至少记录显式告警。

## 4. 后续建议

- `recentPrefixes` 容量上限边界测试；长暂停「暂停中用户主动中止」回归测试。
- 全局 `~/.agents/rules/rule.md` 不在项目 git 内，换机器需手动同步（备份 `rule.md.bak-20261112`）。
