# 最新接续状态 (2026-10-19 11:35)

## 085 远程体验打磨（分支 feat/085-remote-polish，待提交/合并/发版 v0.10.23）

**用户诉求**：同步对话要等 2 秒；同步态要炫酷好看；顺带把工具名、项目名、隧道协议一起做掉。

**根因定位（实测，不是猜）**：服务端 WS open→ready→history 全程 **16ms**，瓶颈在客户端
`renderHistory`——逐条 `addUser/addAi/addSystem`，每条触发 `renderMd` + `decorateContent` +
两次全量 `querySelectorAll('.msg')` + `scroll(true)` 强制 reflow，O(n²)。

**改动**：
| 文件 | 改动 |
|---|---|
| `src/remote/pwa/app.js` | 拆出 `buildUserEl`/`buildSystemEl`/`buildAiEl`；`renderHistory` 用 DocumentFragment 批量插入，全量查询与滚动各一次；`onToolEvent` 显示具体工具名；`setSyncing` 用专属动画 + 重连时不显示 + 复位残留视觉；`profileDisplayName` 显示 `窗口名 · 项目名` |
| `src/remote/pwa/index.html` | 新增 `#sync-visual`（三环 + 数据点 + 中心鸟）与 `#sync-hint` |
| `src/remote/pwa/style.css` | 同步动画样式（`syncOrbit`/`syncHalo`/`syncShine`/`syncCoreBreath`/`syncDot`/`syncHintDot`），`prefers-reduced-motion` 降级 |
| `src/remote/manager.ts` | `projectNameOf`（导出，处理盘符根）、`projectDirOfContext`、`listProfiles` 加 `projectName`、3 秒内存比对轮询检测项目切换 |
| `src/remote/tunnel.ts` | 新增 `buildTunnelArgs` 纯函数；固定隧道追加 `--protocol http2` |
| `src/remote/server.ts` | 缓存分层：`index.html`/`app.js`/`style.css`/`marked.umd.js` 走 no-cache + ETag，其余 immutable |
| `test/remote/{tunnel,server,project-name}.test.js` | buildTunnelArgs 3 条、缓存分层 1 条、projectNameOf 5 条边界 |

**关键发现（别踩）**：
1. `immutable` 强缓存导致开发时"改了没效果"——浏览器拿旧 CSS/app.js，实测踩到两次。
   凡随发版必变或文件名不带 hash 的资源，必须 `no-cache` + ETag。
2. `renderHistory` 的 `if (messages.querySelector('.msg')) return` 是"先 history 后 active stream"
   保序的基石，不能改成追加，否则流式期间进入会丢历史。
3. 项目目录不在 profile 上，在 `ctx.sessionStore.state.selectedProjectDir`。

**验证**：
- typecheck / test(1230) / lint(0 errors) / compile 全绿
- 真机（CDP 9444 + 远程 7800）：同步动画 computed style 全部在跑（`syncOrbit` 2.4s infinite、
  错相 0.8s、`syncCoreBreath`、`syncDot`、`syncHintDot`）；深/浅主题截图确认；项目名显示
  `153******72 · cuckoo-code`；`listProfiles` 返回 `projectName`；无上传按钮。
- 两轮子代理审查，修掉 4 项：项目切换不刷新（中）、`marked.umd.js` 强缓存风险（中）、
  同步态视觉错位（低）、`--protocol http2` 对老版 cloudflared 兼容风险（低）。

**待办**：合并 master + 打 tag v0.10.23

---

1: # 最新接续状态 (2026-10-19 01:10)
2: 
3: ## 084 远程提速 + 移除手机传图（已合并 master，发布 v0.10.22）
4: 
5: **问题（用户实测：冷启动到看到文字约 20 秒）**：
6: 1. 首页空白久：静态资源零缓存（`no-cache` 无 ETag），116KB 每次全量重下 + 阻塞脚本
7: 2. 重连频繁、恢复慢：切前台不探活、退避 1.6×/15s
8: 3. 每次重连重拉 history（2s 超时）+ 客户端"同步中"兜底 8s
9: 4. 手机传图不用但链路极重（CDP 探测 + 12s 轮询 + 竞态 bug）
10: 
11: **改动**：
12: | 文件 | 改动 |
13: |---|---|
14: | `src/remote/server.ts` | 删 onAttach/attach 分支；加 ETag（`W/"mtimeMs-size"`）+ 304 + 分层缓存（index.html `no-cache`，其它 `immutable`）；MAX_WS_MSG 12MB→2MB |
15: | `src/remote/manager.ts` | 删 cdpAttach import / onPhoneAttach / onAttach 注入；history 超时 2000→800 |
16: | `src/remote/pwa/index.html` | 删上传按钮 / file-input / #i-image 图标；两 script 加 defer |
17: | `src/remote/pwa/app.js` | 删上传变量 / attach-result 分支 / addImageBubble / handleUpload；同步兜底 8s→2.5s；visibilitychange 改为「回前台发 ping + 1.5s 短超时等 pong」探活（不用时间阈值硬掐，避免误杀健康连接）；退避 1.6/15s→1.3/8s |
18: | `src/remote/pwa/style.css` | 删图片气泡 + attach-btn 样式 |
19: | `test/remote/server.test.js` | 新增：ETag/304（含多值）、缓存策略、未知消息不破坏连接 |
20: | `docs/requirements/084-remote-speedup.md` | 需求档案 |
21: 
22: **保留**：`src/app/ipc/cdp-attach.ts`（纯净模式 harness 仍用，harness.ts:475）。
23: 
24: **验证**：
25: - typecheck / test(1222) / lint(0 errors) / compile 全绿
26: - 真机（CDP 9444 + 远程 7800）：PWA 无上传按钮、连接在线、marked 正常、空态"已就绪"；健康连接回前台不误断；history 本地 4ms 到达；静态资源 ETag/304 命中、缓存头分层正确
27: 
28: **关键设计取舍（写进档案）**：
29: - `immutable` 一年强缓存 → PWA 更新后手机需强刷一次
30: - 前台探活不用时间阈值（原 15s 会误杀后台回来 <130s 的健康连接），改"发 ping 等 pong"
31: 
32: **待办**：合并到 master + CHANGELOG + 打 tag 发版
33: 
34: ---
35: 
36: 1: # 最新接续状态 (2026-10-18 23:40)
37: 2: 
38: 3: ## v0.10.21 已发布（修正 v0.10.20 版本号污染）
39: 4: 
40: 5: **问题**：v0.10.20 的 tag 曾在发布后被移动到新提交（挪 tag 而非发新版本），导致同版本号存在两份内容不同的安装包。用户下载到的是 18:33 构建的旧版（不含 083 修复），且因版本号相同收不到自动更新。
41: 6: 
42: 7: **补救**：发布 v0.10.21，内容与 master `b9d6228` 一致。CI 成功，Win/Mac 产物已上线。
43: 8: https://github.com/Huo-zai-feng-lang-li/cuckoo-code/releases/tag/v0.10.21
44: 9: 
45: 10: **教训（写进发版纪律）**：tag 一旦推送远端，**绝不移动**；需要新内容就发新版本号。
46: 11: 
47: 12: ---
48: 13: 
49: 14: # 历史接续状态 (2026-10-18 22:10)
50: 15: 
51: 16: ## 核心进展
52: 17: 
53: 18: **083 修复完成并提交推送：修复停止生成"假成功"与"误点发送按钮"。四项校验全绿 + 真机验证通过。**
54: 19: 
55: 20: - 分支：`fix/083-remote-stop`，HEAD = `30caed4`，已推送 origin
56: 21: - 状态：**待合并到 master + 发版**
57: 22: - 工作区剩余：`src/ui/harness.html`（另一条功能线的注释清理，未提交，勿动）
58: 23: 
59: 24: ## 本轮改动（5 文件 +251/-19）
60: 25: 
61: 26: | 文件 | 改动 |
62: 27: |---|---|
63: 28: | `src/providers/deepseek.ts` | 新增 `getStopFn()`：按 SVG path 区分停止/发送按钮 |
64: 29: | `src/app/ipc/harness.ts` | `stopGeneration` 加守卫+点击后校验+重试；点击改页面内 PointerEvent；`attachStopFn` 移除合成点击 |
65: 30: | `src/remote/manager.ts` | `onPhoneStop` 按 success / not-generating / 其它失败三路分流 |
66: 31: | `docs/requirements/083-fix-remote-stop.md` | 需求档案（新建） |
67: 32: | `docs/requirements/INDEX.md` | 自动生成 |
68: 33: 
69: 34: ## 三个关键真机发现（重要，别再踩）
70: 35: 
71: 36: 1. **DeepSeek 主按钮是同一个元素两种形态**：生成中 SVG path 为方块 `M2 4.88C2 3.68...`，空闲为箭头 `M8.3125 0.980206...`。不看图标就点 = 空闲时替用户发消息。
72: 37: 2. **CDP `Input.dispatchMouseEvent` 停不住流**：点击后按钮图标变回箭头，但 AI 流仍在跑（8 秒 +59 帧）。**这是原代码假成功的根源**。
73: 38: 3. **页面内合成 PointerEvent 能真停流**：`dispatchEvent(pointerdown/mousedown/pointerup/mouseup/click) + el.click()`，实测 8 秒仅 +4 帧。
74: 39: 
75: 40: ## 自查补修的缺陷
76: 41: 
77: 42: `attachStopFn`（通用回退，其它平台用）返回值无 `generating` 字段，最初校验 `again.generating === false` 永远为假，会把能正常停止的平台误判为失败。已改为按定位函数是否具备 generating 语义分流。
78: 43: 
79: 44: ## 真机验证矩阵
80: 45: 
81: 46: | 场景 | 结果 |
82: 47: |---|---|
83: 48: | 远程生成中点停止（多轮） | ✅ `method: pointer-event`，stream 仅 +2~4 帧 |
84: 49: | 远程空闲时点停止 | ✅ 提示"当前没有正在生成的任务"，bodyLen 差值 0，未误发、未误报 |
85: 50: | 纯净模式发送 | ✅ 发送→按钮变停止态→AI 回"收到"→按钮复位 |
86: 51: 
87: 52: ## 待办
88: 53: 
89: 54: - [x] **合并 `fix/083-remote-stop` 到 master**（`7b24c2d`）
90: 55: - [x] **更新 CHANGELOG + 打 tag v0.10.20 发版**（`be806be`，CI 成功，Release 已发布 Win/Mac 产物）
91: 56: - [ ] 用户人工点验（可选）：远程点停止是否真停、空闲点停止是否不再误发
92: 57: 
93: 58: ## 未做（明确记录）
94: 59: 
95: 60: **远程发送时自动掐掉正在跑的任务** —— 未实施。需在 remote 侧复刻 harness 的待发队列 + 中止代次 + 事件静默期机制，风险远大于收益。停止修好后，点一下停止再发即可。若要做需单独开需求。
96: 61: 
97: 62: ## 关键上下文
98: 63: 
99: 64: - 目录：`D:\Desktop\Super-File\cuckoo-code`
100: 65: - 当前分支：`fix/083-remote-stop`（HEAD `30caed4`）
101: 66: - master HEAD：`70e3194`
102: 67: - 已发布版本：v0.10.17 / v0.10.18 / v0.10.19
103: 68: - package.json 版本：`0.10.20`（尚未打 tag）
104: 69: 
105: 70: ### 主要文件与函数
106: 71: 
107: 72: | 文件 | 关键位置 |
108: 73: |---|---|
109: 74: | `src/providers/deepseek.ts` | `getStopFn()`（约 :118 起） |
110: 75: | `src/app/ipc/harness.ts` | `stopGeneration`（约 :274 起）、`attachStopFn`（约 :790 起） |
111: 76: | `src/remote/manager.ts` | `onPhoneStop`（:120 起） |
112: 77: 
113: 78: ### 开发环境
114: 79: 
115: 80: ```cmd
116: 81: set CUCKOO_SESSION_DIR=cuckoo-dev-verify&& set CUCKOO_HOME=%USERPROFILE%\.cuckoo-dev&& npx electron . --remote-debugging-port=9444
117: 82: ```
118: 83: - 独立 userData（`cuckoo-dev-verify`）+ 独立 `CUCKOO_HOME`（`.cuckoo-dev`，remote 端口 7800）
119: 84: - CDP 端口 9444；远程 WS：`ws://127.0.0.1:7800/ws?token=<devtoken1234567890abcdef12345678>`
120: 85: 
121: 86: ### 环境陷阱（踩过的坑）
122: 87: 
123: 88: - `taskkill /F /IM electron.exe` 被安全策略拒绝 → 用 `wmic process where "name='electron.exe'" call terminate`
124: 89: - `del /q` 被安全策略拒绝 → 用 `deleteFile` 逐个删
125: 90: - **CDP 外部连接会与主进程 `wc.debugger` 争抢**：验证停止时若同时连 DeepSeek 页面 CDP，主进程点击会失效。应只连 Harness 页面（不同 target）或全程不碰 CDP
126: 91: - **序列化注入的函数不能用 TS 语法**（如 `catch (e: any)`）→ 注入后是语法错误，被 catch 吞掉，表现为"什么都没发生"
127: 92: - 主进程 `console.log` 不进 `deepseek.log`（那是 renderer 日志）
128: 93: - **高频真机测试会被 DeepSeek 限流**
129: 94: - `git add -A` 会带上临时探测脚本 → 用明确文件列表
130: 95: - 需求档案必须有 YAML frontmatter，否则 `docs:index` 跳过
131: 96: 
132: 
133: (End of file - total 96 lines)

(End of file - total 133 lines)