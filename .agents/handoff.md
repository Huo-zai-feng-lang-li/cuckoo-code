# 最新接续状态 (2026-10-29 14:30)

## 核心进展
- **v0.10.175 已发布**（master `a991ba7`，tag 已推送，CI 构建中）：
  - Android 应用图标可切换（4 套，activity-alias 方案）
  - 遮罩超时对齐任务上限 + 降级态
  - 纯净模式停止不清输入框
  - 子代理卡片增强（倒计时 + 单杀停止）
- 当前工作区干净。

## 本轮修复的核心问题

### 1. Android 应用图标切换（需求 099，done）
- 4 套图标：default（黑底双蛋，Windows 同款）/ glass / sticker / gold
- `android/app/src/main/res` 下 60 张 PNG + 12 个 XML
- `AppIconPlugin.java`：activity-alias + SharedPreferences 持久化
- `scripts/gen-android-icons.mjs`：从 `assets/android-icons/*.png` 生成全部资源
- PWA 侧顶栏调色板按钮 + 底部选择面板
- **待真机验证**（本机无 JDK）

### 2. 遮罩超时 bug（曾导致子代理 495s 困惑）
- 根因：遮罩硬编码 5min 超时，子代理上限 10min，任务还在跑遮罩先消失
- 修复：`src/infra/timeouts.ts` 统一常量；`observer.ts` 检测 `runAgent` 调用后传 12min
- 降级态：超时后不整体消失，改为半透明 + 保留停止按钮 + 文案「任务仍在后台执行（已 Ns），可点下方停止」

### 3. 纯净模式停止清输入框 bug
- 根因：`harness.html` 的 `stop()` 无条件 `input.value = ''`
- 修复：只清 pendingFiles/pendingHints，保留输入框内容

### 4. 子代理卡片增强
- RunningSubagent 加 timeoutMs 字段
- 卡片显示剩余 mm:ss 倒计时
- 停止按钮支持单杀（`cancelSubagentsByParent` 加 targetWindowId 过滤）
- 视觉重做（顶部扫光条 + 预览块光标 + hover 红调停止按钮）

### 5. 派发子代理协议
- 新增 `.agents/rules/subagent-dispatch.md`
- 硬约束：子代理完全无状态，严禁「上一轮你指出」等伪连续措辞；必须三要素自包含（用户原始目标 / 主代理修复逻辑 / 待检源码文件）
- 已记入长期记忆

## 待办事项 (Next Steps)

### P0 · 真机验证（用户手动）
- [ ] 图标切换：默认黑底双蛋 → 切 glass/sticker/gold，桌面几秒内更新，重启后保持
- [ ] 遮罩降级：普通工具 5min 超时降级；含子代理任务 12min 超时降级；降级后停止按钮可用
- [ ] 纯净模式停止：输入框有草稿时点停止，草稿保留
- [ ] 子代理卡片：倒计时正确显示；点单个停止只杀该子代理（并发多个时验证）
- [ ] 子代理派发：给全新子代理派任务时，用自包含上下文，不写"上一轮"

### P1 · 后续改进（未做）
- [ ] 子代理 runAgent 完整展示模块（时间轴/工具流/token），单开需求 100
- [ ] 子代理对话污染 DeepSeek/Claude 网页历史（N 个子代理 = 历史多 N 条），需产品决策是否要"跑完自动删除"
- [ ] 老版本升级兼容：LAUNCHER 从 MainActivity 迁到 activity-alias 后，旧桌面快捷方式会失效，需 release note 说明

### P2 · 历史遗留
- [ ] `ForegroundService` 通知小图标用系统图标，非品牌图标
- [ ] `gen-android-icons.mjs` 硬编码 `D:/Desktop/app-icon/*.png`（有 existsSync 降级不崩，仅 dev 脚本）
- [ ] 172/173 真机验证（本轮之后可能需要重验，因为遮罩逻辑变了）
- [ ] 092 并发池 A~H 真机验证
- [ ] v0.10.164 tag 违规仍在 origin，是否删除待定

## 关键上下文

### 项目目录
`D:/Desktop/Super-File/cuckoo-code`

### 关键文件（本轮改动）
- `src/infra/timeouts.ts` — 全局超时常量唯一真相源（新建）
- `src/overlay/panel.ts` — 遮罩降级态 + 动态超时（L195-252）
- `src/bridge/intercept/observer.ts` — `hasSubagentCall` 探测 + 遮罩超时传参（L180-270）
- `src/ui/harness.html` — `stop()` 不再清输入框（L4141-4175）
- `src/app/subagent.ts` — `cancelSubagentsByParent` 支持 windowId（L109-134）
- `src/ui/shell/scripts/pages/agents.ts` — 运行中卡片倒计时 + 停止按钮（L17-72）
- `.agents/rules/subagent-dispatch.md` — 派发子代理协议（新建）
- `android/app/src/main/java/com/cuckoo/cuckoocode/AppIconPlugin.java` — 图标切换插件（需求 099）

### 版本与提交
- 当前版本：`0.10.175`
- HEAD：`a991ba7`
- 待 CI 产出 Windows 安装包 + Android APK

### 发布纪律
- 版本号禁止含数字 4（已遵守：0.10.173 → 0.10.175，跳过 174）
- 三处一致：package.json / CHANGELOG 顶部 / git tag
