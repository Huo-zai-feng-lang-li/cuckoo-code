# 最新接续状态 (2026-10-26 15:20)

## 核心进展

### 当前版本：v0.10.53（远程控制体验修复）

**背景**：用户反馈通过 Cloudflare 隧道连接手机远程控制时，UI 不显示在线设备数，且 Token 错误时没有提示只会无脑重启。

**修复**：
- `src/ui/shell/scripts/pages/remote.ts`：移除硬编码的 `setTimeout`，加入 3 秒 `setInterval` 轮询，实时同步设备连接数。
- `src/remote/tunnel.ts`：增加对 `cloudflared` stderr 的致命错误拦截（Token 格式错误等），不再触发无效的自愈重启，并把错误原样抛给前端。
- `src/remote/tunnel.ts`：修复 `fatalStartError` 的变量声明位置，确保作用域正确。

---

1: # 最新接续状态 (2026-10-26)
2: 
3: ## 核心进展
4: 
5: ### 当前版本：v0.10.52（配置入口统一到 .agents/）
6: 
7: **改动**：规则 / 技能 / MCP 三类配置入口从 `.cuckoo/` 统一到 `.agents/`，与 Claude Code / Codex / Cursor 等工具目录约定对齐。
8: 
9: | 文件 | 改动 |
10: |---|---|
11: | `src/rules/scanner.ts` | 项目级读 `.agents/rules/`（删除了 `.cuckoo/rules/` 回退）；用户级读 `~/.agents/rules/` |
12: | `src/skills/scanner.ts` | 项目级/用户级均改 `.agents/skills/` |
13: | `src/mcp/config.ts` | 项目级/用户级 MCP 配置改 `.agents/mcp.json` + `.agents/mcp-state.json` |
14: | `src/rules/defaults.ts`、`src/app/entry.ts`、`src/app/shell-preload.ts`、`src/ui/shell/scripts/shell-api.ts` | 注释/文档路径同步 |
15: | `docs/arch/01-structure.md`、`docs/mcp.md`、`docs/rules.md`、`docs/skills.md` | 文档同步 |
16: 
17: **不受影响（保持原样）**：
18: - 用户数据目录：`~/.cuckoo/memories.json`、`remote.json`、`snapshots/`、`plugins/`、`theme-state.json`、`ui-prefs.json` 等
19: - 项目级子代理：`.cuckoo/agents/*.md`（`workspace-trust.ts` 两段独立探测）
20: - `CUCKOO.md`：`prompt-builder.ts` 仍优先读 `.cuckoo/CUCKOO.md`
21: - 插件级 skills：通过 `extraSkillDirs` 注入，路径不变
22: 
23: **迁移核查**（本机实测，零迁移成本）：
24: - `~/.cuckoo/rules/` 空目录（0 条目）→ 已删
25: - `~/.agents/rules/` 已有 `codegraph.md`、`rule.md` ✅
26: - `~/.agents/skills/` 已有 32 个技能 ✅
27: - `~/.agents/mcp.json` 已有 playwright / context7 / cloudflare ✅
28: - 项目级 `.agents/rules/`（11 条）+ `.agents/skills/`（hello）✅
29: 
30: **已知小不一致（不影响功能）**：
31: - `src/rules/files.ts:85` 的种子标记仍为 `~/.cuckoo/.rules-seeded`，仅用于"是否写默认规则"的幂等判断，不会覆盖用户已有规则。
32: 
33: **清理**：
34: - 删除 `~/.cuckoo/rules/`（空目录）
35: - 删除 `~/.agents/mcp - 副本.json`
36: 
37: ---
38: 
39: 1: # 最新接续状态 (2026-10-23 18:32)
40: 2: 
41: 3: ## 核心进展
42: 4: 
43: 5: ### 当前版本：v0.10.51（格式误报修复）
44: 6: 
45: 7: 用户报告「很多误报」——AI 在正文里举例/贴数据结构时，被拦截器当成真实工具调用，发纠正提示打断回复。已修复并提交（详见 `docs/requirements/088-format-false-positive.md`）。
46: 8: 
47: 9: **改动（4 处）**：
48: 10: | 文件 | 内容 |
49: 11: |---|---|
50: 12: | `src/bridge/intercept/observer.ts` | `stripInlineCodeAndQuotes` 补剥离中文引号「」『』“”、中文括号（）、Markdown 表格行；XML 纠错提示移除 intent 回显；正常文本回复时清零 `formatHintCount` |
51: 13: | `src/bridge/parser/json-detector.ts` | `JSON_TOOL_CALL_RE` 收窄：冒号后必须是合法 JSON 值开头 |
52: 14: | `src/prompt/{deepseek,claude,default}.md` | 「禁止 XML/DSML/antml」改纯正向表述，不再点名格式（点名本身是弱诱导） |
53: 15: | `test/bridge/intercept/observer.test.js` | +9 用例（35→44） |
54: 16: 
55: 17: **关键取舍**：`stripToolBlocks` 曾尝试剥离所有围栏，被既有测试「不剥离 json/python 块（真错误不放过）」否决 → 回退，尊重项目「宁可误报不漏报」原则。
56: 18: 
57: 19: **发版闭环**（2026-10-23 18:42 取证）：
58: 20: - 本地 master = origin/master = `2ee9c60`，领先提交 0
59: 21: - tag `v0.10.51` → `a504f52`
60: 22: - CI：Build and Release success、Quality success、Coverage success
61: 23: - Release `v0.10.51` 已发布（非 draft/prerelease），12 个产物齐全（win exe 194.5MB + mac x64/arm64 dmg/zip + blockmap + latest.yml）
62: 24: 
63: 25: **真机验证已闭环**（2026-10-23 18:37，实例 PID 2988 启动 18:36:42 > 产物 18:36:41）：
64: 26: 
65: 27: | 场景 | 期望 | 实测 |
66: 28: |---|---|---|
67: 29: | 中文引号包伪代码举例 | 不触发 | ✅ 0 次 |
68: 30: | 中文括号包标签 | 不触发 | ✅ 0 次 |
69: 31: | 表格里的标签 | 不触发 | ✅ 0 次 |
70: 32: | 伪代码 `{tool: ...}` | 不触发 | ✅ 0 次 |
71: 33: | 行内反引号引用 | 不触发 | ✅ 0 次 |
72: 34: | 裸 invoke 标签 | 触发 | ✅ 文案正确、无属性串回显 |
73: 35: | 裸 JSON 调用 | 触发 | ✅ 文案正确 |
74: 36: | DSML 竖线后带空格 | 触发 | ✅ 文案正确 |
75: 37: 
76: 38: 验证方式：CDP 9444 连隔离世界，向 `window` 投 `cuckoo-ai-response` 事件，劫持 `sendEnterToChat` 观察触发。
77: 39: 
78: 40: > **测试纪律**：用户已明确授权——AI 可向真实对话页注入测试事件（含故意构造的错误格式）。要求：① 每次投递后必须清空输入框残留（触发 `input` 事件让受控组件更新）；② 测试前告知用户，避免误以为出现新 bug；③ 跑完做一次彻底清理（还原劫持的 electronAPI、停探针、清输入框、隐藏遮罩）。
79: 41: 
80: 42: ### 历史：v0.10.50（DSML 纠正提示修复）
81: 43: 
82: 44: 修复"模型输出 DSML 格式工具调用时，系统纠正提示反而把 `<|DSML|invoke>` 标签写回给模型，形成反向诱导"的问题。
83: 45: 
84: 46: | 提交 | 内容 |
85: 47: |---|---|
86: 48: | `d38b2ed` | 纠错提示去标签回显 + DSML 正则容忍竖线后空格 + 补回归测试 |
87: 49: | `5fcda4e` | 三份提示词模板移除 DSML 具体语法示例 |
88: 50: 
89: 51: **发版闭环已完成**（2026-10-23 复核，走代理 `http://127.0.0.1:51081` 查 GitHub API 取证）：
90: 52: - 本地 master = origin/master = tag `v0.10.50` = `6c5fd4a`，领先提交数 0
91: 53: - Actions run #160（release.yml）`conclusion: success`，2026-10-23T10:12:48Z 结束
92: 54: - Release `v0.10.50` 已发布（非 draft/非 prerelease），10 个产物齐全：win exe 194.5MB、mac x64/arm64 dmg+zip、latest.yml
93: 55: 
94: 56: **未闭环项**：
95: 57: - [ ] 用户安装新打包版后才能看到新提示文案（各产物 downloads=0，尚未有人下载）
96: 58: 
97: 59: > 踩坑补充：本机 curl 必须显式 `-x http://127.0.0.1:51081`，只设 `HTTPS_PROXY` 环境变量对 curl 不生效（直连 GitHub 超时 exit 28）。
98: 60: 
99: 61: ### 历史：Git 面板「全部撤销」（v0.10.45~v0.10.48）
100: 62: 
101: 63: Git 面板「全部撤销」功能已完成并发布**四个版本**，均已推送远端：
102: 64: 
103: 65: | 版本 | 提交 | 内容 |
104: 66: |---|---|---|
105: 67: | v0.10.45 | `a7a5b4d` | 新增「全部撤销」= 清空更改区 |
106: 68: | v0.10.46 | `c6172f3` | 并发守卫（**后证实为误判产物**，保留无害） |
107: 69: | v0.10.47 | `58a0c62` | **真因修复**：`runGit` 全局串行队列 + 操作反馈 |
108: 70: | v0.10.48 | `ccad99b` | 串行队列超时兜底 + 失败提示补全 |
109: 71: 
110: 72: 远端 master 与 tag `v0.10.48` 均指向 `ccad99b`。
111: 73: 
112: 74: ## 核心动机与背景 (Motivation & Background)
113: 75: 
114: 76: 用户需求演进三次，每次都纠正了我的理解偏差：
115: 77: 
116: 78: **1. 语义纠正**：「全部撤销」不是「只恢复已跟踪文件」，用户原话——「**不是有全部取消吗？全部撤销应该是撤销更改区代码**」。
117: 79: 最终语义：`git restore -- .` + `git clean -fd`
118: 80: - 已跟踪文件 → 从暂存区恢复
119: 81: - 未跟踪文件/目录 → 永久删除
120: 82: - 不动暂存区（那是「全部取消」的职责）
121: 83: - 不删 `.gitignore` 忽略项（`clean` 不带 `-x`）
122: 84: 
123: 85: **2. Bug 纠正**：用户先报「点全部暂存→全部取消→全部暂存偶尔不生效，双击就行」，我误判为连点竞态并发布 v0.10.46。用户随后纠正——「**批量按钮快速连点不生效，不是这个。我是说有时候点击全部暂存需要点两下才可以**」。
124: 86: 
125: 87: **真因（v0.10.47 才找到）**：`runGit()` 直接 `execFile` **无任何并发控制**。多 git 命令并发争抢 `.git/index.lock`，后到者失败返回 `fatal: Unable to create '.git/index.lock': File exists`。关键点：**`git status` 也会写 index**（刷新 stat 缓存），所以它和 `git add` 并发时同样撞车。v0.10.45 之前该失败是静默的，用户只能靠再点一次碰运气。
126: 88: 
127: 89: **3. 动效需求**：「点击需要等待 2s，可以加 loading，但暗黑的不好看，要加动效」→ 第一版做好后用户反馈「**动效不好看**」，重做两轮才定稿。
128: 90: 
129: 91: ## 关键设计与实现 (Implementation & Decisions)
130: 92: 
131: 93: ### 1. `runGit` 全局串行队列（`src/app/ipc/git.ts`，真因修复）
132: 94: 
133: 95: ```ts
134: 96: let gitQueue: Promise<unknown> = Promise.resolve();
135: 97: const GIT_TIMEOUT_MS = 30000;
136: 98: 
137: 99: function runGit(root, args) {
138: 100:   const exec = () => new Promise((resolve) => {
139: 101:     execFile('git', args, { cwd: root, maxBuffer: 8*1024*1024, windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
140: 102:       if (err) {
141: 103:         // 超时被强制终止：给中文提示而非 Node 原始 "Command failed"
142: 104:         if (err.killed || err.signal) return resolve({ success: false, stdout: stdout||'', stderr: 'git 命令执行超时（30 秒），已强制终止...' });
143: 105:         return resolve({ success: false, stdout: stdout||'', stderr: stderr || err.message });
144: 106:       }
145: 107:       resolve({ success: true, stdout: stdout||'', stderr: stderr||'' });
146: 108:     });
147: 109:   });
148: 110:   // then(exec, exec)：前一条失败也继续执行下一条，避免一次失败卡死队列
149: 111:   const next = gitQueue.then(exec, exec);
150: 112:   gitQueue = next.then(() => {}, () => {});
151: 113:   return next;
152: 114: }
153: 115: ```
154: 116: 
155: 117: **超时兜底是必要的**：串行队列的代价是「前一条卡住，后面全等」，没超时的话一条挂死会拖垮整个 Git 面板（比修复前更糟：从「单功能卡住」变成「整个面板卡死」）。
156: 118: 
157: 119: ### 2. 操作反馈（`pages/git.ts` + `pages.css`，三版迭代）
158: 120: 
159: 121: 读了 `impeccable` 技能的 Operate 模式 + `reference/animate.md`（动效服务反馈，装饰是动画债）。
160: 122: 
161: 123: | 版本 | 方案 | 否决原因 |
162: 124: |---|---|---|
163: 125: | 一 | 面板顶部 2px 通栏进度条 | 窄侧栏（46~320px）里视觉权重过大，紧贴标题被误读成边框渲染错误 |
164: 126: | 二 | 分组标题后 9px 小圈，`currentColor`（继承灰色） | 暗色下像装饰符号，不传达「进行中」 |
165: 127: | **三（最终）** | 分组标题后 10px 小圈，**主色弧线 + 半透明主色轨道**，`.6s` 匀速 | ✅ |
166: 128: 
167: 129: 最终 CSS：
168: 130: ```css
169: 131: @keyframes ck-git-spin { to { transform: rotate(360deg); } }
170: 132: .ck-git-group.ck-git-loading .ck-git-group-title::after {
171: 133:   content: ""; display: inline-block; width: 10px; height: 10px;
172: 134:   margin-left: 7px; vertical-align: -2px;
173: 135:   border: 1.5px solid color-mix(in srgb, var(--ck-primary) 32%, transparent);
174: 136:   border-top-color: var(--ck-primary);
175: 137:   border-radius: 50%;
176: 138:   animation: ck-git-spin .6s linear infinite;
177: 139: }
178: 140: ```
179: 141: 
180: 142: 配套决策：
181: 143: - **不对整块内容降透明度**——暗色下整块发灰会显得像坏掉
182: 144: - **不做透明度闪烁**——反复明暗交替显廉价，只保留 `pointer-events: none` 阻断重复点击
183: 145: - `prefers-reduced-motion` 降级为静态主色圆点
184: 146: 
185: 147: ### 3. 忙碌态用引用计数 + DOM 重建补偿（关键细节）
186: 148: 
187: 149: ```ts
188: 150: let gitBusyCount = 0;
189: 151: function setGitBusy(on: boolean): void {
190: 152:   gitBusyCount = Math.max(0, gitBusyCount + (on ? 1 : -1));
191: 153:   document.querySelectorAll('.ck-tab[data-panel="git"] .ck-git-group').forEach((g) => {
192: 154:     if (gitBusyCount > 0) g.classList.add('ck-git-loading');
193: 155:     else g.classList.remove('ck-git-loading');
194: 156:   });
195: 157: }
196: 158: ```
197: 159: 
198: 160: **必须用计数而非布尔**：并发操作时布尔会被先完成的那个提前清掉。
199: 161: 
200: 162: **`renderList` 里必须补偿**：`listEl.innerHTML = html` 重建 DOM 会丢掉运行时添加的 `ck-git-loading` 类：
201: 163: ```ts
202: 164: listEl.innerHTML = html;
203: 165: if (gitBusyCount > 0) {
204: 166:   listEl.querySelectorAll('.ck-git-group').forEach((g) => g.classList.add('ck-git-loading'));
205: 167: }
206: 168: ```
207: 169: 
208: 170: ### 4. 失败提示补全（v0.10.48）
209: 171: 
210: 172: - `loadBranch` 失败原因挂元素 `title`（原来静默显示占位符 `—`）
211: 173: - `loadHistory(opts?: { silent?: boolean })`：用户主动触发失败才弹框，后台自动刷新（watcher/切项目）失败只记 `console.warn`，避免反复弹框骚扰
212: 174: - `doAct` / `doCommit` / `doCheckout` 结尾统一 `loadGit({ force: true })`——原来 `loadGit()` 在已加载时 early-return，实际要等 watcher 兜底（400ms 防抖甚至不触发）
213: 175: 
214: 176: ### 5. 并发守卫（v0.10.46，误判产物但保留）
215: 177: 
216: 178: `bulkChain` 串行队列 + `gitLoadSeq` 请求序号（丢弃过期响应）+ `bulkInProgress` 屏蔽 watcher 刷新。虽非真因，但确实减少了无效并发，无害保留。
217: 179: 
218: 180: ## 待办事项 (Next Steps)
219: 181: 
220: 182: - [x] **CI 构建结果已确认**：v0.10.50 run #160 success；v0.10.45~v0.10.48 同理可查（`api.github.com/repos/Huo-zai-feng-lang-li/cuckoo-code/actions/runs`，需带代理）
221: 183: - [ ] **unmerged 冲突路径未真机验证**：`git restore` 遇 unmerged 会整体中止，代码有 `ckAlert` 兜底但未实测
222: 184: - [ ] `index.lock` 是概率性 bug，10 次真机操作只能证明改善，无法证明 100% 消除（串行化原理上已根除该并发路径）
223: 185: - [ ] 用户项目 `yfcode` 里有 12 个 `.playwright-cli/*.yml` 未跟踪文件，建议加进该仓库的 `.gitignore`
224: 186: 
225: 187: ## 关键上下文
226: 188: 
227: 189: - **目录**: `D:\Desktop\Super-File\cuckoo-code`
228: 190: - **分支**: `master`
229: 191: - **主要文件**:
230: 192:   - `src/app/ipc/git.ts` —— `runGit`（串行队列 + 超时）、`git-discard-all` handler
231: 193:   - `src/ui/shell/scripts/pages/git.ts` —— `doBulk`/`doBulkInner`、`setGitBusy`、`withBusy`、`loadGit`、`loadHistory`、`loadBranch`、`doAct`、`doCommit`、`doCheckout`、`showCommit`
232: 194:   - `src/ui/shell/styles/pages.css` —— `.ck-git-loading`、`.ck-git-spinning`、`.ck-git-busy`、`.ck-git-act-danger`
233: 195:   - `src/app/shell-preload.ts` —— `gitDiscardAll`
234: 196:   - `src/ui/shell/scripts/shell-api.ts` —— 类型声明
235: 197:   - `docs/requirements/087-git-discard-all.md` —— 需求档案
236: 198: - **需求档案编号**: 087（下一份用 088）
237: 199: 
238: 200: ## 踩坑记录（重要，下次别再犯）
239: 201: 
240: 202: 1. **先取证再下结论**。我对「要点两下」误判两次（先判连点竞态、再判 DOM 重建），真因是 `.git/index.lock` 竞争，靠**读弹框内容**才定位。
241: 203: 2. **程序化 `.click()` 覆盖不到真实交互**。必须用 CDP `Input.dispatchMouseEvent`（mouseMoved/mousePressed/mouseReleased）才能复现时序相关 bug。
242: 204: 3. **PowerShell 输出会吞前导空格**，导致误读 `git status` 的 `M ` vs ` M`。判断暂存状态用 `git status --porcelain=v1 | ForEach-Object { '[' + $_ + ']' }` 加括号才看得清。
243: 205: 4. **验证必须用用户真实数据**。最初只用人造「有已跟踪改动」的仓库验证，用户项目全是未跟踪文件，功能实际空转。
244: 206: 5. **`opacity: 0` 的「悬停显现」= 用户看不见按钮**。可见性不能只读 `getComputedStyle`，必须截图肉眼看。
245: 207: 6. **子代理标「低优先级」的问题不能直接放过**。code-reviewer 提过 opacity 问题标为「仅供参考」，我没复核导致 bug 上线。
246: 208: 7. **改公共函数要考虑所有调用方**。`doBulk` 服务三个按钮，改刷新逻辑时引入过回归。
247: 209: 8. **启动实例早于编译完成 → 加载旧产物**。重启前比对 `shell.html` 与实例启动时间戳。
248: 210: 9. **pwsh 模板字符串里写 PowerShell 反引号（\`n）会与 JS 模板字符串冲突**，必须用 `write` 写 .ps1 再执行。
249: 211: 10. **bash 在 Windows 是 cmd.exe**，没有 tail/head；**pwsh 里 `&&` 不合法**，用 `;` 分隔；**`Remove-Item -Recurse -Force` 会被安全策略拒绝**，删目录用 `node -e "fs.rmSync(...)"`。
250: 212: 11. **tag 必须在发版提交之后打**。曾先打 tag 再提交版本号，指向错误 commit，只能删除重打。
251: 213: 12. **测试偶发 1 条失败**（`test/agents` 或 `test/infra/run-captured` 时序敏感用例），重跑即过，非回归。
252: 214: 
253: 215: ## 历史版本（v0.10.44 及之前）
254: 216: 
255: 217: 见 `CHANGELOG.md`。
256: 218: 
257: 
258: (End of file - total 218 lines)

(End of file - total 258 lines)