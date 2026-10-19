# 最新接续状态 (2026-10-20)

## 待发布 v0.10.31（手机端滚动条美化 + 表格横滚修复 + 系统消息裁切修复）

### 本轮改动（`src/remote/pwa/style.css`，唯一文件）

| 项 | 根因 | 修复 |
|---|---|---|
| **表格无法横向滚动** | `.msg.ai th/td` 继承 `.msg.ai` 的 `overflow-wrap: anywhere`，长内容被压窄换行 → 表格永不溢出 → 已有的 `overflow-x: auto` 形同虚设 | 补 `white-space: nowrap`，表格保持原始宽度。真机实测 `scrollW 766 > clientW 348` |
| **系统消息被静默裁切** | `.msg.sys` 只有 `max-width: 90%`，无断词 → 长 URL/token 被 `.messages { overflow-x: hidden }` 裁掉且无滚动条提示 | 补 `word-break: break-word` + `overflow-wrap: anywhere` |
| **滚动条美化** | 原 `.messages` 三段式隐藏滚动条，与"表格/代码块靠滚动条表达还有内容"矛盾 | 取消隐藏；新增 Scrollbars 章节：4 token + `--sb-size: 4px`，覆盖 `.messages` / `.msg.ai pre` / `.msg.ai table` / `.think-body`，三态（默认/hover/active 用 accent），深色主题跟随，代码块单独用浅色滑块 |

### 关键教训 / 限制

1. **iOS Safari 忽略 `::-webkit-scrollbar` 样式**（2021 起），也不支持 `scrollbar-width`/`scrollbar-color`。iPhone 上是系统原生滚动条，本次美化不生效；Android Chrome / 桌面 Chromium / Firefox 生效。
2. **`.msg.ai` 的 `overflow-wrap: anywhere` 会继承到 `td`**：这是"表格看起来没横向滚动"的隐藏原因，容易被误判为 CSS 没写。
3. 用户明确"主流 AI APP 一屏显示不完的内容都有横向滚动条"：代码块和表格该横滚（保持内容原宽），普通正文该换行。不要把两类混为一谈。

### 验证状态

- typecheck / test(1225) / lint(0 errors) / compile 全绿
- 真机（Chromium 390x844 静态服务器 + injectJS 读 computed style）：
  - `messages.scrollbarWidth=thin`、`scrollbarColor=rgba(20,23,28,0.2) rgba(0,0,0,0)`
  - 表格 `scrollW 766 > clientW 348`（横滚生效）、`td.whiteSpace=nowrap`
  - 系统消息 `scrollW=clientW=315`、`wordBreak=break-word`（换行不裁切）
  - 深色切换后 `--sb-thumb=rgba(255,255,255,0.18)` 正常跟随

### 待用户验证

装 v0.10.31 + 手机强刷一次，验证：表格能否横滑、系统消息长 URL 是否换行、滚动条是否变细。

---

## 历史（v0.10.28，2026-10-19）

已发布 v0.10.28（远程两项修复 + 右侧导航滚动修复）。v0.10.29 / v0.10.30 又补了右侧导航 hover 平滑滚动。

- master 当前 = v0.10.30 tag = `e89b72b`
- v0.10.28 → `355d167`（ETag 纳入内嵌资源版本）
- v0.10.27 → `dbb2333`（不含 ETag 修复，勿用）
