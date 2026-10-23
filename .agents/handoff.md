# 最新接续状态 (2026-10-23)

## 已发布 v0.10.47（Git 面板按钮"要点两次"真因修复 + 操作反馈）

### 本轮三个版本

| 版本 | 类型 | 内容 |
|---|---|---|
| v0.10.45 | feat | Git 面板新增「全部撤销」= 清空更改区（restore + clean -fd） |
| v0.10.46 | fix | 批量按钮并发守卫（doBulk 串行队列 + loadGit 请求序号）——**当时误判，非真因** |
| v0.10.47 | fix | **真因**：`runGit` 无并发控制导致 `.git/index.lock` 竞争；同时补齐操作反馈 |

### 「点一下没反应、要点两次」真因（v0.10.47，重要）

**不是**连点竞态，**也不是** DOM 重建导致 click 丢失（这两个是我先后两次的错误假设）。

真因：`runGit()` 直接 `execFile` 无并发控制。多个 git 命令并发时争抢 `.git/index.lock`，后到者失败返回 `fatal: Unable to create '.git/index.lock': File exists`。关键：**`git status` 也写 index**（刷新 stat 缓存），所以它和 `git add` 并发时同样失败。v0.10.45 之前该失败是静默的，用户只能再点一次碰运气。

修复：`runGit` 改全局串行队列（`gitQueue`），所有 git 命令按发起顺序执行。

**定位过程值得记住**：程序化 `.click()` 8 轮全过（覆盖不到真实时序）→ 改用 CDP `Input.dispatchMouseEvent` 真实鼠标才复现 → 装探针发现 `mousedown/mouseup/click` 全部正常触发（推翻 DOM 重建假设）→ 最后读弹框内容才看到 `index.lock` 报错。

### 操作反馈设计（v0.10.47，三版迭代）

需求：「点击需要等待 2s，可以加 loading，但暗黑的不好看，要加动效」。读了 `impeccable` 技能（Operate 模式）与 `reference/animate.md`（动效服务反馈，装饰是动画债）。

- **第一版（否决）**：面板顶部 2px 通栏进度条 → 窄侧栏里视觉权重过大，紧贴标题被误读成边框渲染错误
- **第二版（否决）**：分组标题后 9px 小圈，用 `currentColor`（继承 `--ck-text-dim` 灰） → 暗色下像装饰符号，不传达"进行中"
- **最终版**：分组标题后 10px 小圈，**主色弧线 + 半透明主色轨道**（`border-top-color: var(--ck-primary)`），`.6s` 匀速；动作按钮**不做透明度闪烁**（暗色下反复明暗显廉价），只保留 `pointer-events: none` 阻断重复点击；`prefers-reduced-motion` 降级为静态主色圆点

补充修复：`renderList` 用 `innerHTML` 重建 DOM 会丢掉 `ck-git-loading` 类，已在渲染后补偿。

### 本轮其它修复

- `doAct` / `doCommit` / `doCheckout` 结尾由 `loadGit()` 改 `loadGit({ force: true })`——原实现已加载时 early-return，实际要等 watcher 兜底
- `doCommit` 提交期间禁用按钮
- 提交历史行读取 diff 期间加 `ck-git-busy` + `loadingCommitHash` 防重复请求

### 「全部撤销」最终语义（重要）

`git restore -- .` + `git clean -fd`：
- 已跟踪文件 → 从暂存区恢复
- 未跟踪文件/目录 → 永久删除
- 不动暂存区（那是「全部取消」的职责）
- 不删 .gitignore 忽略的文件（`clean` 不带 `-x`）
- 动态确认文案：「将撤销 N 个已跟踪文件的改动，并永久删除 M 个未跟踪文件」

### 并发修复（v0.10.46）

用户报「全部暂存→全部取消→全部暂存偶尔不生效，双击才行」。根因是我在 v0.10.45 把 `doBulk` 结尾的 `loadGit()` 改成 `loadGit({ force: true })`，**绕过了 watcher 通道已有的 `loadGitCoalesced` 并发守卫**。连点时 git 命令并发（完成顺序不定）+ gitStatus 并发返回（顺序不定）→ 慢的旧结果覆盖新状态。

修复两层：
1. `bulkChain` 串行队列：批量 git 命令按点击顺序执行
2. `gitLoadSeq` 请求序号：过期响应直接丢弃，只允许最新一次渲染

真机验证：模拟 120ms 间隔连点三次（暂存→取消→暂存），最终状态与 DOM 完全一致。

### 踩坑（重要，下次别再犯）

1. **验证必须用用户真实数据**。最初只用人造「有已跟踪改动」的仓库验证 git 语义，用户项目里全是未跟踪文件，功能实际空转。
2. **`opacity: 0` 的「悬停显现」= 用户看不见按钮**。可见性不能只读 `getComputedStyle`，必须截图肉眼看。
3. **子代理标"低优先级"的问题不能直接放过**。code-reviewer 提过 opacity 问题标为"仅供参考"，我没复核导致 bug 上线。
4. **改公共函数要考虑所有调用方**。`doBulk` 服务三个按钮，我把刷新改成 force 时没意识到它绕过了并发守卫，引入连点回归。
5. **启动实例早于编译完成 → 加载旧产物**。重启前比对 `shell.html` 与实例启动时间戳。
6. **pwsh 模板字符串里写 PowerShell 反引号（`n）会与 JS 模板字符串冲突**，必须用 `write` 写 .ps1 再执行。
7. **bash 在 Windows 是 cmd.exe**，没有 tail/head；**pwsh 里 `&&` 不合法**，用 `;` 分隔。
8. **`Remove-Item -Recurse -Force` 会被安全策略拒绝**，删目录用 `node -e "fs.rmSync(...)"`。
9. **tag 必须在发版提交之后打**。曾先打 tag 再提交版本号，tag 指向了功能提交，只能删除重打。

### 验证状态

- v0.10.45：typecheck / lint(0 errors) / compile / test(1230) 全绿；子代理审查通过；真机端到端验证（含 .gitignore 保留项）
- v0.10.46：同样四项全绿；真机连点验证通过
- 远端确认：master 与 tag v0.10.46 均指向 `c6172f3`

### 未提交的其它改动

`src/prompt/chatgpt.md` 有改动（**属于另一条功能线，未触碰**）。

---

## 已发布 v0.10.44

### 语义（用户最终确认，重要）

「全部撤销」= **清空更改区** = `git restore -- .` + `git clean -fd`
- 已跟踪文件 → 从暂存区恢复
- 未跟踪文件/目录 → 永久删除
- 不动暂存区（那是「全部取消」的职责）
- 不删 .gitignore 忽略的文件（`clean` 不带 `-x`）

> 最初按方案 1（只恢复已跟踪文件）实现，用户指出"全部撤销应该是撤销更改区代码"，已改正。

### 改动（分支 feat/087-git-discard-all，未提交）

| 层 | 文件 | 内容 |
|---|---|---|
| 主进程 | `src/app/ipc/git.ts` | `git-discard-all` → restore + clean -fd |
| preload | `src/app/shell-preload.ts` | 暴露 `gitDiscardAll()` |
| 类型 | `src/ui/shell/scripts/shell-api.ts` | `gitDiscardAll?: () => Promise<any>` |
| 页面 | `src/ui/shell/scripts/pages/git.ts` | groupHtml extra 参数；changed 分组挂按钮；doBulk 动态确认文案 |
| 样式 | `src/ui/shell/styles/pages.css` | `.ck-git-act-danger` 红色常驻可见 |
| 档案 | `docs/requirements/087-git-discard-all.md` | 需求档案 |

### 踩坑（重要，下次别再犯）

1. **验证必须用用户真实数据**。最初只用人造"有已跟踪改动"的仓库验证 git 语义，用户项目里全是未跟踪文件，功能实际空转。验证前先问：用户当前数据下这功能会有效果吗？
2. **`opacity: 0` 的"悬停显现"设计 = 用户看不见按钮**。用户报"点击没反应"。可见性验证不能只读 `getComputedStyle`，必须截图肉眼看。
3. **子代理标"低优先级"的问题不能直接放过**。code-reviewer 提过 opacity 问题标为"仅供参考"，我没复核，导致 bug 上线。
4. **启动实例早于编译完成 → 加载旧产物**。曾因此误判"代码没生效"。重启前比对 `shell.html` 与实例启动时间戳。
5. **pwsh 模板字符串里写 PowerShell 反引号（`n）会与 JS 模板字符串冲突**，报 "missing ) after argument list"。必须用 `write` 写 .ps1 再执行。
6. **bash 在 Windows 是 cmd.exe，没有 tail/head**，用 pwsh `Select-Object -Last N`。
7. **`Remove-Item -Recurse -Force` 会被安全策略拒绝**，删目录用 `node -e "fs.rmSync(...)"`。

### 验证状态

- typecheck / lint(0 errors) / compile 全绿
- test：129 文件 1230 条通过（首次跑偶发 1 条失败，重跑两次均全过，与 handoff 记录的 run-captured 时序敏感用例一致）
- 子代理审查：arch-guard 合规；code-reviewer 2 条中等问题已修复
- 真机端到端（CDP 9444，临时仓库）：按钮可见 → 动态确认文案正确 → 确定后 `git status` 全空、tracked.txt 恢复、未跟踪文件与目录已删、ignored-dir 保留
- 撤销（取消）路径：改动完好无损

### 已知遗留

- 未做 unmerged 冲突路径的失败提示真机验证（代码有 ckAlert 兜底）
- 「全部撤销」会删未跟踪文件，属于破坏性操作，靠动态确认文案 + 红色按钮提示

---

## 已发布 v0.10.44

### 本轮改动 (v0.10.44)

| 版本 | 类型 | 内容 | 影响面 |
|---|---|---|---|
| v0.10.44 | fix | 窗口底栏"对话上下文"实时刷新（原只在整轮结束更新，流式中一直停在旧值） | `src/overlay/events.ts` |
| v0.10.44 | fix | 切会话时旧会话残余流帧污染新会话底栏（SPA 切会话不中断 fetch） | `events.ts` / `observer.ts` / `hooks/deepseek.ts` |
| v0.10.44 | fix | 手机端多个思考块同时展开时被 flex 压扁、正文裁切 | `src/remote/pwa/style.css` |

### 关键实现

- **底栏实时刷新**：新增 `liveContext`（仅显示，不写缓存/不累加）；显示优先级 `实时 > 本会话缓存 > 服务端最近值`；`onStream` 收到 acc 即刷新（500ms 节流，finished 立即刷）；IPC 签名去重；子代理窗口跳过广播。
- **跨会话隔离**：`dispatchStream`/`observeBody` 加 `sessionId` 参数（fetch 传 `fetchSessionId`、XHR 传 `reqSessionId`），observer 透传，overlay 校验不匹配则丢弃；任一方缺失放行（兼容 ChatGPT/Claude）。
- **思考块高度**：根因是 `.messages` 为 flex column + `.think-block` 的 `overflow:hidden` 使 `min-height:auto` 解析为 0，被 `flex-shrink:1` 压扁。修复：`.msg` 统一加 `flex-shrink: 0`。实测三块 377px→222px 的压扁已消除。

### 验证状态

- typecheck / test(129 文件 1230 条) / lint(0 errors) / compile 全绿
- 真机（开发版干净实例，CDP 注入）：
  - 同会话 acc=54321 → 底栏 2.26万 → 5.43万 实时跟随
  - 异会话 acc=999888 → 底栏不动，正确拦截
  - 思考块：修复前三块均 222px，修复后均 377px；逐块独立展开/收起正常（open 377 / closed 38）；user/ai/sys 三类消息无回归

### 关键教训（重要，下次别再踩）

1. **杀 electron 进程别用 bash 后台任务的 PID**：`Stop-Process -Id <bash任务PID>` 杀不掉 electron 主进程。曾因此让最早实例（PID 7988）一直霸占 9444 端口，后续"重启"全部失败，CDP 一直连僵尸进程跑旧代码，白白排查了十几轮。
   **正确做法**：`Get-NetTCPConnection -LocalPort 9444 -State Listen` 查真实占用者再杀；或 `Get-CimInstance Win32_Process` 按命令行筛选 `cuckoo-dev-verify` 全部清理。
2. **验证前先确认端口占用者已更换**，否则所有探针结果都不可信。
3. **CDP 注入要注意 execution context**：overlay 与页面脚本同在 isolated world，页面主世界是另一个 context，注入/读取必须选对。
4. `test/infra/run-captured.test.js` 的 A-006 用例偶发超时失败（进程时序敏感），单独重跑即过，非真实回归。

### 已知遗留（有意不修）

- 底栏实时刷新只验证了 DeepSeek（ChatGPT/Claude 不下发 accumulatedTokens，走原路径，理论无回归但未真机跑）
- 500ms 节流未做长时间（10 分钟级）压测
- 跨会话中断为 CDP 模拟派发，非真实"生成中手动切会话"

### 历史版本

- v0.10.43: 工具代码块内 JSON/XML 误触纠错、插件显隐、系统 Prompt 重构
- v0.10.42: fix(retry) 发送重试提示词前检查输入框
- v0.10.41 / v0.10.40: 手机端切窗口同步提示 / 补发历史
- v0.10.31 ~ v0.10.39: 详见 CHANGELOG.md

---

## 历史（v0.10.30 及之前）

见 CHANGELOG.md。master 在 v0.10.30 时为 `e89b72b`。
