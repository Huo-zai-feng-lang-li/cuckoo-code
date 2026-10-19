# Changelog

## [Unreleased]

## [0.10.34] - 2026-10-20

### Fixed

- **补 `filesDirty` 变量声明**（`src/ui/shell/scripts/pages/files.ts`）：v0.10.33 引入的 `filesDirty` 漏写 `let` 声明，成为隐式全局变量。esbuild 打包能跑，但不规范。

## [0.10.33] - 2026-10-20

### Changed

- **项目文件面板支持自动刷新**（`src/ui/shell/scripts/pages/files.ts`）：此前只有在面板内新建/删除文件，或手动点刷新按钮时才会更新，外部新建/删除了文件，切回面板仍是旧缓存。现复用 Git 已有的磁盘 watcher（`fs.watch`），文件变动时：
  1. 面板激活时：合并防抖刷新（Git 侧 400ms + 前端 800ms 双重防抖，in-flight 守卫 + 队列兜底，避免 `npm install` 等批量变动叠加并发 IPC）。
  2. 面板未激活时：打上 `filesDirty` 脏标记，下次切回该面板时强制拉取最新树，不浪费 IPC。
  3. 刷新按钮同样接入合并逻辑，避免狂点触发并发扫描。

## [0.10.32] - 2026-10-20

### Fixed

- **文件预览（Monaco Editor）未跟随应用内主题**（`src/ui/shell/scripts/preview-monaco.ts`）：`themeName()` 原先只读取 `window.matchMedia("(prefers-color-scheme: dark)")`，若系统是浅色但应用手动切暗黑，Monaco 会保持亮白。改为优先读取 `theme-presenter` 投影到 `document.documentElement.style.colorScheme` 的值。
- **切换主题时编辑器不实时更新**（`src/ui/shell/scripts/theme-presenter.ts`、`preview-monaco.ts`）：`applyTheme` 应用快照后新增派发 `ck-theme-change` 自定义事件，Monaco 侧监听该事件并调用 `syncMonacoTheme()`，实现即时切换。

## [0.10.31] - 2026-10-20

### Fixed

- **手机端表格无法横向滚动**（`src/remote/pwa/style.css`）：`.msg.ai th, .msg.ai td` 继承了 `.msg.ai` 的 `overflow-wrap: anywhere`，长内容被压窄换行，表格永远不溢出，已有的 `.msg.ai table { overflow-x: auto }` 形同虚设。补 `white-space: nowrap`，表格保持内容原始宽度，横向滚动条才真正触发（与 ChatGPT / Claude 行为一致）。真机实测：表格 `scrollWidth 766 > clientWidth 348`，横滚生效。
- **手机端系统消息超长内容被静默裁切**（`src/remote/pwa/style.css`）：`.msg.sys` 只有 `max-width: 90%`，缺断词规则。长 URL / token / 错误堆栈会被 `.messages { overflow-x: hidden }` 直接裁掉，且无任何滚动条提示。补 `word-break: break-word` + `overflow-wrap: anywhere`，改为换行显示（系统消息是短文本，正确行为是换行而非滚动）。

### Changed

- **手机端滚动条美化**（`src/remote/pwa/style.css`）：
  1. 取消 `.messages` 的滚动条隐藏（`scrollbar-width: none` / `-ms-overflow-style: none` / `::-webkit-scrollbar { display: none }` 全部移除）。原实现与"表格 / 代码块靠滚动条表达还有内容"的视觉语言矛盾。
  2. 新增 Scrollbars 章节：4 个 token（`--sb-track` 透明 / `--sb-thumb` / `--sb-thumb-hover` / `--sb-thumb-active`）+ `--sb-size: 4px`；覆盖 `.messages` / `.msg.ai pre` / `.msg.ai table` / `.think-body` 四个滚动容器。
  3. 标准属性 `scrollbar-width: thin` + `scrollbar-color`（Firefox 全版本 / Chromium 121+）；WebKit 伪元素细滑块 + 透明轨道 + `border-radius: var(--radius-full)`。
  4. 三态：默认低透明度、hover 加深、active 用 accent。深色主题覆盖 thumb 为白色低透明度。
  5. 代码块单独处理：`pre` 永远是深底，滑块固定 `rgba(255,255,255,0.22)`，不跟随明暗主题（否则浅色主题下白底滑块看不清）。`::-webkit-scrollbar-corner` 设为 transparent，消除横纵交汇色块。
  6. `#input` 的无滚动条规则保留不动（textarea 不该有滚动条）。

  **已知限制**：iOS Safari 自 2021 年起忽略 `::-webkit-scrollbar` 样式，也不支持 `scrollbar-width` / `scrollbar-color`。iPhone 上仍是系统原生滚动条，本次样式不生效；Android Chrome / 桌面 Chromium / Firefox 生效。

  真机实测（Chromium 390x844）：`messages.scrollbarWidth=thin`、`scrollbarColor=rgba(20,23,28,0.2) rgba(0,0,0,0)`、`--sb-thumb-active=#0f9d78`；切深色后 `--sb-thumb=rgba(255,255,255,0.18)` 正常跟随。

## [0.10.30] - 2026-10-19

### Changed

- **hover 右侧导航改为平滑滚动**（`src/ui/harness.html`）：v0.10.29 的 hover 行为是瞬间跳到底。新增 `smoothScrollToBottom(el, dur)`（约 220ms cubic ease-out 缓动），正文与导航各自独立动画。用 `WeakMap` 按元素存 token，重复触发时旧动画自动作废，不会两个 rAF 循环抢写 `scrollTop`。触发前先中止可能在跑的 `settle` 重试循环（否则它会把 `scrollTop` 又拉回，与动画互相覆写）。页面隐藏时回退为瞬时到位（用户此时看不到，无影响）。

## [0.10.29] - 2026-10-19

### Fixed

- **右侧导航 hover 行为修正**（`src/ui/harness.html`）：v0.10.27 按"越权交互"判断删除了"hover 导航 → 正文滚底"的实现，但用户澄清这是**明确需求**（进入导航的意图就是看最新）。恢复该行为，但改用 `mouseenter`（进入导航时触发一次）替代原 `mouseover`（持续触发）——原实现的问题不是"滚到底"，而是用户在导航里用滚轮翻历史锚点时会被反复拽回底部。新实现：进入导航 → 正文与导航**同时**滚到底；进入后用滚轮翻历史不受影响；离开再进入会再次触发。

## [0.10.28] - 2026-10-19

### Fixed

- **v0.10.27 的 URL 版本化未闭环**（`src/remote/server.ts`）：`index.html` 的 ETag 原来只基于自身 mtime/size，而 `npm run compile` 用 `fs.cpSync` 复制 PWA 时会**保留源文件 mtime**（实测确认 `index.html` 编译前后 mtime 完全相同）。后果：只更新 `app.js` 时 `index.html` 的 ETag 不变 → 浏览器 304 → 继续引用旧的 `?v=` → 版本化形同虚设，CF/浏览器仍可能跑旧代码。

  修复：
  1. 新增 `etagForIndex(st)`，把 `app.js` / `style.css` / `marked.umd.js` 三个版本号拼进 `index.html` 的 ETag。任一资源变化 → ETag 变化 → 200 + 新 `?v=`。
  2. `versionizeHtml` 的正则放宽：支持单/双引号、可选前导斜杠，避免 HTML 写法变化后静默失效。
  3. 补回归测试：触碰 `app.js` 的 mtime 后，`index.html` 的 ETag 必须变化，且旧 ETag 不再命中 304。

## [0.10.27] - 2026-10-19

### Performance

- **远程同步对话渲染提速**（`src/remote/pwa/app.js`）：`renderHistory` 原实现逐条调 `addUser`/`addAi`/`addSystem`，每条都触发 `renderMd` + `decorateContent` + 两次全量 `querySelectorAll('.msg')` + `scroll(true)` 强制 reflow，O(n²)。实测服务端 `WS open → history` 仅 13ms，瓶颈全在客户端。改为拆出 `buildUserEl`/`buildSystemEl`/`buildAiEl`（只建元素不插 DOM），用 `DocumentFragment` 一次性插入，全量查询与滚动各只做一次。保序不变（`if (messages.querySelector('.msg')) return` 保护保留）。

### Fixed

- **发版后手机端仍跑旧代码（Cloudflare 边缘缓存）**（`src/remote/server.ts`）：CF 会把 `immutable` 资源缓存一年（`cf-cache-status: HIT` + `age` 数万秒），源站改 `Cache-Control` 对已缓存的边缘无效。改为 `serveStatic` 响应 `index.html` 时把 `/app.js` / `/style.css` / `/marked.umd.js` 的引用动态改写为 `?v=<mtimeMs>`；带 `?v=` 的请求走 `immutable`，不带 `?v=` 的沿用原策略。每次发版 mtime 变 → URL 变 → CF 和浏览器缓存自然失效。
- **右侧对话导航滚轮失效**（`src/ui/harness.html`，三个独立缺陷）：
  1. 删除 `mouseover` 监听——原实现鼠标进入导航就把正文强制滚到底，与"滚轮在导航上只该滚导航自己"直接冲突
  2. `.conv-nav-dot` 增加 `flex-shrink: 0`——否则条目一多，flex 容器在 `max-height:72%` 约束下把所有 dot 压扁，`scrollHeight == clientHeight` → 没有可滚动溢出，滚轮无处可去
  3. 导航内滚动时隐藏 tooltip（区分"正文 scroll"与"导航内 scroll"，后者需隐藏否则位置错位）
- **导航不跟随正文贴底**（`src/ui/harness.html`）：新增 `syncConvNavBottom()`，挂到 7 个贴底路径（`scrollBottom` 两个分支、`settleScrollBottom` 两个分支、`updateConvNav` 新锚点后、scroll 事件恢复贴底分支）。只单向同步（正文→导航），用户仍可单独在导航上滚轮查看历史锚点。

## [0.10.26] - 2026-10-19

### Reverted

- **整体回退到 v0.10.22 的远程实现**（`src/remote/`、`src/bridge/`）。v0.10.23 ~ v0.10.25 的远程优化（同步渲染批量提速、同步态动画、项目名显示、工具名显示、缓存分层、URL 版本化、隧道 `--protocol http2`）全部撤销。

  **原因**：真机实测确认瓶颈在**网络物理链路**，不在代码——本机直连应用层仅 2ms，隧道往返中位 533ms（506~1067ms 波动）。回退**不会让打开速度变快**（网络成本不变），但用户明确要求回退，按指令执行。

  **代价（知情记录）**：
  - 手机端同步等待回到约 2 秒（`renderHistory` 逐条渲染 O(n²)）
  - 手机端不再显示项目名、工具名、同步态动画
  - 发版后手机端可能长期跑旧代码（静态资源 `immutable` 强缓存 + Cloudflare 边缘缓存叠加）

  **后续如需重新引入**：应先在真实网络下 A/B 验证每一项，尤其是隧道协议选择（QUIC vs HTTP/2），不能仅凭本地测试下结论。

## [0.10.22] - 2026-10-19

### Added

- **远程静态资源缓存**（`src/remote/server.ts`）：PWA 静态资源响应加 `ETag`（`W/"<mtimeMs>-<size>"`）与 `If-None-Match` 304 处理；`index.html` 用 `Cache-Control: no-cache`（每次验证但命中 304 不传 body），`app.js`/`style.css`/`marked.umd.js` 用 `max-age=31536000, immutable`。二次打开从每次重下 ~116KB 降到几乎 0 字节。

### Changed

- **远程首页加载提速**（`src/remote/pwa/index.html`）：`marked.umd.js` 与 `app.js` 加 `defer`，首屏 HTML/CSS 不再等 46KB 的 marked 下载执行。
- **远程重连与同步提速**（`src/remote/pwa/app.js`、`src/remote/manager.ts`）：
  - history 拉取超时 2000ms → 800ms（harness 正常 100ms 内即回，本地实测 4ms）
  - 客户端"同步中"兜底 8000ms → 2500ms
  - 重连退避 `×1.6 / 上限 15s` → `×1.3 / 上限 8s`
  - 切回前台改为「主动发 ping + 1.5s 短超时等 pong」探活，取代原「只看时间阈值直接掐连接」的思路（避免手机切后台回来误杀健康连接）

### Fixed

- **手机端发送失败无提示**（`src/bridge/remote-bridge.ts`）：远程消息转发调用 `sendToChat` 时忽略返回值。`sendToChat` 可能返回 `false`（找不到输入框，或被停止信号的 `cancelPendingSend` 取消），此时手机端已乐观显示用户气泡、AI 却收不到，且无任何反馈。改为检查返回值，失败时上报系统提示。

### Removed

- **手机端远程传图**（`src/remote/pwa/*`、`src/remote/server.ts`、`src/remote/manager.ts`）：该功能实际使用频率极低，但链路极重（原图 base64 上限 8MB、CDP 探测点击最多 3 轮 × 2.5s、`waitComposerReady` 最长 12s 轮询），且存在「上传未完成即可发文本」的竞态缺陷。移除后 WS 单条消息上限从 12MB 降到 2MB。桌面端纯净模式本地传图（`src/app/ipc/cdp-attach.ts`）保留不受影响。

## [0.10.21] - 2026-10-18

### Fixed

- **重发 v0.10.20 以修正版本号污染**：v0.10.20 的 tag 曾在发布后被移动到新提交（挪 tag 而非发新版本），导致同版本号存在两份内容不同的安装包——早下载的用户装到的是不含 083 停止修复的旧构建，且因版本号相同无法收到自动更新。本次以 v0.10.21 重新发布，内容与当前 master 一致（含 083 停止生成修复 + CHANGELOG 补全 + harness 注释精简）。**v0.10.20 不再维护，请升级到 v0.10.21。**

## [0.10.20] - 2026-10-18

### Changed

- **新对话初始化提速**（`src/app/ipc/shell.ts`）：原实现 `did-finish-load` 后固定等 400ms 再走 `initProject`（等首屏渲染稳定）。但 DeepSeek 首页输入框通常在 100~300ms 内就出现，白等 100-300ms。改为轮询检测 `textarea`（每 100ms，最多 1.5 秒），出现即走初始化。实测本地代码耗时从 ~450ms 降到 ~51ms。
- **截断重发激活提速**（`src/app/ipc/harness.ts`）：`activateShareSession` 原实现首轮就 `await 800ms`（分享页可能早已就绪），且轮询粒度 800ms 太粗（变活平均等 2-3 秒）。改为首轮立即检查 + 之后 300ms 一轮，上限从 15 轮提到 40 轮（总时长仍约 12 秒）。
- **IDB 重建轮询提速**（`src/session/compaction.ts`）：`waitForIdbMessages` 轮询间隔 200ms → 150ms。
- **压缩后初始化提速**（`src/session/compaction.ts`）：`checkPendingInit` 原实现固定等 3 秒（等分享页渲染稳定），但实测分享页渲染通常 <1 秒。改为轮询检测输入框就绪（每 200ms，最多 3 秒）。实测省 2.4 秒。

### Fixed

- **停止生成「假成功」**（严重，`src/app/ipc/harness.ts`）：`stopGeneration` 原实现只要定位到按钮坐标就返回 `success: true`，不校验是否真的停住。手机端据此显示「已停止」，实际 AI 仍在跑。修复：点击后等 400ms 重新定位校验，失败重试一次，仍失败返回 `still-generating`，手机端走「停止未生效」提示。
- **空闲时点停止会误发消息**（严重，`src/providers/deepseek.ts`）：DeepSeek 输入区主按钮是同一个元素——生成中显示方块图标（可停止），空闲时显示箭头图标（= 发送按钮）。原通用定位逻辑按类名选中就点，空闲时等于**替用户把输入框内容发了出去**。修复：新增 `getStopFn()`，按 SVG path 区分（方块 `M2 4.88` / 箭头 `M8.3125`），空闲态直接返回 `generating: false` 不点击。
- **CDP 点击停不住 DeepSeek 的流**（`src/app/ipc/harness.ts`）：真机取证发现 `Input.dispatchMouseEvent` 点击后按钮图标变回箭头，但 AI 流仍在继续（8 秒 +59 帧）。改用**页面内合成 PointerEvent 序列**（实测 8 秒仅 +4 帧）才真正停流。
- **通用停止定位回退路径被误判失败**（`src/app/ipc/harness.ts`）：`attachStopFn` 返回值不含 `generating` 字段，最初校验条件 `again.generating === false` 永远为假，会把其它能正常停止的平台误判为 `still-generating`。已按定位函数是否具备 generating 语义分流校验。
- **移除 `attachStopFn` 的页面内合成点击**：同一次停止被点两下会干扰按钮状态判断，改为只返回坐标。
- **压缩摘要被过度截断**（`src/session/compaction.ts`）：`MAX_SUMMARY_LEN` 从 3000 提到 5000。
  - **历史误判纠正**：曾因"44246 长度提示词被 DeepSeek 拒绝"把上限压到 3000，但真机复查发现那次拒绝是**高频请求限流**（3 秒内连发 3 次），与长度无关——47175 长度（含 3000 摘要）多次成功发送，32432 长度在限流时同样报错。
  - 3000 的代价：实测长会话生成 5757 字摘要被砍到 3002（**丢 47.9% 信息**），导致续接会话丢失前情。改为 5000 后，常态摘要（实测 3540 字）完整保留，仅极端长会话（5757）才裁掉 757 字。
  - 安全性：基础提示词 44100 + 5000 摘要 = 49100，仅超实测成功线（47175）2000，风险可控（8000 会到 52100，超 5000 且未验证，故不采用）。
- **新增压缩摘要总长度动态保护**（`src/session/compaction.ts`）：`checkPendingInit` 里若 `基础提示词估算(44100) + 摘要长度 > 49500`，自动按剩余空间缩减摘要（至少保留 2000 字），防止未来项目文件膨胀导致总长超限。

## [0.10.19] - 2026-10-18

### Fixed

- **截断重发时同一消息被重复发送 3~4 次**（严重）：`activateShareSession` 每 800ms 一轮、最多 6 轮，每轮只要分享页 textarea 就绪就发 `harness-user-message`。分享页克隆成活会话需 2~3 秒，循环在变活前已发送 3~4 次 → 用户导航栏出现多个相同消息。修复：加 `sent` 标志只发一次；轮次上限 6→15，之后仅轮询 URL 等变活。
- **AI 生成中切到其他窗口再切回，不自动滚到底部**（严重）：`stream` 的 `scroll` 事件无条件 `pinBottom = isNearBottom()`。流式输出使 `scrollHeight` 持续增长 → 浏览器派发 scroll 事件（`scrollTop` 未变）→ 距底变远 → `pinBottom` 被自己踩成 false → 切回时 `if (pinBottom)` 不成立、不滚底。修复：记录 `_lastScrollTop`，仅当 `scrollTop` 变小（用户真的上滚）才置 false；内容增长导致的被动 scroll 保留原状态。
- **点右侧导航条目跳转失效**：`settleScrollBottom` 的后续 `step()` 会把 `scrollTop` 又拉回底部，覆盖 `fastScrollTo`。修复：`fastScrollTo` 开头先中止 settle（`_settleGen++` + 清 timer/listener + `resetExpectVars()`）。
- **点导航完全无反应（隐藏页面）**：`document.hidden` 时 rAF 被浏览器挂起，`fastScrollTo` 动画永不执行。修复：`hidden` 时直接 `scrollTop = target`。
- **删除 / 保存修改后不滚到底部**：补 `pinBottom = true; settleScrollBottom(true);`。
- **隐藏页面下 `scrollBottom` 死锁**（严重）：`_scrollRaf` 是"本帧已排"的合并标记，页面 `document.hidden` 时 rAF 被浏览器挂起、永不回调 → `_scrollRaf` 永不为 null → 后续所有 `scrollBottom` 调用全部 return，流式滚底彻底失效。修复：`hidden` 时直接同步写 `scrollTop`，跳过合并/动画。
- **隐藏页面下 `resize` 的 `suppressPin` 永久卡住**（严重）：同样因 rAF 挂起，`suppressPin = true` 后永不复位 → 之后所有 `scroll` 事件被短路、`pinBottom` 再也不更新。修复：`hidden` 时同步完成，不设 `suppressPin`。
- **隐藏页面下导航 active 高亮不更新**：`scheduleConvNavActive` 用 rAF 节流，`hidden` 时不触发。修复：`hidden` 时降级到 `setTimeout`（100ms）。
- **`_lastScrollTop` 声明位置修正**：原声明在 scroll 事件监听处（`:4851`），但 `scrollBottom`（`:2733`）内部也引用它，若在初始化期间先调用 `scrollBottom` 会读到 `undefined` 导致比较异常。已提到 `pinBottom` 声明旁（`:2747` 附近）。

### Changed

- **移除「仅保存 / 保存修改」按钮**：该按钮只改 DOM + localStorage，**AI 服务端上下文完全不变**——用户改了 AI 也不知道，下次引用历史仍是原文，无实际意义。移除后历史消息编辑只保留「取消 / 填入输入框 / 从此处截断重发」；最后一条已完成消息保留「取消 / 从此处截断重发」；待发送消息保留「取消 / 重新发送」。`Ctrl+Enter` 在历史消息上改为触发截断重发（原为 `doSaveOnly`）。

### Added

- **hover 右侧对话导航自动滚到底部**：`mouseover` 检测到进入 `.conv-nav` 区域即 `settleScrollBottom(true)`，展示最新消息。导航面板是 fixed 定位，不随内容滚动，hover 滚底不影响后续点选历史锚点。

## [0.10.18] - 2026-10-18

### Fixed

- **截断重发后资源管理器显示"未选择"**：截断会激活出**新 sid**，但流程没把当前项目目录绑到新会话 → `handleUrlChange` 里 `getProjectDirBySessionId(newSid)` 返回空 → `selectedProjectDir = null`。修复：`harness-truncate` 记住当前目录（内存局部变量），`activateShareSession` 检测到变活后显式 `saveSessionDirMapping(newSid, projectDir)` 并广播 `shell-project-dir` 事件。
  - 踩坑记录：曾尝试用 `state.pendingProjectDir` 兜底，但截断流程中途会**刷新页面重建 IDB**，刷新后 URL 仍是原会话 → `pendingProjectDir` 被消费并绑到**旧 sid**，等变活成新 sid 时已空。必须显式绑定。
- **最后一轮已完成的消息编辑缺少"从此处截断重发"**：原 `isLatestUserMessage` 只判断"后面有无更晚的 user"，导致最后一轮已完成（有 assistant 回复）的消息也只能"仅保存/重新发送"。语义上改这一轮等价于"改历史分支"，应允许截断重开。
  - 修复：`editUserMessage` 增加 `hasRepliedAfter` 判定（最后一条 user 后面是否已有 assistant），三态区分：
    - 历史中间消息（有更晚 user）→ 取消 / 填入输入框 / 从此处截断重发 / 保存修改
    - 最后一轮已完成（有 assistant 回复）→ 取消 / 仅保存 / 从此处截断重发
    - 真正待发送（刚发出未回复）→ 取消 / 仅保存 / 重新发送

### Added

- 新增测试：历史消息编辑三态按钮组（中间/已完成末轮/待发送）

## [0.10.17] - 2026-10-18

### Fixed

- **会话切换后纯净模式历史不加载**（严重）：`notifyHarnessSession` 与 `harness-ready` 补发时仅用 `ctx.providerId` 取 provider，该字段未设置时 `sid` 恒为空，导致 harness 永远拿不到当前会话、历史一片空白。已补 `getProviderByUrl(url)` 兜底。
- **子代理 maxTurns 达到后不真正停止**：原实现只上报 `partial` 而不阻断后续流程，实测 `maxTurns=1` 仍跑 3 轮才结束。现加 `stopped` 标志 + `cancelPendingSend` + `requestAbort`，日志验证触发后立即中止。
- **纯净模式滚底 `suppressPin` 永久卡住**：页面 `document.hidden` 时 rAF 被浏览器挂起，`settleScrollBottom` 的多帧循环永不推进，`suppressPin` 长置 true。改为 `hidden` 时一次性完成（`scrollTop = scrollHeight`），不进入多帧循环。
- **右侧对话导航 hover 强制滚底**（反 UX）：原实现 hover 右侧导航立刻 `scrollBottom(true)`，用户根本点不到想跳的历史消息。已移除该行为，hover 保持原位置。
- **压缩丢 `projectDir`**：`triggerCompaction` 取 overlay 内存 `state.currentProjectDir`，刷新/导航后为空 → 压缩段3 `initProject` 拿不到目录。改为主进程 `sessionStore.state.selectedProjectDir` 直传给 bridge，再由 bridge 传给 `triggerCompaction`。
- **压缩摘要超长被服务端拒**：`MAX_SUMMARY_LEN` 8000 → 3000。基础提示词约 40.5k 字符，加上 8000 字摘要即触碰 DeepSeek 拒绝边界。
- **压缩段3 过早清 localStorage**：`checkPendingInit` 读到 pending 立即 removeItem，若 `initProject` 失败则摘要/目录永久丢失无法重试。改为 initProject 成功回执后再清。
- **截断重发迟到回执被丢弃**：长历史下快路径可能 >60s 超时，此时回执到达因 `truncatePending` 已空被静默丢弃。已加 `truncateLateHandler`，超时后仍能完成导航+激活；同时超时 60s → 120s。
- **截断重发慢**：`activateShareSession` 原用 `waitForLoad(15000)`，但 `loadURL` 已 await 完成，did-finish-load 事件早已过去 → 白等 15 秒。改为 6 次 × 800ms 轮询检查 textarea 就绪，激活成功耗时从 17s 降至 ~5s。
- **历史消息"保存修改"缺失**：历史消息编辑栏只有"取消/填入输入框/从此处截断重发"，用户只想改错别字保存无从下手。新增"保存修改"按钮（`doSaveOnly`），更新 DOM + `histItem.text` + `saveHistory`。
- **截断重发本地降级**：无 `webMsgId`（纯净模式首条 / 无网页记录）时原实现直接 `cancel()` 丢弃用户输入。改为回退本地物理截断：`truncateUserMessage` 清历史 → 新文本入输入框 → `send()`。
- **目标迭代始终显示 0**：`round` 语义为"自动续跑次数"，AI 靠工具循环跑完不触发 nudge → 恒定 0。改为"当前第 N 轮"语义，起始 1，`renderGoalMeta` 兜底 `Math.max(1, ...)`。
- **空白气泡/空 pre 残留**：流式渲染剥离工具块后 `renderMarkdown('')` 产生 `<pre><code></code></pre>`，深色主题下呈空黑框。新增 `removeEmptyPres` 在流式/收尾/历史恢复三处清理；无正文时隐藏 body 容器。
- **删除工作区 localStorage 缓存残留**：删除工作区只清主进程账本，harness 的 history/goal/plan 缓存永久驻留。`deleteProjectWorkspace` 现返回被删 sessionId 列表，UI 侧逐个清理三 key。
- **会话标题更新后侧栏不刷新**：`set-session-title` 处理完未广播 `shell-sessions-changed`，跨视图联动存在盲区。

### Added

- **子代理 partial 上报**：达 `maxTurns` 截断时主对话收到 `[子代理达到轮次上限，以下为部分结果]` 前缀，避免把半截当完整结论。
- **远程 PWA 同步过渡态**：连接建立但历史尚未到达时显示"正在同步对话…"，8 秒兜底解除，避免用户误以为卡在首页。
- **远程空 history 回执**：harness 未创建 / 导出超时 / 无可用窗口时也回一条空 `history`，客户端立即解除同步态。
- **远程用户消息入历史**：`case 'user'` 原仅 `addUser` 渲染 DOM 未 `pushHist`，手机重连补发历史时看不到自己发过的话。已补 `pushHist` 并传 `histItem` 供删除/编辑引用。
- **工作区信任门**：新建对话到含 `.agents` 工件的目录时弹三按钮确认框（信任并启用 / 仅本次会话 / 不信任）；`harness-ready` 路径对已信任目录短路不弹。未信任时项目级 MCP / 规则 / 技能 / 子代理均不注入。
- **目录信息增强**：`getDirInfo` 现返回 `createdAt` + `source`（session/dir），优先取该目录下最早会话的 `createdAt`，老数据回落磁盘 `birthtime`。
- **工具计数泄漏自愈**：`scheduleGoalNudge` 遇忙不再直接丢弃，改为指数退避重试（上限 12 次）；`onTaskIdle` 遇 `toolRunningCount > 0` 也调度续跑兜底。
- **历史恢复未收尾工具落终态**：`success === null` 的工具卡片渲染为"上次会话中断，工具未执行完成"，不再是永久"运行中"。
- **自动滚底（081）**：切回窗口时若在底部附近且内容变高则平滑滚底；离开时在翻历史则不动。新增 `src/bridge/scroll-follow.ts`（含 `shouldFollowToBottom` 纯函数便于单测）。

## [0.10.16] - 2026-10-18

### Fixed

- **纠正 v0.10.15 的严重误杀**：v0.10.15 中错误地加入了 `stopBySource('ai')`，导致用户点停止时，会把正在运行的 `npm run dev` 后台任务也杀掉。本版本已彻底移除该逻辑，明确边界：**只杀阻塞当前对话的前台进程，保留有独立生命周期的后台任务。**

## [0.10.15] - 2026-10-18

### Changed

- **停止/发消息时，彻底清理所有相关后台任务**：
  - `abortWindowWork` 中增加了 `stopBySource('ai')`。这意味着，当你点击停止或发送新消息时，AI 之前通过 `bash background:true` 拉起的后台长驻任务（如 dev server、watch 等）也会被全部强制终止。

## [0.10.14] - 2026-10-18

### Fixed

- **纠正 v0.10.13 的遗漏**：v0.10.13 虽然实现了 `process-tracker`，但在给 `harness-send`（发送新消息）添加前置强杀逻辑时，因正则匹配失败导致代码未落地。本版本已补全：发送新消息时会调用 `abortWindowWork(ctx)` 强杀上一轮的 bash/pwsh/grep 等残留进程。

## [0.10.13] - 2026-10-18

### Fixed

- **彻底修复“停止”和“发新消息”时工具进程未中断**：
  - 新增 `src/infra/process-tracker.ts` 全局追踪主进程 spawn 出来的系统进程（bash/cmd、pwsh、rg）。
  - `harness-stop` 时调用 `abortWindowWork`，强杀属于该窗口的 bash/pwsh/grep 等进程树，同时杀 JS worker。
  - **发送新消息时**，也会先触发 `abortWindowWork`，强制结束上一轮还在后台跑的残余任务，防止并行冲突。
  - 统一了 Unix 下的进程组强杀逻辑（复用 `killProcessTree`，防止孙进程孤儿化）；修复了窗口销毁时的全局误杀问题。
  - `grep.ts` 增加 abort 标志，避免超时被强杀后重复抛出无用错误。

## [0.10.12] - 2026-10-18

### Fixed

- **纠正 v0.10.11 的回归**：v0.10.11 在 `killWorker` 和 `child.on('exit')` 中误清了 `activeWorkerPid`，破坏了 `JsRunner.Process.test.js` 的探活断言（`activeWorkerPid` 的语义是"最近一次 run 的 pid"，用于测试和诊断，不应在结束时清空）。本版本恢复该字段的保留语义。

### Note

- v0.10.11 已推送但测试未通过（1 例失败），请使用 v0.10.12。

## [0.10.11] - 2026-10-18

### Fixed

- **点击停止后工具仍在后台执行**：
  - `JsRunner` 新增 `abortAll(windowId)`：在 Windows 下通过异步 `taskkill /T /F` 强杀 worker 进程树（解决 `require` 未定义、`execSync` 阻塞主进程、并发互相覆盖、全局误杀等问题）。
  - `harness.ts` 的 `stopGeneration` 中主动调用 `abortAll`，并在顶部静态 import 消除 ESM 混用隐患。
  - `grep.ts` 的 `runRipgrep` 增加 60 秒兜底超时，防止 rg 卡死导致主进程假死。
  - `harness.ts` 补全 `loadURL` 的 `.catch`，避免未捕获的 Promise 拒绝。

## [0.10.10] - 2026-10-18

### Fixed

- **点击停止后工具卡片卡在“运行中”**（`src/ui/harness.html`）：`stop()` 函数此前只重置了 `toolRunningCount` 和清理了助手气泡，但没处理已经渲染在 DOM 里的工具卡片。导致点击停止后卡片永远显示“运行中”。
- 修复：`stop()` 中增加遍历 `.tool-badge.run`，将其改为“已停止”并显示“（用户手动中止）”，卡片自动折叠。

## [0.10.9] - 2026-10-18

### Fixed

- **思考字数统计不准**（`src/ui/harness.html`）：原使用 `think.length` 统计，英文按字母算、符号和空白也计数，导致纯英文的 15 个单词显示成 78 字。新增 `countThinkChars()`：中文按汉字数、英文/数字按单词数统计，忽略标点和空白。

## [0.10.8] - 2026-10-17

### Added

- **右侧对话导航新增悬停交互**（`src/ui/harness.html`）：鼠标悬停在右侧导航区域时，自动强制滚动到对话最底部，方便快速查看最新消息。使用 `mouseover` 事件代理，避免导航内部移动时重复触发。

## [0.10.7] - 2026-10-17

### Performance

- **修复"任务页切 tab 卡顿"**（`src/ui/shell/scripts/pages/tasks.ts`）：原每次切回都会重走 `taskList` + `taskReadScripts`（读 package.json 解析）+ 全量重建脚本按钮 DOM 并逐个 addEventListener。现新增 `loadTasks({ force })` + `tasksLoaded` 标志，切 tab 直接跳过；任务变更事件 / 启动 / 停止 / 移除 / 刷新 / 清空走 `force: true`。

### Fixed

- **Git 页缓存判断缺陷**（`src/ui/shell/scripts/pages/git.ts`）：原用 `lastItems.length > 0` 判断缓存，项目无改动时 `lastItems` 为空，会漏掉缓存直接重走 IPC。改用独立 `gitLoaded` 标志位，覆盖"无改动"场景。

### Verified

- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移

## [0.10.6] - 2026-10-17

### Fixed

- **修复 CI 的 Coverage 工作流失败**：
  - `.github/workflows/coverage.yml`：在跑测试前增加 `npm run compile`。原流程直接跑测试，导致 `JsRunner.WorkerPath.test.js` 找不到 `out/` 编译产物（`ERR_MODULE_NOT_FOUND`）。
  - `src/remote/tunnel.ts`：`buildCloudflaredCandidates` 构造 Windows 路径改用 `path.win32.join`。原用 `path.join`，在 Linux CI 环境下拼接出混用正反斜杠的路径，导致 `cloudflared-path.test.js` 断言失败。

## [0.10.5] - 2026-10-17

### Performance

- **修复"Git / 对话列表"页切 tab 卡顿**（`src/ui/shell/scripts/pages/git.ts` + `conversations.ts`）：
  - **Git 页**：原每次切回都会重新走 `gitStatus` IPC 拉取改动并重建列表 DOM。现新增 `loadGit({ force })`，默认走缓存直接渲染（`lastItems`），只有 watcher 变更、项目切换、手动操作才 `force: true` 拉取。
  - **对话列表页**：原每次切回都会跨进程扫描 AI 网页 DOM 取会话列表。现新增 `force` 参数，非强制且已有列表节点时跳过 IPC，仅刷新禁用态。导航/新建/刷新仍强制拉取。

### Fixed

- **修正 v0.10.4 的发布记录**：v0.10.4 仅包含版本号与 CHANGELOG 的变更（实际修复未落地，脚本报错导致编辑丢失）。真正的修复在 v0.10.5 中。

### Verified

- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移

## [0.10.4] - 2026-10-17

> ⚠️ 本版本为空版本（仅版本号与 CHANGELOG 变更，Git / 对话页性能修复未落地）。请使用 v0.10.5。

## [0.10.3] - 2026-10-17

### Performance

- **修复"任务菜单切到源代码菜单卡顿"**（`src/ui/shell/scripts/pages/files.ts` + `preview.ts`）：
  - **切 tab 复用缓存**：原每次切回「文件」都重新走 IPC 扫描整个项目目录树；现缓存命中直接渲染，只有刷新按钮 / 增删改 / 项目切换才强制拉取（`loadFiles({ force: true })`）。
  - **目录展开/折叠不拉 IPC**：原每次点击目录都会重新扫描整棵树；现只重渲染缓存（展开状态本来就在内存里）。
  - **预览恢复不重读文件**：新增 `showPreviewLayout()`，切回「文件」只恢复显隐与宽度，文件内容一直在编辑器里（`restorePreview` 改调它）。
  - **大项目分帧渲染**：节点数 > 300 时先插入"加载中…"占位，`requestAnimationFrame` 再真正渲染，避免一次性重建数千 DOM 阻塞主线程。

### Changed

- **默认暗色首帧**（`src/ui/shell/index.html`）：新增 `<meta name="color-scheme" content="dark light">` 与 `<body data-ck-dark>`，首帧直接暗色渲染，避免"先白屏再变暗"的闪烁；原生控件（select 下拉、滚动条）跟随暗色。

### Verified

- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移

## [0.10.2] - 2026-10-17

### Changed

- **更新弹窗改回系统原生对话框**：需求 077 曾把更新确认从 `dialog.showMessageBox` 改为自绘浮窗（品牌头/版本跃迁/日志列表/实时进度条），但需求 068 已明确划定边界——**模态决策对话框保持系统原生，自绘仅用于被动通知**。本次回退到原生（屏幕中央、跟随父窗口），符合 068 原始设计：
  - `update-available`（发现新版本）、`update-downloaded`（更新已就绪）、`checkForUpdates`（已下载待安装）、`showUpdateErrorDialog`（更新失败重试）四处全部恢复原生对话框
  - 下载进度仍由**壳页面状态栏**实时展示，弹窗内不再渲染进度条
  - 新增 `showNativeDialog()` 统一封装（含 macOS 必须传 parent 的处理）

### Performance

- **安装包体积从 344.61 MB 降至 182.04 MB（-47%，省 162.57 MB）**：
  - `!node_modules/monaco-editor/**`（97.09 MB）：monaco 只通过 `src/ui/vendor/monaco/vs`（AMD loader 加载）使用，npm 包本体从未被 `require`（grep `out/src` 零引用）。
  - `!out/src/ui/vendor/monaco/**`（54.89 MB）：**死代码**。无任何构建脚本生成、无任何代码/HTML 引用（`findstr` 全仓零命中），且与 `src/ui/vendor/monaco` 内容 hash 不同（旧残留）。`src/ui/vendor/monaco`（24.38 MB，139 个文件）完整保留，是 shell.html `vendor/monaco/vs/loader.js` 的实际来源。
  - `!out/**/*.map`（27.78 MB）+ `!node_modules/**/*.map`（6.13 MB）：sourcemap 仅调试用，运行时不需要。
  - `!node_modules/**/*.ts|mts|cts`（3.71 MB）：第三方包的 TypeScript 源码，运行时只用编译后的 .js。

### Removed

- **删除自绘确认框遗留三件套**（回退原生后无调用方）：`src/app/confirm-window.ts`、`src/app/confirm-preload.ts`、`src/ui/confirm-window.html`（约 32 KB）
- **删除 `src/updater/index.ts` 中 4 个死函数**：`escapeHtml`、`htmlToText`、`extractReleaseNotes`、`formatSize`（原本仅供自绘弹窗渲染版本号/更新日志/体积）

### Verified

- asar 关键运行时资源逐项核对：monaco loader/editor.main/editor.worker、marked.umd.js、cuckoo-sanitize.js、shell/harness.html、entry.js、js-sandbox-worker.mjs、prompt md、assets/icon.png、katex 62 个、notif-images 27 个、enhance-images 9 个、remote/pwa 6 个、resources/runtime 16 个 —— **全部保留**。
- 打包版实测启动：platform-select / shell / harness 页面均从 `app.asar` 正常加载，CDP 可访问。
- typecheck 0 / vitest 128 文件 1190 用例全过 / lint 0 error / compile 无漂移。

## [0.10.1] - 2026-10-17

### Fixed

- **打包版 AI 执行 JS 代码块 100% 失败（v0.10.0 阻塞级回归）**：A-005 把 JsRunner 迁到 `child_process.fork` 独立进程后，worker 脚本 `js-sandbox-worker.mjs` 被打进 `app.asar`。但 fork 启动的是**原生 OS 进程**，操作系统不认识 asar 虚拟路径（不透明映射仅 Electron 内建模块享有），实测直接 `MODULE_NOT_FOUND` 崩溃。修复：① `build.asarUnpack` 增补 `**/js-sandbox-worker.mjs`，打包时解到 `app.asar.unpacked/`；② `JsRunner` 新增 `resolveWorkerPath()`，fork 前把路径中的 `app.asar/` 映射到 `app.asar.unpacked/`；③ 新增 6 例回归测试锁定（Windows/POSIX 路径、开发态原样、幂等、空输入、非目录段不误伤）。实测：unpacked 路径 fork 成功存活，asar 内路径 `exists=false` 崩溃。
- **安装包瘦身（v0.10.0 遗漏）**：`build.files` 补排除 `.archify`/`.codegraph`/`.cuckoo`/`.cuckooCode`/`eslint-rules`/`examples`/`release-notes`/`templates`/`wyp` 与 `src/**/*.ts`（源码 + 代码图谱 DB 11 MB + 截图日志 12.7 MB 不再进包）。`app.asar` 从 352.49 MB 降到 343.28 MB。

## [0.10.0] - 2026-10-17

本版本是一次**全量安全加固**（分支 `fix/security-bug-sweep`）。对全项目做了只读安全审计（5 路分片 + 独立复核），确认 **59 条 bug（P0 致命 4 / P1 高危 15 / P2 中危 17 / P3 低危 23）全部修复或逐条给出不改结论**，并复核了 17 条置信度不足的推测项。审计证据见 `docs/audit/`。新增 150+ 条回归测试，全部 PoC 复跑确认。

### Security

- **X-001（P0，跨模块）修复"任意网页可零确认执行命令"**：AI 工具执行通道此前不校验调用来源。建立三层防线——① 主进程 IPC 对 `execute-tool` / `execute-js` / `execute-command` 等执行面做 **host 白名单 + sender 校验**（仅 registry 注册的 provider 域名与自有窗口可调用，`src/app/ipc-guard.ts`）；② 高危投递特征族（PowerShell `-enc`、`iex`、`curl|iex`、`certutil`、`bitsadmin`、写启动项、反弹 shell 等）在**任何执行模式下都于主进程弹确认**，确认框默认聚焦"取消"（`src/infra/dangerous-commands.ts`）；③ 设置页新增**三档执行策略**（智能 / 工作区信任 / 严格，见下）。
- **A-001（P0）webFetch SSRF 302 重定向往内网**：改为手动逐跳重定向，每一跳都重新过 SSRF 守卫，落到内网/回环/云元数据即 fail-closed，不再盲跟 `Location`（`src/tools/impl/WebFetchTool.ts`）。
- **A-002（P0）SSRF IPv6 / 进制写法绕过**：`http://[::ffff:7f00:1]`、`0x7f000001`、十进制整数、尾点等写法经 WHATWG URL 归一化后按解析结果判定，IPv4-mapped IPv6 十六进制不再直穿（`src/infra/ssrf-guard.ts`）。
- **A-003（P1）主机名大小写 / 尾点绕过**：host 判定统一小写归一化并处理尾点。
- **E-001（P0）MCP 面板 server 名 DOM XSS → executeJs → RCE**：项目 `.agents/mcp.json` 的 server 名未转义拼进 innerHTML，克隆恶意仓库即可植入。内容位与属性位统一转义（`src/overlay/panels/mcp-manager.ts`）。
- **E-002（P1）harness 渲染 AI 回复 marked 无消毒**：新增**零依赖单一真源白名单 sanitizer** `src/overlay/sanitizer.ts`，构建产物 `src/ui/vendor/cuckoo-sanitize.js`；harness 渲染管线在 `marked.parse` 之后、KaTeX 恢复之前做 sanitize（保留 class/aria-*/data-*），shell 与 overlay 共享同一真源。`<img onerror>`、`<script>`、`javascript:` 链接等一律清除。
- **E-003（P1）窗口管理面板 profile 名 / 平台名 / id 注入**：内容位与属性位统一转义。
- **E-009（P3）自有窗口补 CSP**：harness / shell / alert / confirm / notification / platform-select 加 CSP meta（`object-src/base-uri/frame-src` 收紧；shell 因插件 `new Function` 与 Monaco worker 额外放行 `unsafe-eval`、`worker-src blob:`）。
- **D-001（P1）插件市场点"安装"即主进程 RCE**：① 安装前在主进程弹第三方代码风险确认框（默认聚焦"取消"）；② **安装后默认禁用**（`setCuckooPluginEnabled(id,false)`），需用户手动启用；③ 新增 npm 包名规范白名单（拒绝 URL / git / file: / tarball / 参数 / 路径穿越），触达 npm 前拦截。
- **D-002 + D-004（P1）新增"工作区信任门"**：选择项目目录后，若发现 `.agents/mcp.json`、`.agents/rules`、`.agents/skills` 或 `.cuckoo/agents` 等工件，弹一次信任确认（默认聚焦"不信任"）。**不信任时项目级 MCP server 不 spawn、项目级规则 / 技能 / 子代理不注入系统提示词、`runAgent` 无法实例化项目级代理**；信任记录以原子写存于 `~/.cuckoo/trusted-workspaces.json`（支持本次会话 / 持久 / 撤销）；用户级 MCP / 规则 / 技能 / 代理不受影响。数据层扫描兜底，覆盖所有注入入口（含 JsRunner 按路径注入、cuckoo-host、harness 列举、project list/refresh、runAgent）。
- **D-003（P1）MCP HTTP server SSRF**：建立 `StreamableHTTPClientTransport` 前先 `assertUrlAllowed`，项目级内网 MCP URL 同样受约束；stdio 不受影响。
- **D-005（P2）远程服务 WS token 经 URL query 泄漏**：WebSocket 改走 `Sec-WebSocket-Protocol: cuckoo.<token>` 握手，手机端 PWA 预检/重连改用 `Authorization` 头（query 保留过渡兼容）。
- **D-006（P2）token 比较改常量时间**：`crypto.timingSafeEqual`（等长前置判断）。
- **D-007（P2）插件市场镜像源投毒**：curated 源结构化标注 provenance（官方 raw 优先；jsdelivr/ghproxy 等第三方镜像显式标注），缓存记录服务来源。
- **D-008（P2）下载重定向跟随**：Gitee 抓取改手动逐跳重定向（≤5 跳），每跳 Location 必须在 github/raw/codeload/objects/gitee 白名单。
- **D-010（P3）zip 解压路径穿越**：`safeEntryFilter` 增补 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名）逐段校验；符号链接/硬链接/绝对路径/`../` 穿越继续拦截。
- **E-008（P3）运行时下载无完整性校验**：`fetch-runtime` 下载 Node/uv 资产后做 sha256 校验（hash 取自官方 nodejs.org 与 astral-sh 校验文件），不匹配即删除并 fail-closed。
- **C-001/C-002/C-003（P1）存储非原子写可致数据静默丢失**：会话映射、profile、窗口分组等 8 处直接 `writeFileSync` 统一切到原子写（临时文件 + rename）+ 损坏时回退（`src/infra/atomic-json.ts`）。
- **A-006（P2）命令超时只杀 shell、孙进程孤儿化**：新增 `runCaptured` + 进程树回收（`taskkill /T /F` 树杀），并加 pid 探活；`bash`/`pwsh` 工具超时后连带杀死孙进程。
- **A-012（P3）命令里的密码明文进日志**：连接串 / `-p` 密码等做打码。
- **A-015（P3）todo 列表跨项目串桶**：按项目目录分桶存储。
- **A-S-1 / C-S-001 等推测项加固**：Node vm 沙箱隔离（见 A-005）、执行面 sender 系统性校验（见 X-001）。

### Added

- **设置页新增"安全·执行策略"与"受信任的工作区"两个卡片**：三档策略——**智能（默认，保持自动体验，仅高危投递特征弹确认）/ 工作区信任（按项目信任放行自动执行）/ 严格（每次执行都问）**；受信任工作区可查看与一键撤销。
- **A-005（P1）JsRunner 迁出主进程到独立 OS 进程**：AI 脚本改用 `child_process.fork` 在独立 worker（`src/tools/runtime/js-sandbox-worker.mjs`）的 vm 中执行，**异步微任务死循环不再饿死主进程**——主进程看门狗到点直接 `SIGKILL` worker 进程（PoC 实测：异步死循环 ~2.4s 返回超时、worker pid 探活 ESRCH 真死、主事件循环全程响应；同步死循环由 vm timeout 处理）。工具仍在主进程执行（worker 经 IPC 桥接），`currentWindowId`/项目目录/设置/长任务看门狗暂停语义全部保留；对外 `run()` 签名不变。
- **webFetch 内网守卫默认更严**：重定向、IPv6、进制写法全部归一化判定（见 A-001~A-003）。
- **Ctrl+N / Ctrl+Shift+N 快捷键新开对话**：Ctrl+N 新开对话，Ctrl+Shift+N 弹目录框选项目后新开对话。菜单 accelerator 在原生视图聚焦时不触发，故在 harness / AI 页面 `before-input-event` 双重拦截转给壳页面（`src/app/entry.ts`）。
- **左上角项目选择器改为"选目录 → 新开对话"**：不再在当前对话里改绑项目。新增 IPC `pick-dir-and-new-conversation`（带 `assertSenderOk` 来源校验），选目录期间显示 loading 遮罩，取消立即收起（`src/app/ipc/session.ts` / `src/ui/shell/scripts/toolbar.ts`）。
- **设置页去掉"保存设置"按钮，改即时保存**：任一表单项 change 即写入；带并发保护（保存期间再变更 → pending 补存），reset 期间屏蔽即时保存避免污染。设置项分组折叠（`src/ui/shell/scripts/pages/settings.ts`）。
- **默认启动进纯净模式 + 默认主题 dark**：平台已确定且非子代理窗口时创建后立即切 harness；主题默认值 runtime / proxy / harness 首帧三处对齐 dark（`src/app/entry.ts` / `src/plugins/runtime/theme-*.ts`）。

### Changed

- **插件安装后默认禁用**（原为安装即启用），需用户在面板手动启用；市场外手动包名安装额外弹确认。
- **项目级 MCP / 规则 / 技能默认不加载**，需先信任该工作区；用户级不受影响。
- **命令执行默认策略**：保持自动体验（智能档），仅高危投递特征强制确认——**不做"每条命令都问"**。
- **D-009**：远程 PWA 静态资源仍不鉴权（页面为无敏感数据的 UI 外壳，数据访问全走带 token 的 `/api` 与 `/ws`；加静态 token 会破坏分享链接流程）。
- **cloudflared 候选路径按可写性排序**（推测项 S-003）：`Program Files` / `LocalAppData` 优先，任意用户可写的 `C:\cloudflared` 根目录降为最后兜底。
- **插件自动更新防降级**（推测项 D-S-002）：依赖 `isNewer` 严格版本比较，补充回归测试。

### Fixed

- **A-004（P1）高危投递命令特征族**：扩充危险命令检测，覆盖 `-enc`/`iex`/`curl|iex`/`certutil`/`bitsadmin`/启动项/反弹 shell 等投递特征（中文描述命中即确认）。
- **A-007（P2）读取文件无大小上限**：读取加 200MB 上限，避免超大文件撑爆内存。
- **A-010（P3）非 UTF-8 输出致 fatal**：解码改为 fatal=false 容错并替换非法字节。
- **A-011（P3）引号外参数注入**：`Get-Content` 等命令参数正确加引号。
- **A-013（P3）grep 长输出未截断**：统一截断处理。
- **A-014（P3）glob 污染**：默认排除 node_modules 等依赖/产物目录并修 `--no-config`。
- **B-001（P1）失败重试倒计时切会话后污染新会话**：发送前复核会话，与 watchdog 对齐。
- **B-002（P1）Claude 流中断被误判为成功并执行截断代码**：正确识别错误终态并重试。
- **B-003（P2）DeepSeek 完成请求匹配无 host 白名单**：判定下沉纯函数并加 host 校验。
- **B-004（P2）流式截断的未闭合 cuckoo 块被 flush 后执行**：未闭合围栏不再提取为完整代码。
- **B-005（P2）XHR 观测路径无流静默看门狗**：补看门狗。
- **B-006（P2）残缺代码被重复执行 3 次**：语法错误不再重试，重试判定收紧。
- **B-007（P3）通知摘要正则写错吞掉字母 s**：`/\s+/g` 改正（误用为 `/s+/g`）。
- **B-008（P3）4 反引号围栏不识别**：围栏解析兼容。
- **B-009（P3）harness 流式剥离正则误伤普通代码块收尾围栏**：剥离规则修正。
- **B-010（P3）DeepSeek 发送按钮选择器宽泛且重复**：选择器收窄去重。
- **B-011（P3）executor 执行锁仅写不检**：加锁状态校验。
- **C-004（P1）上下文压缩配对错乱**：主链 walk 失败的回退分支过滤掉 branch 消息，严格 user→assistant 配对。
- **C-005（P2）get-dir-info 任意路径 stat**：收口到项目目录。
- **C-006（P2）文件 watcher 残留**：正确清理监听器。
- **C-007（P2）摘要未截断 / 插件注入主世界**：摘要长度截断。
- **C-008（P2）session 监听器轻微残留**：清理。
- **C-009（P3）compaction 健壮性**：边界处理。
- **C-012（P3）插件 debug 日志无上限**：1MB 轮转。
- **E-004（P2）确认对话框文案走 innerHTML**：动态文案改 `textContent` 承载。
- **E-005（P2）overlay escapeHtml 不转义引号**：补全 `"` `'`，属性位统一（含原推测项）。
- **E-006（P3）子代理窗口 token 写入共享 localStorage**：子代理窗口抑制每日 token 写入。
- **E-007（P3）设置页主题/活动栏名注入**：option value、文本、data 属性转义。
- **harness 渲染消毒器缺失时 fail-closed**（独立复核加固）：marked 与白名单 sanitizer 必须同时存在才渲染 HTML；消毒器加载失败时降级为纯文本转义并告警一次，绝不静默放行未消毒的 marked HTML。

### 复核加固（独立复核发现并补修）

- **项目级子代理（`.cuckoo/agents/*.md`）原本绕过工作区信任门**（D-004 补漏）：`scanAgents` 项目级未挂信任门、`scanWorkspaceArtifacts` 不探测 `.cuckoo/agents` 且 `.agents` 缺失即提前返回，导致恶意仓库的子代理（可在 frontmatter 授权 `tools: bash`）不触发信任弹窗即可被注入提示词、被 `runAgent` 实例化。已按 skills/rules 同模式在数据层门控 + 工件探测（两段独立扫描）+ prompt 过滤全部补齐，新增 6 例回归。
- **推测项 A-S-4**：MySQL 工具补 30s 语句超时（原仅 connectTimeout，慢查询会挂住连接）。
- **推测项 A-S-5**：`openBrowserWindow` 去掉 `...restOptions` 任意 BrowserWindow 选项透传。

### Audit notes（审计复核结论，不改 / 未彻底处理）

- **A-008（P2）DNS rebinding 未彻底修复**：彻底修复需引入 undici 的 pinned dispatcher（undici 非本项目直接依赖）。当前缓解为逐跳复检 + fail-closed，残余窗口与后续增强已在 `src/infra/ssrf-guard.ts` 头注释说明。
- **A-009（P3）审计结论不成立**：`addMemory`/`removeMemory` 全同步、IPC 无 await 间隙，不存在读改写竞态，不改。
- **C-010 / C-011（P3）复核无缺陷**：回源确认逻辑正确，不改。
- **推测项回源排除（9 条）**：A-S-2（`new Function` 仅编译不执行，无注入面）、A-S-3（多 file input 附错位置属 UX 非安全）；B-S-1（DeepSeek 会话提取 currentIndex）、B-S-2（ChatGPT 增量帧 `o` 缺失路径）、B-S-3（hook 异步注入时序）、B-S-4（custom provider 直接 require 路径）均回源无缺陷；C-S-002（`execute-command` 是用户手动通道，逐条确认，无额外注入面）；E 项 start.js `CUCKOO_DEBUG_PORT`（环境变量等价本机权限，非攻击面）、chat-input 延迟发送（引用捕获正确，切会话不串台）。

### 验证

- `npm run typecheck`：0 error；`npm test`（vitest）：**127 文件 / 1184 用例全过**（基线 100 文件 / 1012 用例，新增约 172 个）；`npm run lint`：0 error；`npm run compile`：0 且生成物无漂移。
- 已通过独立复核（`docs/audit/2026-10-17-修复独立复核-0.10.0.md`）：测试未弱化/跳过/硬编码、主进程闸/信任门/sanitizer/进程隔离/SSRF/WS 鉴权抽查成立，复核发现的 1 项重要缺口（项目级子代理信任门）与 1 项加固（sanitizer fail-closed）已补修并复测。
- 12 个攻击/防御 PoC 全部复跑：攻击型在真实模块回归中失效、防御型（zipslip 等）继续拦截；静态拷贝型 PoC 仅作历史留存，权威验证以 `test/` 下 import 真实模块的回归为准。

## [0.9.24] - 2026-10-17

### Fixed
- **增强停止按钮不可见（图片模式下）**：v0.9.23 图片模式把整个工具区（含停止按钮）淡出了 → 看不到也没法点。现只淡出输入区/附件/发送，保留增强(停止)按钮可见可点。

### Changed
- **增强停止按钮改红色醒目**：增强中按钮改实心红底 + 白图标 + 呼吸脉冲（原来是 accent 色，不够醒目）。

## [0.9.23] - 2026-10-17

### Added
- **增强「停止」按钮**：提示词增强中，✨ 按钮变为停止图标，可随时取消在途增强（前端作废令牌 + 主进程 abort 在途 fetch）。此前最长要等 30 秒。
- **未聚焦输入框美化**：默认态加一层柔和抬升（描边 + 极淡投影 + 顶部微高光），hover 加深；聚焦态明确焦点环（不再与 hover 阴影叠加）。

## [0.9.22] - 2026-10-17

### Fixed
- **增强「炫酷图片」背景样式选不中/不持久**：v0.9.21 遗漏给 ui-prefs 的 PromptEnhancerConfig 补 backgroundStyle/backgroundImage 字段——保存时写入了，但主进程 normEnhancer 读回时把这两字段丢弃，导致关弹窗再开又回到「科技网格」。现补齐字段定义 + 规整逻辑。

## [0.9.21] - 2026-10-17

### Added
- **增强中「炫酷图片」背景模式**：纯净模式提示词增强时，输入框可整块显示科技图（内置 9 张，自带「正在变强/火力增强」文案），文字/按钮淡出；增强设置可切「科技网格 / 炫酷图片」，图片模式支持指定某张或随机。图片以 3200x800 无损压缩存放（src/ui/enhance-images/，共约 3.5MB）。

## [0.9.20] - 2026-10-17

### Added
- **纯净模式提示词增强**：输入框旁新增 ✨ 按钮（Ctrl+E），调用独立 OpenAI 兼容 API 把草稿改写成更清晰、可执行的提示词，回填输入框（不自动发送）。可撤销、失败不动原输入、增强中禁用输入防覆盖；切会话/新对话自动取消在途增强（防串台）。支持携带最近 N 轮上下文 + 项目技术栈，两种力度（温和/激进）。
- **增强设置**：纯净模式顶栏「增强设置」入口，可配 API 地址/Key/模型/力度/上下文轮数/自定义提示词；改动即时生效并跨窗口同步，无需保存按钮。API Key 仅存本地 ui-prefs.json，不进仓库。
- **底部「最近」胶囊全局化**：最近使用（技能/MCP/子代理/提示词）由各窗口独立 localStorage 改为主进程全局存储（recent-tools.json），跨窗口同步。

### Changed
- **纯净模式输入框**：默认高度提升，自动增高到内容全显示（上限 70vh，超过才滚动）；顶部新增拖拽手柄可手动加大；发送后复位为默认并重新自适应。
- **输入框边框**：精简为单条发丝边框；聚焦时内部显示淡科技方格、边框微亮（去掉此前过重的阴影/发光/渐变边框）。
- **增强动效**：输入框科技流光边框（旋转扫描）+ 增强按钮能量环 + 启动粒子爆发（纯 CSS/SVG，无外部资源）。

### Fixed
- **发送队列「立即发送」等待期间切会话仍发出旧消息**：v0.9.18 引入的「等旧任务停止再发」（waitForAiIdleThenSend）在等待期间若用户切会话/开新对话，轮询到点仍会把旧消息发进新会话。现用 manualSendToken 令牌认领，切会话/新对话（clearTransientState）自增令牌使其作废、放弃发送。

## [0.9.19] - 2026-10-17

### Added
- **更新弹窗重设计**：「发现新版本」由通用确认框改为专属版式——品牌头 + 版本跃迁（`0.9.17 → 0.9.18 NEW`）+ 更新日志列表 + 体积提示，右下角浮窗定位不变（不打扰）。
- **下载进度实时展示**：用户点「立即更新」后弹窗保留，切换为下载态，实时显示百分比进度条（此前只推壳页面状态栏）。

### Changed
- **更新日志取自 GitHub Release 说明**：`electron-updater` 的 `releaseNotes`（HTML 格式）经 `htmlToText` 剥离标签/解码实体后展示，最多 5 条；兼容纯 Markdown 格式，无法获取时静默省略。

## [0.9.18] - 2026-10-17

### Fixed
- **发送队列「立即发送」旧任务尾巴回填新对话**：在 AI 生成中点队列某条的「立即发送」时，旧实现停任务后固定只等 80ms 就发出新消息。若网页侧收尾慢于 80ms，旧任务的尾部事件（流式帧 / 回复完成 / 工具结果回传）会在新任务开始后到达，被算进新对话（回填串台）。现改为**等旧任务真正停止再发**：以「自 stop（及最后一次事件）起持续 300ms 无事件到达」为主判据，叠加网页权威生成状态已停，并设 3000ms 超时兜底；等待期间若有事件到达则重新计静默期。「立即发送」在途时忽略后续点击，避免多条同时插队。

## [0.9.17] - 2026-10-16

### Fixed
- **窗口列表：点窗口名直接进入重命名**：此前点击卡片上的窗口名会弹出重命名框，与"点卡片=打开窗口"的直觉冲突。现窗口名改为普通文本（无 title 提示），点名字与点卡片其它区域一致 = 打开窗口；仅点铅笔图标（✎）才进入重命名。

## [0.9.16] - 2026-10-16

### Fixed
- **新建对话导航失败时监听器泄漏**：`new-conversation-for-project`（侧栏"用项目新建对话"）在 `loadURL` 失败时未移除 `did-finish-load` 监听器 → 残留累积，下次任意导航都会误触发 `initProject`（给非目标会话注入系统提示词）。现对齐 `web-new-conversation` 的处理（失败时显式移除）。
- **同 URL 导航时 loading 遮罩残留**：用户已在首页再点「+」时，Electron 可能不派发 `did-finish-load` → `onLoad` 不执行 → 遮罩残留到 15s 兜底。现检测"导航前后 URL 相同"时手动触发。
- **新建对话双击重复注入**：`new-conversation-for-project` 补上双击防护（清理上一次未完成的监听器/定时器），与 `web-new-conversation` 行为一致。
- **设置页图标列表漏插件图标**：插件图标异步挂载时若设置页已打开，列表不刷新。现插件挂载后派发事件，设置页订阅刷新。
- **首次提示抑制窗口偏宽**：点「+」后抑制「初始化项目」弹窗的时间窗 10s → 5s。

## [0.9.15] - 2026-10-16

### Added
- **新建对话 loading 遮罩**：点顶部「+」后，主进程要导航首页 + 注入系统提示词，期间页面停在空白首页无反馈。现显示居中「呼吸图标 + 流光进度条」遮罩（品牌图标柔和呼吸 + 细流光扫过），完成后自动隐藏，含 15s 安全兜底。

### Changed
- **tooltip 换回 DOM 方案**：v0.9.14 的独立透明窗口方案在 Windows 上闪烁、体验差，回退为 DOM 内渲染（跟手流畅）。删除独立窗口相关 4 个文件。保留"顶部工具栏不弹 tooltip"。
- **设置页活动栏图标可折叠**：默认收起，展开后竖排列表；改为动态读取活动栏 DOM（含插件图标）→ **Agent 模式等插件图标也可隐藏**。
- **新建对话耗时优化**：`did-finish-load` 后固定等待 2000ms → 400ms（省约 1.6s）。`initial-prompt` 监听器在 preload 顶层同步注册、输入框就绪由轮询保证，无需长等待。
- **通知摘要展示优化**：正文 2 行 → 3 行；卡片高 118 → 154；底部内边距加大，摘要不再被进度条压住。

### Fixed
- **点顶部「+」误弹「初始化项目」**：该弹窗本为"全新用户首次进首页"引导，被"开新对话"误触发。现点「+」后 10s 内不弹。
- **新建对话 loading 黑屏**：遮罩曾放在侧栏 `.ck-panel` 内，侧栏收起时 `display:none` → 遮罩不渲染但 modal-guard 仍隐藏 AI 视图 → 黑屏。现移至 body 顶层。

## [0.9.14] - 2026-10-16

### Added
- **tooltip 改为独立透明置顶窗口**：AI 页面是 WebContentsView（原生视图），永远压在壳页面 DOM 之上，CSS z-index 无效——壳页面内画的 tooltip 会被 AI 视图遮挡（真机实测顶部按钮 tooltip 与 AI 视图矩形重叠）。现 tooltip 由独立窗口渲染（屏幕坐标定位、鼠标穿透、不抢焦点、固定尺寸），永不被遮挡。新增 tooltip-window/preload/ipc + tooltip.html。

### Changed
- **Token 图标还原为文字「元」**（此前改为硬币 SVG，现还原）。
- **tooltip 交互节奏**：首次悬停延迟 700ms、连贯巡视 280ms；淡入动画 0.16s（延迟更从容、出现更干脆）。

### Fixed
- **Git 提交历史展开挤掉改动/暂存列表**：改动列表保最小高度 130px、历史展开保最小高度 150px，两者各占空间互不挤没。
- **Git 分组标题跟随滚动**：改为 `position: sticky`，滚动改动列表时「已暂存/更改」分组标题吸顶固定（对齐 VSCode 交互）。
- **纯净模式技能 chip 被吞**：`send()` 气泡文本原为互斥 if-else，有文字时技能/工具标签被丢弃。现文字与标签**分离存储**，标签渲染为气泡内 chip（文字 + chip 同时显示）；编辑取消、历史恢复均正确重现。

## [0.9.13] - 2026-10-16

### Fixed
- **通知浮窗图片显示不完整**：图片区固定 100px 高 + `object-fit:cover`，把 900×408（2.21:1）等宽幅图**裁切压扁**。现图片加载后按真实宽高比计算图片区高度（clamp 80~320px），完整显示不裁切。
- **通知浮窗进度条渐变单调**：改为 4 段渐变（实色 → 提亮 → 实色 → 淡出）+ 同色系外发光，倒计时缩短时右端先消隐，有"流光"走向。

## [0.9.12] - 2026-10-16

### Added
- **活动栏图标显隐设置**：设置页新增「活动栏图标」卡片，逐个开关控制左侧活动栏显示哪些图标，即时生效、持久化（localStorage）。设置项本身不可隐藏（防死锁）。用户隐藏的图标**不进**「⋯」溢出弹框。

### Changed
- **Token 图标统一为 SVG**：活动栏「Token（词元）」原用文字「元」，与其余 19 个线条图标不一致，现改为硬币造型 SVG（外圆 + 内圆 + 竖线）。

### Fixed
- **通知浮窗底部留白过大**：浮窗高度固定为「基础高 + 图片高」，但内容不足时（如单行标题 + 一行摘要）底部留白明显。现渲染完成后测量内容真实高度回传主进程，贴合窗口消除空白（clamp 48~400px）。

## [0.9.11] - 2026-10-16

### Fixed
- **思考阶段底栏输出速度（TPS）显示 `-- t/s`**：TPS 计算只取正文（`ev.text`），忽略思考内容（`ev.think`）。思考阶段正文为空，估算路径算不出速度；DeepSeek 服务端 `accumulated_token_usage` 在思考阶段通常也未下发，精确路径同样失效 → 显示 `-- t/s`。现把思考内容一并纳入估算（`text + think`），思考阶段也能实时显示速度。平台提供精确 token 时该参数被忽略，不受影响。

## [0.9.10] - 2026-10-16

### Added
- **纯净模式生成中禁用工作区"切换其他会话"**：AI 正在回复/跑工具时，点工作区列表切到其他会话会打断任务——纯文本生成时流被页面导航中断；**工具执行中切走更严重**：工具在后台跑完但结果回传上下文已随导航销毁，导致工具白跑、AI 卡住。现生成中非当前会话置灰禁用切换（重命名/归档/删除仍可用，当前会话不置灰），生成结束自动解除。复用既有 harness busy 链路，无需新增 IPC。

### Changed
- **任务页 package.json 脚本列表默认折叠**：此前默认展开占垂直空间，现改为默认折叠，点击标题展开。

## [0.9.9] - 2026-10-16

### Added
- **压缩续接会话自动继承/生成标题**：此前压缩产生的新会话 `title` 为 null，工作区列表回退显示一串 UUID（真机取证：所有显示 UUID 的会话均为 `kind: compaction` 且 title 为 null），用户难以辨认。现：
  - 压缩新会话从父会话**继承标题**作为兜底；
  - 压缩摘要指令要求 AI 首行输出「【标题】xxx」，段3 解析后经新增 IPC `set-pending-session-title` 暂存（`forceStage` 强制暂存，避免误写父会话），待新会话 ID 出现时绑定，**覆盖继承的父标题**。

### Fixed
- **压缩摘要标题解析正则跨行 bug**：`parseSummaryTitle` 原正则在标题为空时会把正文首行误当标题；改为先剥离前导空白、按首行精确匹配，且无论标题是否为空都剥离标签行（防污染注入新会话的 extraPrompt）。
- **段2 压缩失败未清理标题残留**：补齐 `COMPACT_TITLE_KEY` 清理，与摘要清理对称。
- **setPendingSessionTitle 未捕获 rejection**：补 `.catch()`，避免 unhandled promise rejection。

## [0.9.8] - 2026-10-16

### Changed
- **任务完成通知：图片区调小 + 展示 AI 回复摘要**：图片轮换区从 170px 降至 100px（此前过高喧宾夺主）；通知正文改为展示 AI 回复摘要（截断 120 字），无摘要时退回"回复已生成"，让用户一眼看到 AI 说了什么。
- **底部「最近」快捷按钮改为只填入不发送**：此前点击技能/MCP/子代理/提示词快捷项会**直接发送**，容易误触。现统一改为只回显到输入框（`autoSend=false`），由用户确认后手动发送。

### Fixed
- **纯净模式右侧对话导航 hover 不弹提示**：生成/回复期间 `scrollBottom` 频繁触发 `scroll` 事件，而全局 tooltip 引擎监听 `scroll` 立即隐藏——导致导航 tooltip 一显示就被打断。现导航（`.conv-nav`，fixed 定位）的 tooltip 不受滚动影响。
- **对话导航提示弹框遮挡导航本身**：tooltip 原先统一显示在元素下方，右侧导航场景会盖住导航。现改为**右侧空间不足时显示在元素左侧**并垂直居中。

## [0.9.7] - 2026-10-16

### Added
- **压缩续接提示**：压缩后在新会话中，harness 历史/队列/目标/计划都会重置为空白，界面无任何提示，用户容易误以为对话丢失。现 harness 检测到压缩流程启动（bridge 上报的 `framework-send` tag=`压缩-摘要`）后置内存标记，待新会话空历史到达时显示"上下文已压缩，AI 已携带前情提要无缝续接（原对话保留在网页侧；待发队列 / 目标 / 计划已重置）"。信号源改用内存标记（harness 是 `file://` 页面，与 AI 页面的 `https://` 源 **localStorage 隔离**，跨页标记方案不生效）。

### Fixed
- **输出速度（TPS）停止后仍停留旧值**：模型生成结束、或进入工具执行阶段时，状态栏的 TPS 一直停留在上一轮的最终值，让用户误以为仍在生成。现「任务结束」（task-idle）与「工具开始执行」（tool-start）时清空为 `--`。
- **窗口组切换注释与代码不符**：`entry.ts` 原注释称"手动转移对话保留源窗口"，但实际两处调用 `closeSource` 均为 `true`（手动转移也关源窗口）。已更正注释。

## [0.9.6] - 2026-10-16

### Added
- **任务完成通知图片轮换**：通知浮窗新增图片展示区（170px 高），从 `src/ui/notif-images/` 读取图片轮换展示（2.4s 切换、随机起始、hover 暂停、懒加载 + 预加载下一张）。27 张 webp 图（原 129MB 压至 1.6MB，q85 @900px）。

### Fixed
- **纯净模式发送队列"点一个暂停整个队列"**：此前点队列某条"立即发送"会把整个队列标记为"已暂停自动发送"，需手动点"恢复"。现改为**临时抑制**（仅挡住 `stop()` 引发的连带 flush），发完自动恢复，剩余队列照常按序自动发送。
- **队列连点顺序错乱**：`stop()` 会同步复位状态使 `isBusy()` 立即变 false，导致 80ms 内连点第二条误走"空闲直发"分支（顺序颠倒）。新增 `manualSendInFlight` 标志，手动发送在途时也走"先停再发"分支。

## [0.9.5] - 2026-10-16

### Changed
- **更新弹窗改用专属 `update` 图标**：此前「发现新版本 / 更新已就绪」用 `kind:'info'`（蓝色圆圈 i），语义不贴切。现新增 `update` 类型（下载箭头图标，品牌蓝），更新相关弹窗/通知统一改用它。

## [0.9.4] - 2026-10-16

### Changed
- **限流倒计时浮窗去关闭按钮**：与通知/确认浮窗风格统一（仍有"取消自动切换/立即切换"按钮 + Esc 取消）。
- **三个弹窗图标块统一升级**：实心品牌色 + 立体高光（inset 顶部白/底部暗）+ 图标投影，视觉更精致统一。限流弹窗图标块从淡色底改为实心琥珀色。

## [0.9.3] - 2026-10-16

### Fixed
- **子代理运行完成误弹"任务完成"通知**：子代理窗口跑完整 bridge，完成时 `observer.ts` 无条件发通知 IPC。主进程虽有 `ctx.isSubagent` 兜底，但存在销毁竞态——子代理 `subagent-response` IPC 先到触发 `ctx.win.destroy()`，等通知 IPC 到达时窗口已销毁、`getContextByWebContents` 返回 null 并回退到主窗口，导致误弹。现于 bridge 源头抑制：子代理/网关窗口 (`setSuppressAiNotification`) 直接不发通知。

## [0.9.2] - 2026-10-16

### Changed
- **通知浮窗 / 确认对话框视觉重构**：对齐"限流切换浮窗"设计语言——去掉右上角关闭按钮、图标改实心品牌色、顶部高光发丝线、底部渐变进度条、卡片微渐变。确认窗高度改动态（有错误细节 232px / 无 168px）。通知窗尺寸 360×124 → 400×118。

### Fixed
- **纯净模式发送队列"点一个全发"**：队列中手动点「立即发送」某项后，剩余队列会被"任务结束自动排空"连带发出。根因是 `doSendQueueItem` 内的 `clearAbortSuppression()` 抹掉中止标志，任务结束后 `maybeFlushQueue` 照常排空。现新增 `autoFlushPaused` 标志——手动插队后暂停自动排空（只发那一条），队列头显示「已暂停 + 恢复按钮」，可点击恢复；重新入队也自动恢复。
- **确认对话框 Enter 双触发**：Tab 聚焦到按钮后按 Enter，全局 keydown 与按钮 click 同时触发（primary 抢先）。现聚焦按钮时跳过全局处理。

## [0.9.1] - 2026-10-16

### Added
- **手机端进入显示电脑对话历史**：此前手机连入只补发"活跃流"（正在生成的内容），电脑空闲时进入为空白。现改为：新客户端连入时，从目标窗口的 harness 拉取结构化历史（复用窗口组切换的 `requestHarnessExport`），过滤出 user/assistant/system 可渲染条目、取最近 40 条补发；手机端 `renderHistory` 渲染。
  - `src/remote/server.ts`：新增 `sendToClient(ws, payload)`（只发单个客户端）；`onNewClient` 回调透传 ws。
  - `src/remote/manager.ts`：新增 `pushHistoryToNewClient`；`pushActiveStreamsToNewClient` 改为**先补历史、再补活跃流**（顺序关键——若先发活跃流，客户端先建出流式气泡，历史到达时会被"已有消息则跳过"判据拦下 → 历史永不显示）。
  - `src/remote/pwa/app.js`：新增 `renderHistory`。
  - ⚠️ 依赖纯净模式（harness）历史；从未进过纯净模式的窗口无历史可补，静默降级为空态。

## [0.9.0] - 2026-10-16

### Added
- **自绘系统通知浮窗**（取代 Electron 原生通知）：新增 `src/app/notification-window.ts` + `src/ui/notification-window.html` + `src/app/notification-preload.ts`。右下角无边框卡片、深/浅色自适应、多条垂直堆叠、hover 暂停倒计时、点击聚焦对应窗口，视觉与"限流切换浮窗"统一。改造 3 处调用：AI 任务完成（`ipc/renderer.ts`）、窗口组切换（`entry.ts`）、更新提示（`updater/index.ts`）。
- **自绘确认对话框**（取代 `dialog.showMessageBox`）：新增 `src/app/confirm-window.ts` + `src/ui/confirm-window.html` + `src/app/confirm-preload.ts`。右下角卡片 + 主/次按钮 + Esc/Enter 快捷键，错误细节可滚动。替换更新流程 4 处原生对话框（发现新版本 / 更新已就绪 ×2 / 更新失败重试）。
- 需求档案 `docs/requirements/068-notification-window.md`。

### Performance
- **纯净模式流式渲染改回"节流全量 markdown"**（80ms）：v0.8.89 为消除 O(n²) 改成纯文本增量，代价是流式期间无格式、收尾才"唰"地变格式。现折中为节流全量 markdown 渲染——流式期间始终带格式、肉眼流畅（~12fps），渲染次数较旧版 60fps 降约 5 倍。
- **手机端流式 markdown 节流 200ms → 80ms**，与电脑端对齐。
- **TPS 口径改滑动窗口（4s）**：原为"整轮平均"（思考阶段计入分母 → 出字飞快却显示低速）。改为窗口内 token 增量 / 时间增量，反映近期真实速度；同时区分"acc 曾增长"与"从未增长"，避免跨量纲混用污染窗口。

### Fixed
- **手机端"总是生成失败/请求失败"（根因）**：DeepSeek 偶发空正文 → 电脑端自动重试引擎静默重试，但 `remote-bridge` 把同一可重试错误立即上报手机 → 手机在电脑倒计时重试时就显示"生成失败"。修复：新增 `cuckoo-retry-state` 事件，重试期间不上报终态、仅提示"正在自动重试"。
- **流式尾部泄漏 ```cuck ```**：AI 刚输出围栏前缀（未换行）时正则不匹配，半截围栏作为普通文本闪现。`harness-bridge`/`remote-bridge` 加兜底正则。
- **空白气泡**：`onStream` 无条件创建气泡，纯工具回合（正文被 strip 清空）会建出空气泡。改为空内容且无活跃气泡时不创建。
- **`+` 新对话未沿用当前项目**：`web-new-conversation` 只 `loadURL`，不重新注入项目上下文 → 新对话丢失项目。改为沿用当前 `selectedProjectDir` 自动初始化；并修复快速双击导致的监听器重复（`initProject` 跑两次）与 loadURL 失败的监听器泄漏。
- **手机端思考块太矮/易提前折叠**：`.think-body` `max-height` 320px → 45vh；正文出现时不再立即折叠思考块（收尾才折叠），避免"思考一闪而过"。

## [0.8.99] - 2026-10-16

### Performance
- **手机远程流式渲染优化（不再"先出现一大坨 md 再变格式"）**：
  - 手机端 PWA 流式期间改为**低频（~200ms）渲染 markdown**（此前流式期间是纯文本追加，收尾才渲染，故表现为"一大坨 md 突然变格式"）。渲染后切 `.stream-text--md`（normal 空白，避免 `pre-wrap` 与 `<p>` 双重间距）。
  - `streamNode` 从 `<span>` 改为 `<div>`（承载块级 HTML，span 放块级不合法）。
  - **降低端到端延迟**：bridge 节流 100→60ms、manager 节流 100→60ms（端到端首帧延迟约 240ms→120ms）。
  - 收尾 `finishStreaming` 仍走全量渲染 + 代码块增强 + 复制按钮（不受影响）。

## [0.8.98] - 2026-10-16

### Performance
- **Harness 流式出字更流畅**：三个 provider hook（deepseek/claude/chatgpt）的流式节流从 **80ms → 40ms**（刷新率 12.5→25 fps），缓解出字"一坨一坨"的卡顿感。finished 帧绕过节流不受影响。
- **滚动 rAF 合并**：`harness.html` 的 `scrollBottom` 改为一帧最多滚动一次，减少长回复下每帧强制 reflow 的布局抖动（配合节流降低）。含修复：rAF 内重新校验 `pinBottom`，避免把正在上翻历史的用户弹回底部。

## [0.8.97] - 2026-10-16

### Fixed
- **Harness 流式收尾卡顿（同一条回复被全量渲染两次）**：纯净模式下流式结束、markdown 突然变格式那会的卡顿。根因：同一条回复被 `renderMarkdown`（KaTeX + marked + innerHTML 重建）跑了两次——`onStream(finished)` 收尾帧一次 + `onAssistantDone`（assistant-done 事件）又一次；`onAssistantDone` 本有文本去重，但 finished 帧未更新 `lastDoneText` → 去重不生效。修复：finished 帧渲染后标记 `lastDoneText`，让 assistant-done 去重命中、跳过重复渲染。
  - 去重命中取决于两处文本一致（常见情况命中；工具块边界不一致时安全退化为渲染两次，**不丢内容**）。

## [0.8.96] - 2026-10-16

### Fixed
- **记忆章节截断仍可能超上限（边界漏洞）**：v0.8.95 改"保留最新"时，预算未计入提示前缀 `- ...（较早的记忆已省略）` 的长度 → body 最多可超 `MAX_SECTION_LEN` 数十字符（真机验证实测 4024 > 4000）。修复：前缀计入预算。验证：body 3975 ≤ 4000。

## [0.8.95] - 2026-10-16

### Fixed
- **用户记忆写入非原子（崩溃即全丢）**：`memories.ts` 的 `saveMemories` 用 `writeFileSync` 直写目标文件，进程中途崩溃会留下半截 JSON → 下次读取解析失败 → **全部记忆静默丢失**。改为**临时文件 + rename 原子覆盖**；Windows 上目标被占用（EPERM/EBUSY）时降级为就地覆盖（保住本次写入，不引入新失败）。
- **记忆章节截断方向反了（丢最新）**：`buildMemorySection` 超 4000 字时用 `slice(0, MAX)` 保留**最早**的记忆、丢弃**最新**的 → 用户刚记的偏好反而**不被注入**。改为**保留最新**（与 `MAX_MEMORIES` 的"丢弃最旧"策略一致）。
- **压缩摘要生成了却被完全丢弃**：`compaction.ts` 段1 发摘要指令、花 token 拿到摘要却只打日志、之后完全没用；段2 只取最近 20% 原文 → 新会话**前 80% 关键信息全丢**。修复：段1 把摘要存 localStorage，段3 作为 `extraPrompt` **注入新会话**（带前情提要继续）。名为"压缩"终于名副其实。

### Added
- 需求档案 `docs/requirements/067-memory-compact-audit.md`。
- 记忆测试补 3 项（原子写不残留临时文件、损坏文件不抛错、截断保留最新）。

## [0.8.94] - 2026-10-16

### Fixed
- **子代理完成弹系统通知**：`observer.ts` 在"任务完成"分支无条件调 `showAiNotification()`，而它是所有窗口共用（含子代理窗口）→ 子代理每轮纯文本回复都触发通知。修复：`renderer.ts` 的 `show-ai-notification` 判 `ctx.isSubagent` → 直接跳过（不通知、不闪烁任务栏）。**只有父/主对话真正完成才通知。**
- **子代理 frontmatter 的 `tools` 字段完全失效**：`tools: read, readLines, glob, grep` 被 scanner 解析、传入 subagentConfig，但全链路无任何消费 → "只读"子代理（如 code-reviewer）实际能 edit/write/bash，专家约束形同虚设。修复：`bridge/subagent.ts` 的 `buildSubagentPrompt` 根据 `cfg.tools` 拼入【工具约束】提示（机制层无法物理禁用工具，用系统提示软约束；这是让该字段真正生效的可行手段）。

### Added
- 需求档案 `docs/requirements/066-subagent-audit.md`：子代理机制全面审计（项目级 10 + 插件专家包 5）。

## [0.8.93] - 2026-10-16

### Fixed
- **工具结果回传偶发失败致模型停下**：工具执行完，结果回传 AI 的链路（`observer.ts` → `sendCombinedJsResultsToChat`）失败时**无重试** —— 找不到输入框（页面重渲染/导航中）、填入内容失败等机械失败一旦偶发，本轮结果即永久丢失，模型收不到结果便停下。
  - **修复**：`observer.ts` 新增 `sendToolResultWithRetry` —— 回传失败时退避重试（600ms，最多 3 次）；最终仍失败则记日志（便于排查，不再"莫名停下"）。
  - **范围**：仅 bridge 的工具回传路径，**不改 `chat-input.ts` 任何函数签名 → Harness 零影响**。

### Note
- **未修**「`triggerSend` 假阳性」（发送指令已触发但站点未真正接收）：该情况无法可靠检测（输入框清空时机、contenteditable 文本归一化都不可控），强行检测会导致同一条工具结果**重复发送 → 工具重复执行**（破坏性大于原 bug），故不做自动补发。此类偶发若再出现，需真机日志定位。

## [0.8.92] - 2026-10-16

### Fixed
- **手机远程连接稳定性**（用户反馈"容易断线"）：
  - **cloudflared 隧道崩溃后无自愈**：`tunnel.ts` 的 `onExit` 此前只清状态、不重启，隧道一旦退出即永久失效。新增**代际号 + 闭包绑定进程**的自动重启（退避 3s→30s，最多 5 次；致命启动错误不重试；stop 作废在途重启）。
  - **手机后台/锁屏后服务端判死过快**：服务端心跳从"两次无 pong（60s）"放宽到"三次（约 120s）"，给浏览器冻结 JS 定时器留恢复时间。
  - **半开连接静默丢消息**：客户端 `sendRaw` 增 `isConnStale` 检测（阈值 130s，明显大于服务端判死，让"服务端先断→客户端正常重连"为主路径）；[停止] 指令发送失败时不再静默，给出可见提示。

## [0.8.91] - 2026-10-16

### Fixed
- **手机远程端卡"正在生成回复"（与电脑端不同步）**：手机端清"生成中"只依赖 `ai-reply`/`ai-stop`/`ai-error` 三个终态事件；当一轮回复含工具块被 `stripBlocks` 剥空（`remote-bridge.ts` `if (!clean) return`）或终态丢失时，无权威心跳兜底 → 永久 busy。
  - **修复**：manager 新增 watchdog（每 3s）——对每个活跃流式状态，若网页已停止生成（`windowState.isGenerating=false`）且静默超阈值，则主动收尾。
  - `StreamState` 加 `toolCount`/`lastAt`/`toolLastAt`；工具阶段无活动超 5 分钟视为 `tool-end` 丢失，强制收尾（防 toolCount 卡死让 watchdog 失效）。
- **子代理窗口污染父窗口生成状态**：子代理与父窗口共用 `profileId`，空闲子代理上报 `ai-state(false)` 会覆盖父窗口的 `true`（反之亦然），污染两类消费者。修复：`windowState` 把"主窗口生成"与"子代理生成"**分开存储**——新增 `isGeneratingAny`（含子代理，供窗口组切换用），`isGenerating` 收窄为"仅主窗口"（供 watchdog 用）。

## [0.8.90] - 2026-10-16

### Fixed
- **手机端历史思考块无法点击展开（多个思考框联动）**：`ensureThinkEl` 的点击监听器闭包引用了全局变量 `thinkEl`，多轮对话后它已指向最新轮次的元素，导致点击**任何**历史思考块都操作最新那个 → 表现为"几个思考框同步、点不动"。修复：监听器用局部 `el` 捕获本次创建的节点；只有点击"当前活跃"思考块时才置 `thinkUserToggled`（点历史块不干扰当前轮）。

## [0.8.89] - 2026-10-16

### Changed
- **手机端流式签名动效增强**：AI 消息尾部的 `✦ Cuckoo` 在生成期间更像"正在生成的光标"——四角星持续脉动（缩放 + 缓慢旋转 + 辉光呼吸），签名文字同步轻微呼吸。结束后恢复静态署名。位置保持在尾部不变。

## [0.8.88] - 2026-10-16

### Added
- **手机远程端显示 AI 思考过程**：此前手机端完全收不到思考（thinking），现在实时同步并展示：
  - 正文上方独立可折叠的思考块（流式期间自动展开，正文出现或收尾后自动折叠）；
  - 用户手动点过标题后尊重其选择（不再自动折叠）；
  - 收尾显示"已思考 (N 字)"。
- **协议升级**：`ai-stream` 从 `{ delta, reset }` 升级为 `{ thinkDelta, textDelta, reset }`，think 与 text 独立增量（各自算 delta，任一前缀回退即整体 reset）。

### Fixed
- **"连接成功但消息推送失败"**：`initRemote` 启动服务后从不广播 `remote-mode`，若 AI 页面 preload 在服务启动前查询 `remote-is-enabled` 得到 `false`，此后无事件复位 → bridge 门控永久关闭，所有流式上报被丢弃。修复：启动成功后主动广播 `remote-mode(true)`。
- **"切后台再切回需重连"后丢消息**：重连后只发 `ready`，不同步当前流式状态。修复：新增 `onNewClient` 回调，新客户端连入时把每个活跃流的当前全量以 `reset=true` 补发，并同步基线 `sent/thinkSent`（防重复发尾巴）。
- **stop/error 时思考尾帧丢失**：`onAiStop`/`onAiError` 的 flush 条件只看 `text`，think 仍有未广播增量时不触发 flush → 尾部思考永久丢失。修复：条件纳入 think。

### Changed
- `broadcastRemoteMode` 统一由 `remote/manager.ts` 导出，删除 `ipc/remote.ts` 的重复实现。
- PWA 清理：`appendStreaming` 的 `reset` 死参数删除（清空逻辑已上移到消息处理层）；`resetThink` 补 `sawText` 复位。

## [0.8.87] - 2026-10-16

### Fixed
- **Harness 纯净模式卡"生成中"**：AI 网页原始回复已终止（真实任务结束），但 Harness 仍显示"生成中"、发送键停在"停止"态。
  - **根因**：`aiGenerating` 一旦置 true 缺少可靠复位时机，叠加"心跳续命"形成死循环——
    1. `harness-bridge.ts` 的 `onStream` 只处理非 finished 帧（置 true），**finished 帧不复位**；
    2. `onInterceptedResponse` 仅当"回复不含 js/cuckoo 代码块"才复位，含工具块的回复**永不复位**；
    3. `aiGenerating` 卡 true 后，2 秒心跳**持续上报 true**；
    4. `harness.html` 的 `onAiState(true)` 每次都刷新 `lastActivityAt`，令 6 秒静默兜底**永不满足**。
  - **修复**：`onStream` 的 **finished 帧（流式结束的权威信号）复位 `aiGenerating`**；`onAiState` 在工具运行中（`toolRunningCount>0`）改用 600 秒静默阈值（防误清长工具），工具一结束即回落 6 秒。
  - 真机验证：ai-state 序列 `[0,0,0,0,1,1,0,1,1,0,0,...]` —— 生成置 1、finished 后正确复位 0。

## [0.8.86] - 2026-10-16

### Added
- **限流自动切换改系统级浮窗告警**：此前限流触发自动切换前，向 harness 页面发 IPC 让 harness 自己渲染倒计时弹窗，但用户经常看不到（AI 页面盖住 / 窗口在后台 / 已切到别的应用）。改用独立 Electron BrowserWindow 浮窗：
  - **屏幕右下角**独立窗口（无边框、透明、圆角、自绘阴影），**多屏下自动落在焦点窗口所在的显示器**；
  - **alwaysOnTop** + 跨虚拟桌面可见，确保任何场景都看得到；
  - **10 秒倒计时**（进度条 + 等宽大数字实时递减）；
  - 按钮 **[取消自动切换]** / **[立即切换]**；键盘 **Esc / Enter 均为取消**（保守原则，防误触切换）；点 ✕ 或 Alt+F4 也视为取消；10 秒到点自动执行切换；
  - 窗口内显示当前限流窗口名。
  - 新增文件：`src/ui/alert-window.html` / `src/app/alert-preload.ts` / `src/app/alert-window.ts`（对外 API `showSwitchAlert(options) → Promise<'cancel' | 'switch-now' | 'timeout' | 'superseded'>`）。

### Changed
- **harness 内倒计时结构（`countdownBeforeAutoSwitch` / `harness-cancel-switch` / `pendingAutoSwitch`）标为已弃用**：代码保留以备将来复用为"温和提示"，但自动切换流程不再调用。harness-preload 侧同名通道一并保留为历史兼容。

### Fixed
- **自动切换在告警浮窗异常时不再卡死**：`rate-limit-hit` 里 `showSwitchAlert` 加 try/catch，异常时释放 `switchingProfiles`，避免该窗口的后续限流全部被 `reason:'in-progress'` 吞掉。
- **多窗口同时限流时语义污染**：第二个告警顶替第一个时返回 `'superseded'` 而非 `'cancel'`，调用方据此不再误记"用户取消"日志。

## [0.8.85] - 2026-10-16

### Fixed
- **手机端 stop/error 尾帧仍丢（056 遗留修复）**：056 让 bridge 层 `stopStreamThrottle(true)` 先 flush pendingText，但 flush 后进入 manager 的 `onAiStream` 只是 `setTimeout(flushStream, 100)`，紧接着 `ai-stop` / `ai-error` 到达 → `onAiStop`/`onAiError` 里 `clearTimeout(s.timer)` 把排队的 flush 取消 → 尾帧**仍未广播**。缺陷只是从 bridge 窗口位移到 manager 窗口。修复：`onAiStop` / `onAiError` 在清 timer 后、清 `s.text` 前，若 `s.text && s.text !== s.sent` 先调 `flushStream(pid)` 广播未发送的尾帧。
- **rename-profile 缺"本窗口"校验（055 遗留）**：`entry.ts` 的 `rename-profile` 只校验 `ctx` 非空，未校验 `ctx.profileId === profileId`。任一窗口的壳页面可改**任意**窗口名。修复：补 `ctx.profileId !== profileId` 拒绝。
- **bridge timer 触发后未清 pendingText（056 遗留）**：极端场景（timer 刚触发 → 下一次 onStream 之前）stop 会重复 flush 上一段全文。修复：timer 回调里先取出 text、再清 `pendingText`。

### Changed
- **删除 `dataset.raw` 死数据写入**（`src/remote/pwa/app.js`）：全仓无读取点（复制走闭包 `rawText`）；056 已消除流式每帧写入，本版把 finishStreaming/addAi 里各剩的一次也删除。
- **删除 `ensureSigNode` 死代码**（`src/remote/pwa/app.js`）：定义后从未调用。
- **`update-window-name` 加注释说明**：名字统一上限 50 字（与用户重命名一致，由 `profile.ts updateProfileName` 内部 slice 兜底）。

## [0.8.84] - 2026-10-16

### Fixed
- **手机端流式仍残留 O(n²)（053 整改）**：`src/remote/pwa/app.js` 的 `appendStreaming` 每帧把持续增长的 `streamingText` 写入 `streamingEl.dataset.raw`，浏览器须整串 flatten + 序列化 → 单帧 O(n)、累计 O(n²)。`appendChild(createTextNode(delta))` 的优化被这一行抵消。修复：流式期间不写 `dataset.raw`（复制/收尾由 `finishStreaming` 用全量写一次）。
- **手机端 stop/error 丢尾帧（053 整改）**：`src/bridge/remote-bridge.ts` 的 `stopStreamThrottle()` 清了 timer 与 `pendingText` 但未 flush；`onUserStop` / `onAiError` 之后没有全量帧兜底 → 节流窗口内最后 <100ms 的文本永久丢失。修复：新增 `flushText` 参数——stop/error 传 `true` 先 flush 保尾，reply 传 `false`（有全量帧兜底，避免重复）。
- **纯净模式前缀巧合丢字（054 整改）**：`src/ui/harness.html` 的 `_streamRenderedText` / `_streamRenderedThink` 是全局裸变量，未与气泡（body）绑定；中止/新任务新建气泡时若新文本以旧标记为前缀，`delta = full.slice(旧长度)` 会吞掉前缀。修复：增加 `_streamRenderedTextBody` / `_streamRenderedThinkBody` 归属校验（body 换了标记作废），并在 `stop()` / `send()` 显式 `resetStreamRender()` 双保险。
- **纯净模式 stop 后光标残留在思考块**：`clearPendingBubble` 只从 `cur.body` 摘光标，thinkBody 里的漏摘（stop 等不跟 reset 的路径会在思考块留闪烁光标）。修复：`clearPendingBubble` 末尾补 `resetStreamRender()`（统一从实际父节点摘除）。
- **删除已空壳的 `cancelStreamRender`**（054 整改）：全仓无有效调用点，仅 `resetStreamRender` 的别名。

## [0.8.83] - 2026-10-15

### Added
- **窗口列表支持重命名**：窗口卡片悬停/键盘 focus 时显示 ✎ 图标，或点击窗口名进入重命名（复用通用输入弹窗）。主进程新增 `rename-profile` IPC：写入 `profile-list.json`，并同步更新所有活跃窗口的标题与状态栏。名称长度上限 50 字，入口与 `updateProfileName` 双重兜底。
- **手机端 AI 消息尾部签名**：每条 AI 消息末尾固定显示 `✦ Cuckoo`（对齐电脑端前缀），流式期间四角星走星光动画兼作光标；结束帧保持为静态署名。删除旧的 `.cursor` 独占光标。

### Fixed
- **窗口组「添加窗口」下拉深色主题下 option 白底浅字看不清**：`select.ck-input` 补 `color-scheme` 跟随 + option 配色（对齐已有 `.ck-set-input` 的处理）。
- **手机端 AI 消息尾部签名在流式增量时被重复 `querySelectorAll` 扫描**：删除热路径冗余的 `ensureSigNode` 调用（增量只 append 到 streamNode，sig 恒在末位）。
- **改名失败静默无反馈**：`renameProfile` 返回 `success:false` 或抛错时改弹提示，不再"点了确定没反应"。
- **`rename-profile` 未校验 `event.sender` 归属**：补 `windowState.getContextByWebContents(event.sender)` 纵深防御，只允许有窗口上下文的壳页面调用。

## [0.8.82] - 2026-10-15

### Performance
- **纯净对话模式（Harness）流式渲染消除 O(n²)**：此前 onStream 每帧携带「全量正文/思考」，每帧对**全文**执行 `renderMarkdown`（2 次全局正则 + marked.parse + 1 次全局正则）+ `innerHTML` 整棵子树重建，长回复（>2000 字）末端每秒数十次全量解析 → 纯净模式界面卡顿。改为**增量纯文本 append**：非 finished 帧只把新增部分 `appendChild(createTextNode)`，不做 markdown 解析、不重建 DOM；结束帧才全量 `renderMarkdown` 一次（保证收尾正确 + 光标消失）。异常重排（全量不以已渲染为前缀）走清空重来兜底。前缀校验用 `String.prototype.startsWith`（避免每帧 `slice` 分配）。
- **Harness 历史持久化改节流合并**：此前 `pushHist` 每次（每次回复 / 工具 start/end / 系统消息）都对**整个 history 数组**（最多 400 条 × 6000 字符/字段 ≈ 数 MB）做 `JSON.stringify` + `localStorage.setItem`（同步 API），阻塞渲染进程主线程。改为 `scheduleSaveHist()`（500ms 窗口合并），非关键路径（pushHist / 工具 end）走节流；关键路径（会话切换 / 新对话 / 删除消息 / beforeunload）保留立即落盘。

### Fixed
- **Harness 流式增量渲染的 3 处缺陷**（首轮实现审计发现）：
  - **占位三点残留**：增量 append 不会自动覆盖 pending-dots 占位，首个 think/text 到达时显式移除。
  - **光标残留 thinkBody**：finished 帧只覆盖 `cur.body`、不触及 `thinkBody`，共享光标节点会残留在思考体里闪烁；`resetStreamRender` 现在会真正从 DOM 移除光标。
  - **跨轮标记未复位**：终态为 `assistant` / `tool 收尾` 时不走 finished 分支，`_streamRenderedText/_streamRenderedThink` 带入下一轮；`onAssistantDone` 及无 cur 分支补 `resetStreamRender()`。

## [0.8.81] - 2026-10-15

### Performance
- **远程手机端流式链路消除 O(n²)**：此前手机远程对话的流式推送与渲染全线按「全量覆盖」设计，长回复（>2000 字）下性能随文本长度平方级放大——电脑端每 100ms 广播**整个累积文本**（总出站量 ≈ L·M/2，经 Cloudflare 隧道带宽被放大数十倍），手机端每帧对**全文**执行 `markdown 解析 + XSS 消毒 + innerHTML 整棵子树重建`，卡顿、发烫、光标闪烁。本次改为**增量协议**：
  - **主进程（`src/remote/manager.ts`）**：流式广播由全量 `text` 改为 `delta` + `reset` 标记（`StreamState` 新增 `sent` 字段记录已发送文本；以 `startsWith` 判断可增量则发新增部分，否则 `reset=true` 发全文让手机端重来）。
  - **手机端（`src/remote/pwa/app.js`）**：流式期间改为**纯文本增量追加**（`appendChild(createTextNode(delta))`），不再每帧 markdown 解析 + DOM 重建；结束帧（`ai-reply`）才用全量做一次 markdown 渲染 + 代码块装饰。流式期间为纯文本、结束时补齐样式，是性能换体验的明确取舍。
  - **bridge（`src/bridge/remote-bridge.ts`）**：`onStream` 回调加 ~100ms 节流，避免每个 token 事件都对全文跑 `stripBlocks`（6 次正则）占满 AI 页面主线程。
- **serveStatic 异步化（`src/remote/server.ts`）**：PWA 静态资源改 `fs.promises.stat/readFile`，不再用 `readFileSync` 阻塞 Electron 主进程事件循环。

### Fixed
- **远程流式幽灵帧致手机端气泡卡死**：bridge 侧流式节流定时器在终帧（reply/stop/error）到达时未清理，节流窗口内排队的最后一帧会在终帧之后上报 → 主进程误判新一轮 `ai-start` → 手机端产生僵尸气泡且发送按钮永久禁用。修复：三个终帧回调入口统一调用 `stopStreamThrottle()`，并让手机端 `ai-start` 先移除可能残留的旧流式气泡。

## [0.8.80] - 2026-10-15

### Added
- **窗口切换迁移携带目标/计划**：窗口组（多账号限流轮换）限流自动切换 / 手动转移对话时，harness 状态迁移原只带「对话历史 + 待发队列」，源窗口的**目标（goal）**、**计划模式状态（planState）**、**计划步骤（planTodos）** 会因目标窗口是新分享会话（新 sessionId）而丢失，导致切换后 `/goal` 或 `/plan` 的自动推进直接断掉。本次把这三项（含 `goalNoProgress` 无进展计数）一并纳入迁移，切换后自动推进无缝接续。
- **窗口页「默认打开」行为提示**：窗口列表底部新增提示——勾选了「默认打开」时显示「勾选的窗口会在启动时自动打开。」，未勾选任何项时显示「未勾选任何『默认打开』时，启动会打开最后活跃的窗口。」，消除对启动打开哪个窗口的歧义。

### Fixed
- **`resetConversation` 漏清流式气泡适配变量 `cur`**：新对话重置时未把 `cur` 归零，与 `toolSeq` 等流式态处理不一致。已补齐（原先测试靠源码窗口溢出"假通过"，本次显式修复）。

## [0.8.79] - 2026-10-14

### Fixed
- **F12 开发者工具被原生视图覆盖/布局错乱**：全部 4 处 F12 快捷键（壳页面、AI 页面、harness 视图、工具窗口）此前用 `toggleDevTools()`（默认 docked 嵌入窗口内）。本应用是「壳页面 + 多个原生 WebContentsView 叠加」架构，docked DevTools 渲染在壳页面区域内会被上层原生视图盖住，且与 `layoutView()` 的 `setBounds` 强制重排冲突。改为 `openDevTools({ mode: 'detach' })` 独立窗口打开（再按 F12 关闭）。"查看"菜单的"开发者工具"项同样从 `role: 'toggleDevTools'` 改为自定义 detach 逻辑。

## [0.8.78] - 2026-10-14

### Fixed
- **工具窗口（openBrowserWindow）无法登录 Google/Gemini**：工具窗口只设了 UA，缺 Google OAuth 必需的两项修正 → `navigator.userAgentData.brands` 不含 "Google Chrome" 品牌、`sec-ch-ua*` 请求头未改写，Google 判定"浏览器或应用不安全"拒绝登录。修复：新增工具窗口专用 preload（`src/app/browser-preload.ts`）向主世界注入 `buildUserAgentDataFix()`，并在 `browser-window-manager.ts` 的 session 层补齐 `sec-ch-ua*` 请求头，与主窗口 AI 视图行为对齐。

## [0.8.77] - 2026-10-14

### Added
- **活动栏溢出菜单**：主区（`_spacer` 之前）图标超过 14 个时，只显示前 13 个 + 一个「⋯」按钮，其余收进 **hover 悬浮弹框**（点弹框内图标可切 tab）。底部固定区（关于/飞书/设置）不受影响。

### Fixed
- **新挂载图标落到底部区**：`applyActivitybarOrder` 把未在持久化 order 里的新图标追加到**整体末尾**（`_spacer` 之后 = 底部固定区），改为插到 `_spacer` **之前**（主区末尾）。
- **MutationObserver 自激死循环**：溢出重算改 DOM 会触发自身 observer → 无限递归卡死渲染进程。改为「disconnect → 改 → observe」+ 合并到 drag 的 observer 串行调用。

## [0.8.76] - 2026-10-14

### Fixed
- **活动栏拖拽图标「跑到底部」**：`moveDrag` 只遍历 `.ck-ab-item`（不含 `_spacer`），拖到底部时会插到 `settings` 之后 → 越过 `_spacer` 进入底部固定区。修复：拖拽限制在 `_spacer` 之前的主区；`_spacer` 之后（关于/飞书/设置）不可拖拽。`normalizeSpacer` 同步强化为「主区项 + `_spacer` + 底部固定项」三段式归一，自动修好已存错的旧数据。

## [0.8.75] - 2026-10-14

### Fixed
- 复查修正（v0.8.74 性能改动）：`git-unstage-all` 的回退正则补全 `Failed to resolve`/`bad revision`（真机实测空仓库 `git reset` 可用，此回退为防御性兜底）；`entry.ts` 注释的倒计时从「3s」更正为「6s」。

## [0.8.74] - 2026-10-14

### Performance
- **全部暂存/取消暂存改批量 IPC**：原来 `doBulk` 逐个文件 `await gitStage`（几百文件 = 几百次 IPC + git 进程）。改为 `git-stage-all`（`git add -A`）/ `git-unstage-all`（`git reset`）各一条命令。
- **Git 面板刷新加在途合并**：watcher 高频事件（批量保存/构建）原来直接 `loadGit`，会叠加多个并发 git 进程。新增 `loadGitCoalesced`（in-flight 守卫 + 队列）。
- **文件树事件委托**：`bindRowEvents` 原来逐行 `addEventListener`（上限 5000 节点 → 单次渲染上万监听器，折叠/搜索每次重建）。改为容器上绑一次委托。
- **文件树构建异步化**：`buildFileTree` 由 `fs.readdirSync` 同步递归改为 `fs.promises.readdir` + 同层 `Promise.all` 并发，不再阻塞主进程事件循环。
- **git watcher 噪声目录补全**：`isNoisePath` 增加 `wyp`/`release`/`dist-verify`/`.playwright-mcp`/`.turbo`/`target`/`__pycache__`/`.venv`，避免这些目录高频写盘触发无意义的 git status。

### Changed
- **限流自动切换倒计时 3s → 6s**（给用户更充裕的取消时间）。

## [0.8.73] - 2026-10-14

### Fixed
- **活动栏拖拽排序后底部三项不沉底**：`applyActivitybarOrder` 恢复顺序时强制把 `_spacer` 挪到末尾，导致其后无元素 → 「关于/飞书/设置」不再沉底（与主区图标挤在一起）。改为 `_spacer` 按其在 order 中的位置排列；并加 `normalizeSpacer` 迁移已存错的旧数据（把末尾的 `_spacer` 归位到第一个底部固定项之前）。

## [0.8.72] - 2026-10-14

### Fixed
- **窗口组切换状态迁移的时序缺陷（复查发现）**：目标窗口 `session-changed` 事件在 view 导航时发出，但 harness 页面此时可能尚未加载完（监听器未注册）→ 事件丢失 → 导入状态永远卡在 pending。修复：`harness-ready` 时**补发当前会话**（`session-changed`），确保导入能应用到正确 sid。
- **限流连续触发导致并发/双切换**：429 会连续触发多次 `rate-limit-hit` → 并发倒计时 + 重复切换。新增 `switchingProfiles` 守卫，同一窗口同一时刻只处理一次。
- **`loadURL` 失败时 onLoad 监听残留**：目标窗口后续再触发 `did-finish-load` 会误跑 `initProject` + 状态迁移。修复：失败分支 `twc.off('did-finish-load', onLoad)`。

### Performance
- **导出 harness 状态去掉冗余深拷贝**：`exportHarnessState` 直接返回引用（`ipcRenderer.send` 本就会结构化克隆），大历史省一次全量 `JSON.stringify` 深拷贝。

## [0.8.71] - 2026-10-14

### Added
- **窗口组限流冷却缓存（方案 A）**：`window-groups.json` 新增 `rateLimits` 字段，记录每个窗口最近限流时间戳（冷却 5 分钟）。切换时**先查缓存跳过冷却中窗口**，不必发消息探测——消灭垃圾探测对话，退避从最坏 N×70s 降到秒级；探测到限流立即写缓存，一轮内不重复探测。

### Fixed
- **关源窗口前置校验**：限流自动切换时，等目标窗口 `initProject` 成功才关闭源窗口；失败/超时（60s）则**保留源窗口**，避免「目标没接上、源已关」导致对话真丢。
- 探测失败**仅「真限流」写缓存**（超时/错误不写），避免误伤只是加载慢的正常窗口。
- 删除窗口时清理其限流缓存记录。

## [0.8.70] - 2026-10-14

### Added
- **窗口组切换状态迁移（无缝接续）**：切换前导出源窗口 harness 状态（历史 + 待发队列），经主进程中转推给目标窗口重建——解决切换后「对话导航丢失」「待发队列丢失」。源窗口处于纯净模式时，目标窗口也自动进入纯净模式。
- **限流自动切换 3s 倒计时弹框**：账号限流触发的自动切换，先弹可见倒计时（可取消），不再突兀跳转；手动切换不加倒计时。

### Changed
- **diff 配色再微调**：深色 diff 底色 `#0a0c0f`→`#050608`（更暗），新增 `--ck-diff-code` 变量让代码文字更醒目（浅色 `#0b0e14` / 深色 `#f8fafc`）。

## [0.8.69] - 2026-10-14

### Changed
- **提交详情 diff 清晰度提升**（对齐 GitHub/Codex 风格）：增删行加**左侧 3px 实心色条**（增绿 `#3fb950` / 删红 `#f85149`），背景由 `0.12` 提到 `0.16`——此前纯透明背景叠在极暗底色上几乎看不出色相、没有边界，观感模糊。
- diff 行号列：行号色 `--text-dim`→`--text-2`（更可读），两行号列间加 1px 分割线（双栏感更清晰）。

## [0.8.68] - 2026-10-14

### Changed
- **提交详情 diff 配色再调**：增删行高亮背景更浅（`0.22`→`0.12`），文字加重（增行 `#7ee787`、删行 `#ffa198` + `font-weight:600`），提升可读性。

### Added
- **提交详情「回到顶部」按钮**：diff 滚动超过一屏时右下角显示，点击平滑回顶；滚回顶部自动隐藏。

## [0.8.67] - 2026-10-14

### Added
- **`npm run dev` 开发实例启动**：`start.js` 支持 `--dev`（独立 userData `cuckoo-dev-verify` + 调试端口 9444），与正在用的打包版（占单实例锁）隔离、可同时运行，方便本地开发调试。

### Changed
- **harness 文字对比度微调**：助手正文由主文字色改为次要色（`--text`→`--text-2`，稍暗不刺眼）；工具调用卡片文字提亮（工具名 `--text-2`→`--text`、参数 `--text-dim`→`--text-2`、输出 `--text-2`→`--text`）。

## [0.8.66] - 2026-10-14

### Fixed
- **回归修复（v0.8.59 引入）**：`layoutView` 里新增的 `view.setVisible(aiVisible)` 只认 `__ckWebviewHidden`/harness 两个标志，会**覆盖 modal-guard 对 AI 视图的隐藏**——普通模态框（确认框/各页弹窗/看图）打开期间任意 resize/move 会把 AI 原生视图抢显、盖住模态框。新增独立标志 `__ckAiHidden`（由 modal-guard 的 `plugin-set-webview-visible` 维护），`layoutView` 的可见性统一考虑三方来源（浮层/modal/harness）。
- **回归修复**：`#git-diff-modal` 带 `ck-modal-mask` 类，命中了 modal-guard → 在纯净模式下关闭 diff 弹框时，modal-guard 会把 AI 视图抢显、盖住 harness。modal-guard 排除 `#git-diff-modal`（该弹框由 git.ts 的 `setWebviewHidden` 单独处理，能同时隐藏 AI/harness/overlay）。
- **`parseDiff` 误判内容行**：hunk 内的 `--- `/`+++ ` 判定未限定在文件头区，导致内容行 `-- foo`（实为 `--- foo`）被当噪音丢弃、`++ foo`（实为 `+++ foo`）被当文件路径污染。改为仅在 `!hunk` 时按文件头处理，hunk 内只按首字符解析。
- **harness 流式节流切会话滚动副作用**：`cancelStreamRender` 未复位 `_streamRenderPending`，且 `_doStreamRender` 末尾无条件 `scrollBottom`——挂起的 rAF 在切会话后仍触发多余滚动。改为 pending 一并复位、滚动仅在实际渲染时执行。
- **`__ckWebviewHidden` 残留**：弹框打开期间壳页面重载会导致 AI 区永久隐藏。壳页面 `did-finish-load` 时复位 `__ckWebviewHidden`/`__ckAiHidden`。

## [0.8.65] - 2026-10-14

### Fixed
- **源代码管理徽标不及时更新**：`onGitChanged` 里 `if (!isGitPanelActive()) return` 把徽标更新也门控了——在**非 git 页面**时 git 有改动，活动栏徽标数字不刷新。改为：面板未激活时也拉一次 `gitStatus` 只更新徽标数字。

### Changed
- **深色主题对比度提升**：背景整体加深（`--ck-bg` `#16181d`→`#0e1014`、`--ck-bg-sub`→`#14161b`），文字提亮（`--ck-text` `#e4e6eb`→`#eef1f6`、`--ck-text-2`→`#c0c6d2`、`--ck-text-dim`→`#8a90a0`），边框/交互底色相应增强。harness 与壳页面（含工作区页）同步生效，解决"雾蒙蒙看不清"。

## [0.8.64] - 2026-10-14

### Changed
- **提交详情 diff 配色调整**：正文底色改用更深的专用色（`--ck-diff-bg`，浅色 `#f0f1f4` / 深色 `#0d0f13`），增删行背景透明度加深（16% → 22%），增删文字调亮（绿 `#3fb950→#56d364`、红 `#f0656a→#ff7b83`）。文字更突出、代码对比更强。

## [0.8.63] - 2026-10-14

### Changed
- **提交详情 diff 结构化展示**：原先是 `git show` 原始输出逐行着色（commit hash / index / `@@` 记号都显示，看不懂）。改为解析成结构化数据后渲染：顶部**摘要卡**（提交信息 + 短 hash + 作者 + `+N −M · X 个文件`）、**文件列表**（每文件增删统计，可点击跳转）、正文**双列行号 + `+/−` 符号**，并丢弃 commit/index/`---`/`+++` 等内部噪音行。
- **对比度修正**：diff 正文改用主文字色（原用次要灰 `--ck-text-2` 发虚）、行号去掉叠加的 `opacity`、增删行背景加深，解决"雾蒙蒙看不清"。

## [0.8.62] - 2026-10-14

### Fixed
- **installer 测试间歇性失败**：`installPlugin: 不残留临时目录` 断言扫描整个 `os.tmpdir()`，被历史中断运行留下的同名目录误伤（`installer.ts` 的 `finally` 本身会正常清理）。改为基线对比，只断言"本次安装"不新增残留。

## [0.8.61] - 2026-10-14

### Performance
- **harness 流式渲染 O(n²)**：`onStream` 每帧携带全量正文，原实现逐帧对全量跑 `renderMarkdown`（marked + KaTeX 全解析）+ `innerHTML` 重建，长回复累计 O(n²)。改为对非 finished 帧用 `requestAnimationFrame` 合并（同一帧多次只渲染最后一次），finished 帧仍立即渲染保证收尾无延迟。

## [0.8.60] - 2026-10-13

### Performance
- **token 统计同步 IO 放大**：每次 AI 上报 token（`update-token-usage`）会触发 1 次写 + 8 次读整个 `token-stats.json`，全同步阻塞主进程。给 `token-stats.ts` 加内存缓存（读命中不再读盘、写时同步缓存），一次上报的磁盘 IO 降为最多 1 次写。保持原有同步并发语义；写盘失败时使缓存失效，避免内存/磁盘不一致。
- **流式 stripToolBlocks O(n²)**：`stripToolBlocks` 在 `onStream` 每帧对全量正文跑 3 个正则，长回复下累积开销显著。加无围栏快速路径（`indexOf('```') === -1` 时跳过正则，与正则路径严格等价），并删除一处冗余 `.trim()`。

## [0.8.59] - 2026-10-13

### Changed
- **提交历史默认展开**：进入源代码管理页即加载并展示提交历史（原先需手动点一下）。
- **提交详情弹框放大为全窗口浮层**：原先弹框局限在左侧抽屉内、偏小。改为覆盖整个窗口的浮层（最大 1100px×85vh），并在打开时临时隐藏 AI/harness 原生视图（原生视图永远盖在壳页面之上，不隐藏则浮层右侧被遮挡；用 setVisible + setBounds 双保险，与 harness 切换同款）。
- **复制 diff 不再弹二次确认框**：改为按钮文字短暂反馈（已复制/复制失败）。

## [0.8.58] - 2026-10-13

### Fixed
- **提交详情对 merge commit 不显示 diff**：`git show --patch` 对 merge commit 默认只输出文件列表、不含 patch，点开 merge 提交看不到具体改动。改用 `git show -m --first-parent`——merge 显示（相对第一父的）完整 diff，普通 commit 行为不变（实测等价），且不产生重复的多份 diff。

## [0.8.57] - 2026-10-13

### Added
- **提交详情查看完整 diff**（源代码管理页）：点提交历史条目，弹出专用弹框展示该提交的完整 diff（diffstat + patch）。等宽字体、可滚动，patch 着色（`+` 绿 / `-` 红 / `@@` 蓝 / 文件头加粗），支持「复制 diff」。新增 IPC `git-show-commit-diff`（输出超 512KB 截断并提示）。替代原先只弹 `--stat` 原始纯文本的 `ckAlert`。

## [0.8.56] - 2026-10-13

### Fixed
- **后台任务表无界增长（内存泄漏）**：task-manager 的 tasks Map 在任务退出后不自动清理，仅靠用户手动「清除已退出」，长期运行 + 高频命令会累积数 MB~数十 MB。新增 pruneExited()（保留最近 50 条已退出历史，运行中不动），在进程退出 / 停止兜底 / dispose 三处自动修剪。
- **规则注入缓存无界增长（内存泄漏）**：rules/injection 的 injected Map 按会话累积且 clearSession 从未被调用，随对话数无限增长。新增会话数上限（100），超限淘汰最早条目（最坏仅导致规则全文重注入一次，语义无损）。

### Performance
- **后台任务输出裁剪 O(n²) → O(n)**：appendOutput 原实现逐字符对前缀调用 Buffer.byteLength，大块输出超限时累计 O(drop²)，可卡主线程数百 ms。改为单次遍历累加 UTF-8 字节数，并按 UTF-16 码点边界前进（不切坏代理对）。顺带修正截断前缀未计入 outputBytes 的不变量偏差。

### Added
- 新增 test/infra/task-manager.test.js：覆盖超长输出环形裁剪、多字节/代理对裁剪边界（不切出孤立代理）、未知任务、运行中任务不可移除。

## [0.8.55] - 2026-10-13

### Changed
- **hover 展开延迟 0.4s → 0.3s**：悬停后延迟 0.3s 再展开详情（用户要求）。

### Fixed
- **移除误提交的临时文件** `tmp-cdp.mjs`（v0.8.54 误将 CDP 调试脚本纳入版本控制）。

## [0.8.54] - 2026-10-13

### Changed
- **hover 过渡再放慢到 1s**：列表卡片详情展开/收起 0.6s → **1s**（用户要求更缓）。
- **hover 展开加 0.4s 延迟**：悬停后延迟 0.4s 才展开详情，快速划过不误触发（收起仍即时/按过渡时长）。

## [0.8.53] - 2026-10-13

### Changed
- **hover 过渡再放慢**：列表卡片（技能 / 子代理 / MCP / 窗口 / 提示词）详情展开/收起时长 0.4s → **0.6s**，观感更缓和平滑。

## [0.8.52] - 2026-10-13

### Fixed
- **列表卡片 hover 抖动**：技能 / 子代理 / MCP / 窗口 / 提示词 / 快照等卡片，悬停展开详情用 `display:none` 瞬切（展开有 0.38s 动画、收起瞬间跳变），快速划过会抖动。改为 `max-height` + `opacity` + `margin-top` **对称过渡**，进出都平滑；负 margin 抵消父容器 gap，折叠时零占位。

### Changed
- **hover 过渡放慢**：列表卡片详情展开/收起时长 0.38s → **0.4s**，观感更平滑。
- **tooltip 出现延迟放慢**：首次悬停 120ms → **300ms**（避免划过误弹），连贯巡视模式 20ms → 120ms。

## [0.8.51] - 2026-10-13

### Fixed
- **任务列表状态不自动刷新**（停止后一直显示「停止中…」，需手点刷新）：`src/app/ipc/task.ts` 的 `broadcastChange()` 里 `!ctx.win.isDestroyed` **漏了括号**（`isDestroyed` 是方法，未调用恒为 falsy）→ 条件永远为 false → 任务变更通知 `shell-tasks-changed` **从未推送**。影响**所有状态**（启动/输出/停止/退出/stopping），不止"停止中"。补括号 + 加 webContents 销毁检查。此 bug 自 v0.8.42 任务页上线即存在。

## [0.8.50] - 2026-10-13

### Fixed
- **规则页保存提示撑坏布局**：保存成功后直接改保存按钮的 `textContent` 显示「已保存 · 新对话生效」，但该按钮是 **icon-only**（固定 30px、仅含 SVG）——改 textContent 会**摧毁 SVG 图标**，且长文本在 30px 内竖排换行撑坏按钮行。改为在按钮所在 flex 行末尾临时插入一个 `<span class="ck-rule-saved-tip">`（绿色 + 入场动画），2 秒后移除；按钮本身始终完好。

## [0.8.49] - 2026-10-13

### Fixed
- **更新门禁可能锁死新版本（子代理审查发现，严重）**：`checkForUpdates` 在"已下载完成"分支调用 `installAndRestart()` **未传版本号** → 标记 `targetVersion` 为空 → 更新成功、新版本首次启动时判定"未完成"被拦截，最长锁死 10 分钟。修法：
  - `update-downloaded` 记录 `downloadedVersion`，`installAndRestart` 统一带上目标版本；
  - 标记新增 `fromVersion`（安装前版本），`isUpdatePending` 判定改为「版本已变/已达目标/数据不完整」都放行——即使 target 缺失也不会锁死；
  - 标记改原子写（临时文件 + rename），避免崩溃残留半截 JSON。
- **任务停止兜底路径显示「退出码 undefined」**：`stop()` 的兜底超时与 `!pid` 分支只置 `exited`，未设 `exitCode`、未清 `stopping` → UI 显示「退出码 undefined」。补 `exitCode ?? null` + 清 `stopping`；渲染层 `exitCode == null` 也归为「已结束」。
- **任务页 expanded 无界累积**：「清空已结束」后未裁剪 `expanded` Map，长会话下累积。清空后按当前任务 id 裁剪。

### Changed
- **update-pending 判定语义升级**：从"当前版本 === 目标版本"改为"当前版本 != 安装前版本 或 已达目标 或 数据不完整"即放行，更稳（防 target 缺失锁死）。

## [0.8.48] - 2026-10-13

### Changed
- **运行任务后滚动定位到刚运行的任务**：原「运行后滚动到面板底部」在任务多时看到的是**最旧**的任务（列表新任务在顶部），看不到刚运行任务的执行过程。改为 `scrollIntoView` 定位到**新任务卡片**（`block:'start'`），配合已有的自动展开输出，一眼看到执行过程。

## [0.8.47] - 2026-10-13

### Fixed
- **任务输出残留 ANSI 彩色控制码**：跑 `npm test`、`vitest` 等彩色输出的命令时，任务输出里会显示 `[90m`、`[2m`、`[22m` 等乱码（实为 `\x1b[90m` 等 ANSI 转义序列，ESC 字符不可见后被吞）。根源：`decodeOutput` 只做 GBK/UTF-8 解码，不剥控制码。新增 `stripAnsi()`：剥离 CSI/OSC/单字符三类转义序列，在 `decodeOutput` 统一调用（UTF-8 与 GBK 分支都走）。任务页输出、bash/pwsh 工具、命令 IPC 全部受益。

## [0.8.46] - 2026-10-13

### Fixed
- **任务页「停止」按钮卡在「停止中…」**：点击停止后按钮一直不恢复。原因是渲染层手动改按钮 DOM，但列表按签名去重、进程真退出前不重建 → 按钮停在手动态。改为把 `stopping` 纳入 `TaskInfo` + 渲染签名，停止态由主进程单一来源驱动，进程退出后自动恢复为「已结束」。
- **更新安装期间可重复启动旧 exe**：静默安装窗口期（应用已退出、文件正被替换）用户若再次双击旧图标，会与安装程序争用文件锁，可能导致安装失败/版本混乱。新增「更新进行中」标记文件：安装前写入目标版本，启动时若当前版本仍低于目标且标记未过期（10 分钟）则提示并退出；更新完成或超时自动清理放行。

### Changed
- **运行命令/脚本后自动滚动到任务列表**：任务页运行后平滑滚动容器到底部，直接看到任务运行状态（此前任务列表在页面下方需手动滚动）。

## [0.8.45] - 2026-10-13

### Changed
- **Token 页「今日全窗口」「预估费用」高亮**：两行数值改为斜体放大 + 琥珀色，行背景加琥珀渐变，与普通统计行区分，一眼可见（深色主题同步适配）。

## [0.8.44] - 2026-10-13

### Fixed
- **自动更新仍弹 NSIS 安装向导**：`quitAndInstall()` 未传参，默认 `isSilent=false` → 更新时弹出安装向导（"为哪位用户安装"）。改为 `quitAndInstall(true, true)`：传 `/S` 给 NSIS 跳过向导 + 装完自动重启。三处调用（手动/自动检查、下载完成）统一修复。
- **规则页保存无反馈**：保存成功后按钮短暂显示「已保存 · 新对话生效」，提示用户规则改动在新对话才注入（当前对话不重发系统提示词）。

## [0.8.43] - 2026-10-13

### Fixed
- **任务输出中文乱码**：任务管理器用 `buf.toString('utf-8')` 解码，但中文 Windows 的 cmd 输出是 GBK → 中文变「�」。改用项目既有的 `decodeOutput`（UTF-8 优先、乱码则回退 GBK），与 bash 工具一致。

## [0.8.42] - 2026-10-13

### Fixed
- **任务页 scripts 折叠失效**：折叠/展开用了未定义的 `ck-hidden` 类（项目全局隐藏类是 `cuckoo-hidden`）→ 点击无反应。改用 `cuckoo-hidden`；折叠箭头改用 CSS 三角类（原来往里写文字无效）。
- **scripts 按钮跑不起来**：原先直接执行 script 的 `command` 值（如 `vite`），依赖 `node_modules/.bin` 的命令会找不到可执行文件。改为执行 `npm run <name>`。
- **任务输出默认收起、需手动点开**：现在运行任务后**自动展开输出**（scripts 与手动命令均如此）。

## [0.8.41] - 2026-10-13

### Changed
- **柱图恢复按天展示**：Token 页柱图改回「近 10 日趋势」，但数值为**全窗口**每日总量（不分窗口），并保留合计/日均/峰值。
- **预估费用改为按「今日全窗口」**：原先按本窗口今日，现按所有窗口今日总消耗估算。
- **自动更新一键化**：启动检测到新版本 → 弹窗询问「立即更新 / 稍后」；选「立即更新」则**自动下载 + 下载完自动重启安装**（不再二次询问）；选「稍后」不下载。

### Added
- **每日全窗口快照**：主进程 `token-stats.json` 新增 `__daily__` 记录每日全窗口总量，供柱图趋势展示（兼容旧格式）。

## [0.8.40] - 2026-10-13

### Added
- **「今日全窗口」统计**：Token 页新增全局今日消耗（此前只有「本窗口今日」和「全局历史」，缺全局今日维度）。
- **柱图改为按窗口展示今日用量**：Token 页柱状图从「本窗口近 10 天趋势」改为「各窗口今日用量对比」，含窗口名；点击看该窗口今日占比 + 历史累计。

### Changed
- **Token 页命名消歧**：「今日窗口」→「今日本窗口」，「窗口累计」→「本窗口历史累计」（原先两个都带"窗口"但一个说时间、一个说范围，易混）。

## [0.8.39] - 2026-10-13

### Added
- **任务页（命令 / scripts / AI 后台命令统一管理）**：壳页面新增「任务」页——手动输入命令后台运行、一键运行当前项目 `package.json` 的 scripts、实时查看输出、一键停止。
- **AI 后台命令**：`bash` 工具新增 `background` 参数，长驻命令（dev server / watch 等）后台启动、立即返回任务 ID，不再阻塞对话，可在「任务」页查看/停止。

### Fixed
- **停止任务残留子进程**：`stop` 原先抢先 `child.kill()` 杀掉父进程，导致异步的 `taskkill /T` 找不到子进程树 → 子进程残留。改为只走 `taskkill /T /F`（连带整棵进程树），实测子进程被正确杀掉。

### Performance
- **任务列表防闪屏**：高频输出时列表签名未变则不重建 DOM，只增量刷新已展开任务的输出。

## [0.8.38] - 2026-10-13

### Fixed
- **纯净模式空白回复气泡**：`clearPendingBubble` 删除条件要求"必须有三点 dots"才整块移除，但经 `onStream` 创建的占位气泡本就不含 dots → 漏删，残留空白气泡。改为"无思考、无正文即整块移除"，不再依赖 dots。

## [0.8.37] - 2026-10-13

### Fixed
- **提交详情乱码**：`git-show-commit` 的 format 用了 `%x1f`（ASCII 31 控制字符），返回时未拆分 → 显示成"□"。改用 `%n` 换行分隔，详情可读。

## [0.8.36] - 2026-10-13

### Changed
- **规则编辑自动滚动到编辑区**：点击"编辑/新建规则"后，面板自动滚动到下方编辑区（上方是格式说明，此前需手动下滑）。

## [0.8.35] - 2026-10-13

### Fixed
- **Git 提交历史闪烁**：历史列表展开后随自动刷新反复清空重绘 → 现内容签名未变则跳过重绘；非首次加载不再显示"加载中…"。

### Added
- **项目文件「全部折叠」按钮**：一键收起文件树所有展开目录。

### Changed
- **图标按钮悬停不再旋转**：移除 `.ck-icon-btn:hover svg` 的 360° 旋转动画。
- **工具栏图标间距收窄**：`.ck-actions` gap 由 8px 收至 4px（全局各页统一）。

## [0.8.34] - 2026-10-13

### Added
- **规则页格式说明**：用户级规则页顶部补充 frontmatter 格式示例（`name` + 可选 `paths`），并说明兼容 Cursor 写法（`trigger: always_on` / `globs`）。

## [0.8.33] - 2026-10-13

### Changed
- **项目规则目录统一到 `.agents/rules/`**（需求 036）：项目级规则扫描改为**优先 `.agents/rules/`，回退 `.cuckoo/rules/`**（兼容旧项目）。一份规则可同时供 Cuckoo Code 与 Codex/Cursor 等工具使用。
- **兼容 Cursor 规则格式**：无 `paths` 时自动回退解析 `trigger`/`globs`（`globs` 逗号分隔转多路径；`trigger: always_on` 视为始终注入）。实测某 Cursor 项目：始终注入 17→4，按需注入 0→14。
- **内置默认全局规则**：首次启动时若用户级规则目录为空，写入 `~/.cuckoo/rules/global-default.md`（通用开发协议）；用户已有规则则不覆盖；带 seed 标记防"删除后复活"。
- **规则页说明**：新增"本页 = 用户级全局规则；项目专属规则放 `.agents/rules/`"提示。

## [0.8.32] - 2026-10-13

### Added
- **Git 面板·提交历史**（需求 035）：文件列表下方新增「提交历史」折叠区，懒加载最近 60 条提交（短 hash / 信息 / 作者 / 相对时间），点某次提交查看其改动统计。
- **Git 面板·自动刷新**（需求 035）：监听项目目录变化（fs.watch 递归 + 400ms 防抖 + 噪声目录过滤），仅在 Git 面板激活时刷新，文件变化/暂存/提交近实时反映。
- **工作区「全部收起」按钮**：一键收起所有项目组、对话子节点与归档区。

### Fixed
- **工作区悬停双提示**：项目组标题去掉原生 `title`，消除与自定义悬停卡片重复弹出的两个提示（子项溢出提示保留）。

## [0.8.31] - 2026-10-13

### Fixed
- **F12 打不开开发者工具**：此前 F12 仅绑在 AI 页面，焦点在壳页面/纯净模式时无效；且未判断 keyDown，导致"按下开、抬起关"看似没反应。现三端（壳页面 / AI 页面 / 纯净模式）均可按 F12 开关各自 DevTools，且只在 keyDown 触发。
- **工具浏览器窗口 F12 无反应**：`openBrowserWindow` 打开的窗口此前未绑 DevTools 快捷键，现支持 F12 打开控制台。

## [0.8.30] - 2026-10-13

### Fixed
- **纯净模式字号放大不再挤出输入框**：CSS `zoom` 作用域从 `documentElement` 收窄到 `.app` 容器，并用 `calc(100vw/zoom)`/`calc(100vh/zoom)` 反向补偿尺寸。此前 zoom 连 `100vh` 一起放大，底部输入框被挤出视口；同时 zoom 不再影响 tooltip / 会话导航等 `.app` 外的 fixed 元素定位。
- **设置页「刷新」恢复全部设置**：此前只重读"失败重试"设置，漏了纯净模式字号与主题；现刷新同时重读三者。
- **修复设置页刷新按钮的监听器泄漏**：拆分 `refreshThemeValue`（取值）与 `initThemeListener`（注册），避免每次刷新重复注册 `onThemeChanged` 监听器。

### Changed
- **下载更新不再频繁弹系统通知**：移除"下载中"每 3 秒一次的系统通知（状态栏进度条已实时展示，足够）；"开始下载"/"下载完成"等一次性通知保留。

## [0.8.29] - 2026-10-13

### Fixed
- **纯净模式字号不再模糊**：此前用 `webContents.setZoomFactor`（视图缩放），非整数倍（115%/126%/150%）会把已光栅化的位图插值放大 → 文字模糊。改用 CSS `zoom`（布局缩放），元素按新尺寸重新布局与光栅化 → 任意倍率均清晰。

## [0.8.28] - 2026-10-12

### Changed
- **窗口组切换提示恢复系统通知**：应用内 toast 在壳页面右上角，会被 AI WebContentsView 盖住（Electron 层级限制，CSS z-index 跨 WebContentsView 无效）——实测手动转移/自动切换都看不到提示。系统通知为主通道（任何情况可见），toast 保留为辅助。
- **手动「转移对话」也关闭源窗口**：此前仅限流自动切换关源窗口，手动转移保留。现两者都关（等焦点切到目标窗口后延迟 1.5s 关闭），提示附「源窗口已关闭」。
- **纯净模式「特大」字号 130% → 126%**。

## [0.8.27] - 2026-10-12

### Added
- **记忆编辑支持多行文本框**：编辑/新建记忆改用多行 textarea（Enter 换行，Ctrl/Cmd+Enter 提交，Esc 取消）；其它单行输入弹窗（重命名等）不受影响。

### Fixed
- **修复窗口组「转移对话」报错**（需求 034）：此前总是报「IndexedDB 无该会话消息」。根因是切换直接读 IDB，而 DeepSeek 同会话内不更新 IDB、仅刷新才补齐；压缩能正常正因它走了刷新。现让切换复刻压缩/截断流程：清 IDB → 刷新 → 等 hook 重建 → 全量分享 → 回执。超时放宽至 90s。
- **修复切前台偶发 harness 空白**：窗口最小化恢复（restore）与从后台切回（focus）时补重排（layoutView）。此前这两条路径不触发重排，WebContentsView 偶发不重绘，需手动缩放/拖宽才恢复。

## [0.8.26] - 2026-10-12

### Changed
- **更新进度条更醒目**：状态栏下载进度条加高（6→10px）、加宽（60→100px）、加渐变发光，百分比用主题色高亮，"更新中"标签加粗。

## [0.8.25] - 2026-10-12

### Changed
- **窗口组切换提示改为仅应用内 toast**：移除系统通知（切换后焦点已跳到目标 Cuckoo 窗口，用户面前必有壳页面，弹系统通知属多余打扰）。提示仍含原因、来源 → 目标、结果。

## [0.8.24] - 2026-10-12

### Added
- **窗口组切换提示**（需求 033）：窗口组切换时弹系统通知 + 应用内 toast，显示**原因**（账号限流自动切换 / 手动转移对话）、**来源 → 目标窗口**、**结果**（成功 / 失败含原因）。此前切换全程无提示，用户不知发生了什么。

## [0.8.23] - 2026-10-12

### Fixed
- **窗口偶发空白**（需求 032）：窗口偶尔内容不显示，缩放或拖动左侧宽度才恢复。根因：Electron `WebContentsView` 首次显示常需重新 `setBounds` 才渲染，而重排只在创建/resize/move 时触发。补齐 `ready-to-show`/`show`/各 `did-finish-load` 重排 + 兜底延时重排；`resize`/`move` 用 16ms 定时器合并防高频重排。
- **活动栏拖拽 observer 抖动**（029 审计）：`applyActivitybarOrder` 此前每次 DOM 变化都重排（即使顺序已正确），改为"顺序一致则不碰 DOM"，消除无谓重排。

## [0.8.22] - 2026-10-12

### Added
- **纯净模式字号缩放**（需求 031）：设置页新增「纯净模式字号」选择（85% / 100% / 115% / 130% / 150%）。用 Electron `setZoomFactor` 等比缩放整个纯净模式视图（正文/代码/标题协调联动），持久化到 `~/.cuckoo/ui-prefs.json`，切换即时生效。

## [0.8.21] - 2026-10-12

### Fixed
- **自动更新下载进度可见**（需求 030）：此前下载新版本时看不到任何进度，只在完成后弹"是否安装"。原因：进度提示是系统通知且条件苛刻（仅手动检查 + 整 10%，进度跳变会跳过）。现在**状态栏显示实时进度条**（百分比 + 填充条），完成/失败后停留 4 秒隐藏；系统通知改为 3 秒节流。

## [0.8.20] - 2026-10-12

### Added
- **活动栏图标拖拽排序**（需求 029）：鼠标拖动左侧活动栏图标即可调整顺序，顺序持久化（重开记住）。兼容插件动态挂载的图标（自动按保存顺序重排）；拖拽后抑制误点击，不影响 tab 切换。

## [0.8.19] - 2026-10-12

### Added
- **记忆功能内置化**（需求 027）：把记忆管理界面从易变的第三方插件改为**内置页**。活动栏新增「记忆」图标，支持列表/新建/编辑/删除。记忆核心数据（`~/.cuckoo/memories.json`）与 `remember` 工具共享，跨会话保留。
- **Git 面板分支支持**（需求 028）：源代码管理面板顶部显示当前分支，点击可展开本地分支列表切换；切换前检测未提交改动，有则二次确认。

### Changed
- **自定义弹框挂到 window**：`ckPrompt`/`ckConfirm`/`ckAlert` 暴露给插件与内置脚本（Electron 禁用原生 `prompt`，插件需用这套）。
- **禁用 cuckoo-memory 插件**：记忆内置后，插件形态与之冲突，予以禁用。
- **关于页文案修正**："已禁用原版在线更新" → "支持插件系统与自动更新"（与实际行为一致）。

## [0.8.18] - 2026-10-12

### Added
- **源代码管理面板（Git）**：活动栏新增独立图标（分支形状 + 改动数角标）。支持查看更改/已暂存分组、暂存（+）、取消暂存（−）、撤销工作区改动（↩，二次确认）、删除未跟踪文件（🗑）、提交（Ctrl+Enter）。点击文件跳转文件页预览 diff。
- **侧栏最小宽度放宽**：拖拽调整侧栏宽度下限从 360px 降到 240px（含主进程拖拽 clamp 与三处阈值统一）。

### Changed
- **Git 提交框样式**：输入框与提交按钮等高（34px）、同圆角（8px），去掉胶囊圆角与超宽按钮。
- **对话入口隐藏**：活动栏「对话」图标暂时注释（用户要求）。
- **CI 发布**：`make_latest` 改为 `true`，tag 发布自动标为 Latest（electron-updater 更新检查走 `/releases/latest`）。

### Fixed
- **Git 面板多处边界**：未跟踪文件改用「删除」（`git restore` 对 `??` 无效）；首次提交前 unstage 回退 `git rm --cached`；提交按钮区分"已暂存"组；中文文件名八进制乱码（`-c core.quotepath=false` + 反解义）。
- **对话导航 tooltip 命中区**：收起态 dot 仅 3px 高，鼠标易划过打断 tooltip；加透明伪元素扩到 ~11px 高。

## [0.8.17] - 2026-10-12

### Fixed
- **快照列表排序不稳定**：修复 `listSnapshots` 在 CI 上偶发失败（同毫秒创建的快照顺序颠倒）。根因：`createdAt` 在文件复制完成后才记录，受复制耗时抖动影响。改为创建开始时记录时间戳，并在同毫秒时按 id 降序兜底，保证顺序确定。
- **文件树行操作按钮 hover 提示**：去掉目录/文件行操作图标（新建文件/新建文件夹/重命名/删除/@）的原生 tooltip。

### Changed
- **仓库地址迁移**：`package.json`（含 electron-builder publish owner）、`README`、关于页链接、`release.bat` 全部指向新仓库 `Huo-zai-feng-lang-li/cuckoo-code`。

## [0.8.16] - 2026-10-12

### Fixed
- **通知点击打不开窗口**：修复 AI 任务完成通知点击"偶尔无反应"。三个根因：① `Notification` 对象无引用被 GC 导致 click 不触发（改为持有引用 + 上限防泄漏）；② 点击用弹通知时捕获的旧窗口引用，窗口关闭后直接 return（改为点击时按 profileId 动态重查窗口，三级兜底）；③ 前台激活弱（Windows 前台锁定），改为临时置顶抢焦点。

## [0.8.15] - 2026-10-12

### Added
- **纯净模式真截断**：消息气泡「从此处截断重发」从假截断（只清本地 DOM/localStorage，网页真实会话不动）升级为真截断——用 DeepSeek share API 复制「到该条为止」的新会话，只保留截断点之前的历史，再在新会话中发送编辑后的消息。复用窗口组迁移/压缩的成熟机制（两段式：清 IDB + 刷新 → 刷新后读 IDB 截取 → createShare → 导航激活）。失败全程兜底（回退原会话 / 超时清理 / pending 落地 localStorage 防重载丢失）。
- **元面板图表增强**：顶部汇总（近 10 日合计/日均/峰值）、条尾数值、今日高亮、点击某日看详情（消耗/占比/较日均）。
- **预估费用**：按 DeepSeek Flash 单价粗估今日用量费用，自动区分闲时/高峰；各指标加 `!` 说明图标（悬停显示口径，含「今日窗口/各轮累计」多行示例）。
- **文件管理增强**：文件新建/重命名/删除（回收站，可恢复）；git diff 对比 + 冲突三选一查看差异 + diff 时隐藏树；弹框换行；顶部「新建文件/文件夹」入口。

### Changed
- **元面板指标改名消歧**：「当前上下文」→「本轮上下文」，「对话累计」→「各轮累计」（原命名易被误认为「累计即上下文占用」，实为各轮完整历史之和）。

### Fixed
- **纯净模式与原版叠加**：body 改不透明底 + 隐藏 AI 视图时 bounds 归零（修纯净模式视图残留）。

## [0.8.14] - 2026-10-12

### Added
- **文件预览自动刷新**：预览中的文件被外部修改时自动更新；若本地有未保存编辑则弹框二选一（加载新版 / 保留本地），不丢数据；忽略自身保存触发的变更。

### Fixed
- **纯净模式消息收尾**：气泡收尾改按 DOM 真实内容判定（修"仅思考/仅工具回合"三点残留）；消息截断重发去掉冗余确认弹框；清理死函数。

## [0.8.13] - 2026-10-12

### Added
- **纯净模式发送队列**：运行中 Enter 自动入队（不再丢弃）；任务结束自动发下一条；单条可编辑/立即发送/移出；支持附件。
- **纯净模式右侧对话导航**：收起态为横线、悬停展开摘要面板；点击快速滚动定位、当前项高亮。
- **全局自定义 Tooltip**：拦截原生 title，磨砂样式 + 快捷键徽标 + 边界防溢出；仅"图标型按钮"或"内容被溢出裁剪"时才弹。
- **项目文件可编辑保存**：文件预览支持就地编辑（Monaco），Ctrl+S/保存按钮落盘（原子写入），未保存切换/关闭时拦截确认。
- **工作区/会话删除**：会话与项目工作区支持删除（二次确认，仅移除记录不动磁盘文件）。
- **底栏「最近」快捷方式直接发送**：点击技能/MCP/子代理快捷项回显后直接发出。
- **post-commit 钩子**：提交后自动 push 当前分支到 origin。

### Changed
- 关闭窗口去掉二次确认弹框（直接关闭）。
- 队列项与目标编辑统一为多行文本域（保留换行，Ctrl+Enter 提交）。
- AI 视图宽度改用 getContentSize（修复窗口 resize 后右侧留白）。
- 纯净模式输入区/内容区放开 780px 限制，铺满宽度。

### Fixed
- **网页模式点"停止" → 同步纯净模式收尾**（此前纯净模式会卡在"运行中"）。
- 对话导航快速滚动连点竞态（令牌取消旧动画）。
- 发送失败时上报状态并复位 task-idle（分享页/页面加载中兜底）。
- tooltip：纯图标菜单（如"元"）应显示提示；导航点仅文本溢出才弹。

### Performance
- 对话导航滚动高亮改 rAF 节流（消除每次 scroll 的 O(N) reflow）。
- tooltip isClipped 提前返回 + 测量探针复用（减少重复遍历与 DOM 操作）。
- 对话导航点击改自定义快速滚动（180ms 缓动）。

## [0.8.12] - 2026-10-12

### Added
- **插件市场完整版**：curated 目录 + 封面图 + 分类 + 详情弹窗；收藏/备注/分组；后台自动更新（一键更新 + 开关）；图片全屏查看；上架引导。
- **记忆系统 + 工作快照**：抽为独立插件（cuckoo-memory / cuckoo-snapshot）。
- **子代理升级为真 agent**：进度可见 + 并行委派；新增 5 个子代理。
- **ai-gateway 网关插件**：改用独立隐藏窗口 + 流式思考；侧边栏"整活模式"。
- 全局规则管理页；渲染进程插件支持注入系统提示词。

### Changed
- 插件面板融合进市场（活动栏只留一个入口）；插件卸载与热重载、侧边栏加宽；无图标插件用标题首字。
- JsRunner 长任务判定增强；提示词段卸载清理。

### Fixed
- 限流窗口自动关闭；窗口组跳过忙碌窗口。
- 停止按钮真杀子代理（执行阶段可取消）。
- 恢复主题/系统浏览器按钮 + 纯净模式"最近"回显 + 通知点击聚焦。
- 插件冲突 / 图片被挡 / 市场不更新 三个真机 bug。
- 网关窗口堆积导致后续请求无响应。
- 禁用并检测 DSML/XML 工具调用格式。

## [0.8.11] - 2026-10-11

### Added
- **DSH 插件兼容（C1–C6 全接真）**：Cuckoo 里可直接**安装/运行 DSH 插件**（npm 包，原样不改），
  不依赖任何 DSH 代码（自己实现 `@deepseek-ai/*` 同名 API）。含 `ctx.settings/tools/sessions`（C1）、
  最小 DSH 运行时（C2）、事件总线（C3）、`systemPrompt/fs/agents`（C4）、会话落盘 JSONL + 重放（C5）、
  `skills/commands/goals/compaction/workspaceFiles/sessionTitle/tokenMeter`（C6）。需求档案 022。
- **可执行插件运行时（对标 DSH）**：函数/对象/类三种插件形态、5 种事件派发
  （emit/parallel/serial/bail/waterfall）、服务 provide/inject、可逆副作用（effect/scope）、
  资源（assets）、工具注册（tools.register）、agents/sessions 核心映射、插件配置（config schema）。
- **主题系统（对标 DSH ui-theme）**：`ctx.theme`（register / overrideTokens / setTheme / getTheme / list +
  theme/change 事件）；主进程权威 + 渲染进程 IPC 代理；`--ck-*` token 体系；自绘标题栏；设置页「外观」分区；
  主题持久化；AI 页面跟随系统主题（nativeTheme，不侵入 AI 页面）。
- **UI 原子能力**：`ctx.ui.overlay`（覆盖层）、`ctx.ui.shell`（壳页面挂载）、`ctx.ui.slot`（通用槽位）、
  `ctx.ui.shell.addStyle`（注入壳页面 CSS）、`ctx.ui.setWebViewVisible`、`ctx.ui.setWindowMaterial`。
- **纯净模式集成**：透明 harness 视图 + `harness/change` 事件。
- **ChatGPT 登录态完整适配**：回复拦截三态化、SSE 裸 `{v:[...]}` 帧解析修复、
  `fillInput`（execCommand）+ `triggerSend`（真实 Enter）、Google OAuth 指纹修正。（@yangjh888，PR #47）
- 插件开发文档（`docs/plugin-system.md` / `docs/plugin-dev.md`）、示例插件与模板、单元测试。

### Changed
- 地址栏改为可切换按钮（默认隐藏，地球图标）；纯净模式切换键改「净」/「原」字；mac 红绿灯兼容（hiddenInset）。
- 关闭窗口前弹框确认（删除窗口等程序主动关闭除外）。
- 项目目录选择框默认打开上次的目录（全局记忆，跨对话/窗口）。

### Fixed
- **ChatGPT**：`extractSessionId` 只认完整 UUID —— 修复中间态 `local-chatgpt` 被当真实会话 ID，
  导致初始化后 GPT 拿不到项目目录。
- 文件树按自然序排列（v0.8.10 排在 v0.8.9 之后）；清除源码中字面 NUL 字节。

## [0.8.10] - 2026-10-06

### Added
- **文件预览（Monaco Editor）**：侧栏「文件」页点文件在树右侧查看内容（VSCode 同款：行号 + 语法高亮），不遮挡 AI；左条改树宽、右条改侧栏总宽；切走 tab/收起临时隐藏、切回恢复、✕ 真关闭。
- **输出速度（TPS）**：状态栏实时显示模型输出速度（DeepSeek 用服务端精确 token，ChatGPT/Claude 估算）。
- **插件 `scripts/` 贡献类型**：按 URL 匹配向网页主世界注入脚本，可作用于内置平台。
- **Gitee 插件市场**：支持 Gitee 源（检索/下载/清单），与 GitHub 并行。
- **provider `transformToolResult` 钩子**：provider 可在工具结果回传前自定义文本格式。
- **webFetch SSRF 防护（设置开关）**：新增「网络安全」→「拒绝访问内网/本地地址」，默认关闭。
- **飞书 Markdown 卡片**：AI 回复改用交互卡片渲染 Markdown（含表格）。

### Fixed
- **危险命令检测**：修复复合命令（`&&` `||` `;` `|` `&`）绕过检测；统一真相源 + 补变体。
- **glob**：未指定 path 时默认排除 `node_modules` 等产物目录；结果附"被忽略目录"提示。
- **子代理**：修复豆包等 contenteditable 平台卡在"发送任务提示词"（填充后校验 + 失败重试）。
- **设置保存**：修复报"目标最大迭代次数必须是正整数"。
- **webFetch SSRF**：不拦 `198.18.0.0/15`（代理 fake-ip 段），避免公网域名被误判。
- **文件预览**：修复侧栏越开越宽（基础宽用稳定存储值 + clamp 75% + AI 至少留 300px）。

## [0.8.9] - 2026-10-05

### Added
- **窗口组（多账号限流轮换）**：把多个窗口（账号）编成一组；遇"操作频繁"限流时**自动把当前对话转移到组内下一个账号继续**。
  - 手动「转移对话」按钮 + 限流自动触发，**共用同一链路**（停止 → 全量分享 → 探测轮换 → 导航 → 初始化 → 焦点切换）。
  - 切换前**逐个探测**目标账号是否也被限流（新开对话发测试消息）；组内都不可用则**退回原账号继续重试**。
  - 组管理：改名、增删组内窗口；组内「最近」可点击跳到最近一次继续的窗口与对话。
- **MCP 配置与使用文档**（docs/mcp.md）+ README 中英加链接。

### Fixed
- 窗口页顶部按钮改两行（新建窗口 + 刷新 / 新建窗口组），修复刷新按钮被挤掉。

## [0.8.8] - 2026-10-04

### Added
- 插件市场、项目文件树、会话血缘（子代理/压缩历史分组）、地址栏新建对话按钮、KaTeX 公式渲染。

### Changed
- 子代理复用父 profileId；侧边栏可拖拽调宽；DeepSeek 限流文案检测。

### Fixed
- **纯净模式：对话流空白 + 状态永久卡在运行中**（根因定位后重做）：此前 bridge 的上报受"纯净模式开关"
  门控，一旦门控判断错（AI 页面导航/重载重建 preload 丢广播、查询通道失败、切换时序竞态），
  流式文字、回复正文、工具卡片、终态信号会被**整体静默丢弃**——界面只剩主进程直推的那条框架投递，
  于是既没有内容、状态又永远收不了尾（实测截图：只有一个转圈的占位气泡 + 停止键）。
  现在：
  - **删除上报门控**（不再给门控打补丁，直接消除"判断错一次就整片哑掉"这个性质）；
    主进程在没有纯净模式视图时自会丢弃事件，代价只是多几次 IPC
  - **新增权威生成状态心跳 `ai-state`**：AI 页面维护"是否正在生成"（由 hook 事件驱动），
    变化即时上报 + 每 2 秒心跳；纯净模式据此校正运行态，判定"已停止且静默 ≥6 秒"即收尾
    （含清零工具计数，兼治 `tool-end` 丢失导致的永久卡死）
  - 清理配套死代码：`harness-mode` 下发与 `harness-is-enabled` 查询通道
- **纯净模式：网页答完仍显示"运行中"**：收尾此前全靠超时猜，容忍度被放得过大
  （框架驱动窗口内直接跳过兜底 + 之后 5 分钟保持运行态档），任何一次框架投递都能把状态钉住数分钟；
  `tool-end` 还会无条件重新置忙，收尾事件一丢就回不来。现改用**权威终态信号**：
  `observer` 判定"回复无工具调用 = 本轮结束"时派发的 `task-idle` 现在上报给纯净模式，收到即收尾，
  不再依赖超时；兜底回归"只兜事件丢失"且有界（框架窗口 120 秒 / 窗口外 60 秒即复位）；
  `tool-end` 不再无条件置忙。
- **纯净模式：页面导航后上报静默失效（网页在回复、界面却停在"就绪"）**：`harness-bridge` 的纯净模式
  门控只在切换那一刻下发一次，AI 页面每次导航（如首次对话后从首页跳到 `?cid=...` 会话页）或刷新
  都会重建 preload，门控回到 `false`，导致上报被静默丢弃。
  *（注：该问题最初靠"启动主动查询 + 导航重发门控"缓解，随后确认这是治标——门控本身就是失败点，
  已改为彻底删除门控，见上方第一条。保留的有效改动：系统提示词投递另由主进程直推，不经 AI 页面 bridge。）*
- **静默兜底不再"猜结束"**：原「12 秒无事件即重置为就绪」会在模型首个 token 延迟较久时
  （超长系统提示词、长思考）把正在回复的会话显示成"就绪"。现在结束判定交给权威信号 `task-idle`，
  兜底只负责"事件丢失"这一种异常，且有界（框架窗口 120 秒 / 窗口外静默 60 秒即复位）。
- **纯净模式下框架自动消息无状态反馈**：系统提示词、工具结果回传（JS汇总）、看门狗催继续、失败重试、
  上下文压缩等由框架自动发往 AI 页面的消息，此前 harness 页面完全不知情——界面停在「就绪」、
  发送键还是箭头，用户会往正在跑的会话里插话。现在这些投递会在状态栏显示来源（如「框架：工具结果回传」）、
  把发送键切为停止态并阻止插话；**消息内容仍不进对话流**（底层指令本就不该显示），只反馈运行态。
  - `chat-input` 新增 `onMessageDelivered` 投递回调（所有 `sendToChat` 投递，含系统内部消息）；
    系统提示词走独立路径，也在投递点补派发
  - `onStream` 补兜底：正在出字但未收到投递事件时同样置忙
  - 静默兜底收尾改用 `clearPendingBubble()`，不再残留永远转圈的占位气泡

### Changed
- **目标（/goal）改为工具调用收束**：新增 `goalDone()` 工具，AI 在目标全部完成后调用它结束自动推进；
  主进程直接向纯净对话视图推送 goal-done 事件（复用 todoWrite 的主进程推送模式）。
  废弃旧版"回复末尾输出 `[[GOAL_DONE]]` 文本标记"约定——文本标记靠模型自律，漏输出则目标永不收束，
  只能靠无进展兜底停表；工具调用是结构化动作，界面有卡片留痕，bridge 不再检测文本标记。

### Added
- **goalDone 工具**（任务管理类）：无参数，仅在目标的所有要求确实完成后调用；未开纯净模式或缺少窗口
  上下文时返回明确错误，不误伤普通对话（普通对话调用它只会得到一条错误回执）。

## [0.8.7] - 2026-10-02

### Added
- **侧边栏「工作区」页**：按项目目录分组列出所有对话。
  - 组内按时间倒序；当前项目默认展开；点对话直接跳转。
  - 悬停对话 → **重命名** / **归档**按钮；悬停项目 → **新建对话** / **归档项目**按钮。
  - 悬停项目名 → 信息卡片（完整路径 + 创建时间）。
  - 已归档对话 / 已归档项目分别折叠（列表底部「已归档 N 项目」）。
  - **新建对话**：用指定项目直接开新对话（自动选好项目 + 发初始化提示词，不弹目录框）。
- **AI 自动给对话命名**：新增 `nameConversation(title)` 工具，AI 在对话开始时自动命名；
  标题持久化（旧数据兼容），工作区列表实时刷新。支持会话 ID 未生成时暂存标题、待绑定。
- **侧边栏「子代理」页**：列出（用户级/项目级）/ 新建（生成模板 + 打开编辑）/ 改名 / 删除。
- **底部状态栏**：显示当前对话上下文 token。
- **最近使用快捷工具**：底部状态栏彩色标签（技能/MCP/子代理/提示词，最多 5 条，点击效果同卡片，localStorage 持久化）。
- **纯净对话模式增强**：
  - 地址栏新增「纯净模式 / 原版模式」切换按钮（无需记快捷键）。
  - 支持**跟随系统深浅色**（浅色/深色两套），不再固定深色。
  - Markdown 渲染改用 **marked**（GFM：标题/表格/链接/引用/有序列表/任务列表等）。
  - 首页未初始化项目时，输入区替换为大虚线按钮「首次对话需选择项目目录」（点击复用初始化逻辑）。
- **自定义 Provider 开发模板**：`templates/provider-dev/`（README + 模板 + 2 示例）。

### Changed
- **壳页面源码重构（内部）**：`shell.html` 拆分为 `src/ui/shell/`（HTML/CSS/TS 模块），
  构建期生成 `shell.html`（新增 `scripts/build-shell.mjs`，接入 `npm run compile`，pre-commit 自动重建）。
- **Windows 只产出 NSIS 安装版**：去掉 zip / portable 目标（它们**无法自动更新**，导致自动更新失效）。
- **用户代理（UA）动态化**：取真实内核版本，修复写死旧版本与真实版本矛盾（改善 Google 登录）。

### Fixed
- **空回复重试**：AI 回复正文为空时判为失败并触发普通失败重试（DeepSeek/Claude/ChatGPT 统一）。
- **webFetch**：改为先全文转 Markdown 再截断（修复 Bing 等头部脚本多的网站只返回标题）。
- **提示词页一直"加载中"**：修复 API 名写错（`getSnippets`→`listSnippets`）。
- **底部状态栏被 AI 网页盖住**：修复 `getContentSize()` 多算菜单栏高度导致 view 偏高（改为壳页面上报真实尺寸）。
- **子代理残留存储文件**：子代理 sessionStore 改内存态（不落盘），并启动清理历史遗留的 `session-dir-map-subagent-*.json`。
- **工作区对话操作按钮**：改绝对定位（覆盖时间位置），修复悬停后按钮占额外空间导致文字换行/右凸。
- **飞书**：未调用工具的 AI 回复末尾附注「（本次AI没有调用任何工具）」。

> 提示词版本：本次**已变更**（新增工具 `nameConversation`，改了工具定义与提示词 section）。
> 用户若被 AI 提醒"提示词版本需 +1"，属预期。

## [0.8.6] - 2026-09-30

### Fixed
- **新对话页初始化提示不显示**：修复重构后 `updateHomeMode` 仍依赖已删除的 `#cuckoo-overlay` 元素，
  导致"首次创建对话需初始化项目"的提示框永不弹出（新对话页/未选项目时）。
- **自动压缩与工具循环抢输入框**：自动压缩改为**在"任务空闲"（工具循环结束、AI 给出普通文本回复）时**触发，
  避免摘要指令被随后回填的工具结果覆盖，导致摘要根本没发出去。

> 提示词版本：本次**未变更**（仅修复，未改 `src/prompt/*` 与工具定义）。

## [0.8.5] - 2026-09-30

### Added
- **纯净对话模式（Harness，类 Codex 体验）**：同一窗口内切换到纯对话界面（AI 网页退居后台）——
  只显示用户消息 / 模型回复 / 工具调用卡片，隐藏系统提示词、工具结果回传、格式纠正等底层指令。
  - 入口：`Ctrl+Shift+H` / 菜单「查看 → 纯净对话模式」/ 页面内「网页模式」按钮
  - 流式输出 + 思考过程折叠；工具卡片（成功自动折叠）
  - **Goal（/goal 目标）**：自动多轮推进（无工具调用时 3 秒后"继续推进"）、`[[GOAL_DONE]]` 结束标记、15 轮上限、手动停止
  - **Plan**：复用 todoWrite，顶部可折叠计划面板（三态 + 进度条）
  - 斜杠菜单（↑↓ 导航 / Enter 选中 / 按输入过滤）
  - Claude Code 风格 UI（暖色强调、深色极简、内联 SVG 图标）
  - **性能**：harness 视图懒加载（不用纯净模式零开销）+ bridge 上报门控
- **飞书同步（手机收发对话）**：把 Cuckoo 的对话同步到手机飞书，并可从飞书发消息给 AI。
  - **每个窗口绑定一个飞书群**（跟 profile 持久化，多窗口消息互不干扰）
  - 推送：用户消息 / AI 回复（剥离工具代码块）/ 工具调用状态（默认不带工具名，保护隐私）
  - 接收：群消息（可直接发，无需 @）→ 送到绑定该群的窗口发给 AI
  - 连接：飞书官方 SDK 长连接（无需公网 IP）
  - 侧边栏新增「飞书」页（手机图标）：凭证、启停、群绑定、推送选项
  - **内置图文配置教程**（应用内窗口打开，离线可用）
- **飞书单元测试**：config 读写 / profile 群绑定 / 工具代码块剥离（19 用例）。

### Changed
- **快捷提示词改为追加**：点击提示词时**追加**到输入框现有内容后（不再覆盖已输入的内容）。

### Fixed
- 飞书推送选项改为独立「保存推送设置」按钮（原先必须点「保存并连接」才生效）。

### Docs
- README 致谢补充：@27584 的纯净对话模式贡献（PR #22）。

> 提示词版本：本次**未变更**（018/019 未改 `src/prompt/*` 与工具定义）。

## [0.8.4] - 2026-09-30

### Changed
- **卡片悬停圆角动画**：窗口 / 提示词 / 技能 / MCP 四个列表的卡片，默认直角，鼠标悬停时平滑过渡为圆角 + 浅底色。
- **平台选择页精简**：新建窗口时（尚未选平台），隐藏侧边栏、项目选择器、地址栏，平台选择页铺满整个窗口。

### Removed
- 删除冗余的 GitHub Actions workflow（.github/workflows/build.yml，master push 触发且一直失败；发版只用 release.yml）。

## [0.8.3] - 2026-09-30

### Added
- **全新侧边栏 UI（重大重构）**：从"AI 页面内注入的悬浮面板"改为 **VS Code 风格的独立侧边栏**（地址栏下方、AI 页面左侧）。含 7 个页面：
  - **提示词**：快捷提示词管理（增/删/改，点击填入输入框 + 可选自动发送）
  - **技能**：列出技能（按用户级/项目级分组），点击追加"请使用 xx 技能"
  - **MCP（连接器）**：列出 server（按用户级/项目级分组，含连接状态/类型/工具数），点击追加"请使用 xx 这个 MCP"
  - **窗口**：窗口列表（新建/切换/删除/默认打开）
  - **Token**：当前上下文 + 4 项统计 + 自动压缩设置 + 近 10 日用量柱状图
  - **设置**：失败重试 / 发送延迟 / 附件间隔（直接编辑，无需弹窗）
  - **关于**：版本号 / 检查更新 / 开源地址 / QQ 群
- **快捷提示词（Snippets）**：用户级 `~/.cuckoo/snippets.json`，首次内置 3 条，之后完全自定义。
- **地址栏项目选择器**：最左显示当前项目目录，点击重选目录并重新初始化。
- **活动栏可收起**：点击激活图标收起，启动默认收起。
- **通用弹框**：替代所有原生 alert/confirm，跟随系统深浅色。
- **深浅色跟随系统**。

### Changed
- **废弃旧注入面板 + 悬浮球**：仅保留「工具执行遮罩」和「首次对话引导框」。
- **工具执行遮罩**：改为页面顶部提示条（不遮挡内容），阻止点击但允许滚动。
- 侧边栏卡片、按钮统一为无边框 + 分隔线风格；长按钮改为胶囊形。

### Fixed
- **设置项「操作频繁重试间隔/次数」取值失败**：字段映射修正。

### Removed
- 旧注入面板、窗口管理弹窗、MCP 弹窗、设置弹窗、右下角悬浮球。
- 地址栏下方的 token 状态条（数据已移至侧边栏 Token 页）。

### Docs
- 新增 [UI 设计规范](docs/ui-design.md)。

## [0.8.2] - 2026-09-29

### Added
- **Rules（规则，对齐 Claude Code）**：`.cuckoo/rules/*.md`（项目级）+ `~/.cuckoo/rules/*.md`（用户级）。
  - **有 `paths`** 的规则 → 只在 AI **读匹配文件**时注入（首次全文，之后仅名字+路径；按会话去重）
  - **无 `paths`** 的规则 → 初始化时注入「## 项目规则」章节（始终适用）
  - `paths` 匹配用 picomatch（支持 `**`/`*`/`{}`）
- **自带 uv/node 运行时**：打包内置 uv（含 uvx）+ node（含 npx），MCP 配置里 `command: "uvx"`/`"npx"` 直接可用，
  **无需用户自己装**。uvx 首次运行会自动下载 Python + 包。不碰用户系统（仅子进程级 PATH 注入）。
- **MCP 面板显示 server 来源**（项目级/用户级）。

### Fixed
- **MCP UI JSON 编辑框只管用户级**：避免把项目级配置误写进全局。
- **发送延迟取消 10 秒上限**：设置里的发送延迟最大值不再限制 10 秒。

### Docs
- 新增 [Rules 配置与使用](docs/rules.md)；README 加 Rules 章节。
- 项目自带 6 条规则（infra/overlay/tools/hooks/bridge/test）。

### CI
- 缓存并下载自带运行时（uv/node），避免每次构建重复下载。

## [0.8.1] - 2026-09-28

### Added
- **MCP 项目级 + 用户级配置（对齐 Claude Code）**：
  - 用户级 `~/.cuckoo/mcp.json`（所有项目可用）+ 项目级 `<项目>/.cuckoo/mcp.json`（仅本项目）
  - 同名 server **项目级覆盖用户级**；启用状态分两级存储
  - 首次启动自动把旧 `userData/mcp.json` 迁移到 `~/.cuckoo/mcp.json`（旧文件保留）
- **MCP 连接池 + 引用计数**：用户级 server 全局共享（跨项目一个进程）、项目级按项目隔离；
  窗口关闭/切换项目时释放引用；引用归零后空闲 60 秒断开。
- **MCP 面板显示 server 来源**（项目级/用户级）；JSON 编辑框只管用户级（避免项目级混入）。
- **项目目录确定后异步自动连接 MCP**（不阻塞窗口，覆盖会话恢复场景）。

### Fixed
- **「今日窗口」token 口径修正（v3）**：改为累加**当轮完整 acc**（今天每轮总量之和），跨天归零。
  旧数据自动迁移清空。
- **压缩「摘要成功却判失败」**：DeepSeek 有时不发 FINISHED 帧，正文已完整生成却被判 error，
  导致压缩等不到完成、120 秒超时。现「无 FINISHED 但有正文」视为正常完成。
- **测试污染真实用户目录**：MCP 测试改用 `CUCKOO_HOME` 环境变量隔离（此前会写入真实 `~/.cuckoo`）。
- **发送延迟取消 10 秒上限**：设置里的发送延迟最大值不再限制 10 秒。
- hello 技能 description 末尾句号（避免与 when_to_use 拼出「。；」）。

### Docs
- `.cuckoo/mcp.json` / `.cuckoo/mcp-state.json` 加入 .gitignore（本地运行时配置）。
- 新增 MCP 连接池引用计数测试（9 个）。

## [0.8.0] - 2026-09-27

### Added
- **子代理（Subagents，对齐 Claude Code）**：主对话可把任务**委派**给独立上下文的子代理，
  只回摘要——既隔离上下文（缓解长对话卡顿），又支持专门化 + 工具限制。
  代理是带 frontmatter 的 Markdown 文件（`.cuckoo/agents/` 项目级 + `~/.cuckoo/agents/` 用户级），
  支持 `name`/`description`/`tools`/`maxTurns` 字段；用 `runAgent(name, task)` 调用。
  子代理在独立窗口（共享登录态）中执行，完成判定为"无工具调用"。
- **8 个开箱即用代理**：用户级 `explore`（只读探索）/ `code-reviewer`（代码审查）/
  `test-runner`（跑测试+根因）；项目级 `arch-guard` / `tool-smith` / `build-doctor` /
  `req-writer` / `hook-surgeon`。
- **「刷新技能与代理」按钮**：对话已开始时，点一下重新扫描技能/代理目录并把最新清单发给 AI
  （解决"对话开始后新增 agent 不生效"）。
- **token 状态条支持「亿」单位**：≥1 亿显示 `X.XX亿`；「今日窗口」调整到「窗口累计」前面。
- **Skill / Agent 配置文档**（`docs/skills.md` / `docs/agents.md`）+ README 引用（中英文）。

### Fixed
- **「今日窗口」口径修正**：改为累加**当天新增**（delta），跨天归零；子代理不计入。
  旧口径（累加完整上下文，会膨胀）数据自动迁移清空。
- **系统总累计虚高**：子代理窗口共享父窗口 partition，其上报会重复计入；现子代理跳过上报，
  并忽略/清理历史遗留键。
- **代理扫描健壮性**：空 `name`（纯空白）兜底为文件名；`maxTurns` 改为严格整数解析（`Number()` + 上界 1000）。
- 子代理窗口在新对话页被 home-mode 隐藏面板 → 现抑制首页模式，正常显示完整面板。
- 子代理窗口 `return` 跳过了拦截监听器初始化 → 现照常启动。

### Docs
- 新增 `docs/skills.md`、`docs/agents.md`；README（中英文）加 Skill / Agent 两节。
- backlog 记录：Claude Code subagents / Agent Skills 未实现功能对照、dsh 的 Skill 显式调用机制、压缩刷新慢诊断。

## [0.7.1] - 2026-09-25

### Fixed
- **「发送skill信息」等按钮误报「已发送」**：4 处调用 `sendToChat` 时漏了 `await`，
  导致即使没发出也弹"已发送"。涉及按钮：发送skill信息、卡住了?点我、沉浸式交流、生成文档。
  修复后会如实提示失败。
- **MCP 使用提示改为通用「先查后用」强制流程**（删除硬编码的 playwright 提示）：
  调用任何 MCP 工具前必须先 `mcpGetTools` 查参数，对所有 server 通用。

### Added
- **地址栏下方状态条**：显示当前对话的累计 token 量（地址栏与 AI 页面之间）。
  （注：此功能真机待验证）

### Docs
- 新增工具调用错误分析（第 1 批）+ 日志归档记录。

## [0.7.0] - 2026-09-25

### Added
- **Skill 支持（对齐 Claude Code）**：纯文件驱动、无复杂界面。用户把技能写成
  `SKILL.md`（带 name/description 元数据）放到 `.cuckoo/skills/`（项目级）或
  `~/.cuckoo/skills/`（用户级），AI 按需加载执行。支持技能附带脚本（用现有 bash/pwsh 运行）。
  设置面板新增「发送skill信息」按钮可刷新技能清单。目录改为 `.cuckoo/`（兼容读旧 `.cuckooCode/`）。
- **窗口默认打开（多选）+ 记录大小位置**：窗口管理面板可为每个窗口勾选「默认」，
  启动时自动打开所有勾选的窗口（一个都没勾则回退上次活跃窗口）。
  关闭窗口时记录其大小、位置、（是否最大化）与最后访问的 URL，下次按记录恢复。
- **沙箱内可用 sleep / setTimeout**：AI 在 cuckoo 代码块里可直接 `await sleep(ms)`
  或 `new Promise(r => setTimeout(r, ms))`（如等页面加载、等操作生效）。

### Changed
- **换行符处理对齐 dsh（LF 归一化）**：编辑文件时读入归一化为 LF 匹配，写回恢复原风格；
  混合换行文件被规整为主导格式。替换旧方案（三级候选匹配）。
- **MCP 使用提示改为通用「先查后用」强制流程**：调用任何 MCP 工具前必须先
  `mcpGetTools` 查清参数，避免凭记忆猜参数导致失败（不硬编码任何具体 server）。
- **工具描述优化**：edit 强调跨行连续文本 + 注意空白缩进。
- **技能 / MCP 章节加引导语**：AI 可提示用户安装所需技能 / MCP。

### Fixed
- **压缩「不成对」修复**：长会话（含重新生成/编辑分支）压缩时，`share/create`
  报 MESSAGES_MUST_APPEAR_IN_PAIRS。改为沿 `parent_id` 回溯主对话链取消息。
- **设置面板无滚动条**：内容超出被 overflow:hidden 裁掉，现支持滚动。
- **glob/grep 空路径容错**：传空字符串/空白不再报错，视为"未提供"（用项目根）。

### Dev
- **工具失败日志（仅开发版）**：工具调用失败单独记到 `userData/wyp/log/tool-errors/<工具名>.log`，
  按工具分文件、长期保留，便于事后分析。

## [0.6.1] - 2026-09-23

### Added
- **启动恢复最后活跃窗口**：记住上次最后使用的窗口，重启后自动打开它（列表顺序不变）
- **工具遮罩「停止」按钮**：工具执行完等待回传时，可点击停止取消发送（待发内容保留在输入框）
- **限流自动重试**：DeepSeek 返回"操作过于频繁"（HTTP 429 / 业务码 40029）时，
  按"操作频繁"策略退避重试（默认 60 秒 / 20 次），不再误判为普通失败

### Changed
- **看门狗改为 SSE 流静默检测**：不再依赖"是否在工具循环"的猜测，直接监控流是否有数据；
  流静默超过阈值（默认 300 秒）才催 AI 继续，更准确
- **压缩流程改用「清 IDB + 刷新」**：让 DeepSeek 自己重建完整历史后再读取，
  数据更权威、摘要必然包含，去掉"从 SSE 补消息 id"的 hack
- **工具遮罩去掉 loading 光标**（`cursor: wait` → `default`）

### Fixed
- **hook 性能问题**：`cacheHeaders` 高频写 localStorage（去重 + 移到 send 时一次）、
  `fragmentTypes` 的 O(n²) 复制（改 push）、清理高频诊断日志、轮询仅在变化时执行

## [0.6.0] - 2026-09-21

> 本版为**架构重构版**：全仓 TypeScript + ESM + 目录按领域重组 + 工具契约自动生成。

### Added
- **窗口地址栏**：窗口改用 `WebContentsView` 架构，顶部提供地址栏
  （显示 URL、复制、粘贴跳转、前进/后退/刷新/主页）
- **工具调用执行遮罩**：工具执行期间对 AI 页面加全局遮罩，防止误操作干扰
- **AI 回复中断自动重试**：服务端截断（INCOMPLETE / 正文为空）时自动重发

### Changed
- **全仓迁移 TypeScript**：所有源码由 JS 迁移到 TS，编译产物输出到 `out/`；
  主应用开启 `strict` 模式（hook 作为独立编译单元，单独规则）
- **全面转向 ESM**：统一使用 ES 模块，原生动态 `import()`
- **依赖升级**：Electron 33 → 44、TypeScript 5 → 7、ESLint 9 → 10 等
- **目录按领域重组**：`src/{app, session, bridge, overlay, tools, providers, mcp, infra}`，
  取代原先的 `main / preload / utils / tools` 分层
- **工具系统重组**：`tools/` → `src/tools/`，内部按 `core / runtime / impl` 分层
- **工具 API 契约自动生成**：每个工具自持 API 元数据与沙箱注入函数，
  构建期自动生成 `api.d.ts` 与 `bootstrap.generated.ts`（工具成为唯一真相源）
- **Provider hook 模块化**：网络拦截器改为正常 TS 模块，构建期用 esbuild
  打包为自包含字符串（消除三平台 SSE 解码重复）
- **工具调用模式收敛**：仅保留 JS（cuckoo 代码块）调用方式

### Removed
- 旧工具别名（`FileReadTool` / `FileWriteTool` / `FileEditTool` / `GlobTool` / `GrepTool`）
- JSON 工具调用执行模式（改为仅识别并提示）
- `tool-names` 手工维护的工具白名单

## [0.5.3] - 2026-09-18

### Added
- **附件上传工具（attach_file）**：AI 可将本地文件（PDF、Word、Excel、PPT、图片等
  无法用 read 读取的二进制文件）作为附件主动上传到对话输入框，上传后随下一条
  消息发出；单文件、大小上限 30MB，按扩展名推断 MIME
- **附件上传间隔设置**：默认 0.5~1 秒可配置，触发上传后先等待再检测附件是否出现
  （保留兜底轮询，避免页面渲染慢时误判失败）
- **「卡住了?点我」快捷按钮**：原「手动解析」改为向 AI 发送
  「刚才卡住了请继续 爱你哦」，一键催促卡住的 AI 继续
- **MCP 初始化提示词注入已启用 server 列表**（含连接状态与工具数）
- **MCP 默认工作目录**：stdio server 的 cwd 固定为程序目录/mcp-cwd，
  不可写时回退用户数据目录；覆盖各平台各安装方式
- **AI 可定位 MCP 产物**：提示词注入 MCP 工作目录，AI 可用绝对路径读取/上传
  截图、下载等产物

### Fixed
- 修复 4 个提示词模板缺少 `{{MCP_SECTION}}` 占位符，导致 MCP 能力章节从未
  注入提示词的问题
- 修复 MCP 并发连接竞态（启动与初始化同时触发导致重复 spawn 子进程、连接泄漏）

### Changed
- 初始化项目不再阻塞等待 MCP 连接，改为后台异步连接，初始化更迅速

## [0.5.2] - 2026-09-17

### Added
- **请求失败自动重试**：AI 对话请求失败（网络错误 / 非 2xx / 流中断）时，
  按配置间隔自动重发提示词，触发 AI 重新回答
  - 普通失败：默认 4~10 秒间隔、10 次；操作频繁（429）：默认 60 秒、20 次
  - 倒计时浮层 + 取消按钮；次数为负数表示不限次
  - 成功回复即重置计数；压缩上下文期间自动暂停
- **工具循环看门狗**：AI 进入工具调用循环后，若某轮等待回复超时，
  自动发送「请继续」提示词催 AI 继续；超时默认 300 秒、默认 3 次
  - 工具执行期间不监控；会话切换自动失效，不打扰新会话
- **设置弹窗**：重试 / 看门狗 / 发送延迟集中配置，新增「恢复默认」按钮
- **内置 Provider 容错加载**：单个内置平台文件缺失/损坏不再拖垮应用启动

### Fixed
- 修复用户主动停止生成被误判为失败、触发自动重试的问题：
  通过拦截 DeepSeek 的 stop_stream 请求作为「用户停止」的可靠判据
- 修复 inject_js 无法处理多语句代码、顶层 await、if-return 的问题
  （改用两遍语法探测，兼容表达式与语句体）

## [0.5.1] - 2026-09-15

### Fixed
- 修复打包后系统提示词中 ts 代码围栏为空的问题：electron-builder 默认排除
  `*.d.ts` 不进 asar，导致 `tools/cuckoo-tools.d.ts` 缺失、`{{TOOL_API_TYPES}}`
  被替换为空。改用 `extraResources` 复制到 `resources/tools/`，运行时优先从
  `process.resourcesPath` 读取并回退到源码路径

## [0.5.0] - 2026-09-15

### Fixed
- 修复系统提示词中工具类型定义（cuckoo-tools.d.ts）注释里的 ``` 反引号破坏 ts 代码围栏的问题

## [0.4.0] - 2026-09-15

### Added
- **上下文压缩（手动 + 自动）**：当对话 token 过大时，生成摘要并只保留最近
  20% 对话，通过 DeepSeek 分享功能在新会话继续
  - 纯 API 实现：读 IndexedDB 全量消息，直接调用分享接口，不依赖 DOM 点击
  - 面板「压缩」按钮手动触发；「自动压缩」可配置阈值（默认 80 万 token）
  - 压缩后自动跳转新会话并初始化项目，末尾追加「请继续你之前的工作」

## [0.3.10] - 2026-09-14

### Fixed
- 修复选择平台时闪退：切换平台会先销毁旧窗口再重建，
  window-all-closed 期间窗口数短暂为 0 导致应用误退出
- 修复 userData 目录不存在时启动崩溃：app.setPath('userData') 前兜底创建目录

## [0.3.9] - 2026-09-14

### Added
- 面板显示 DeepSeek 服务端对话 token（读取 SSE 流的 accumulated_token_usage，
  过万自动简写为 x.xx万）

### Changed
- 彻底移除 DOM 抓取 AI 回复路径，仅保留网络请求拦截
  - 删除 observer / ai-response / detector 等 DOM 抓取模块
  - 抽出工具执行逻辑到 tool-executor，拦截与 DOM 共用
  - 手动解析改为复用拦截缓存文本，不再依赖 DOM
- 注释 provider 中已废弃的 DOM 抓取方法（isResponseComplete / getMessageCandidates /
  getMessageMarkdown / isUserMessage / getCodeBlockLanguage）
- 移除 token 本地估算，仅保留服务端权威数据

## [0.3.8] - 2026-09-11

### Changed
- **DeepSeek / Claude / ChatGPT 三个平台的 AI 回复获取，从 DOM 抓取改为网络请求拦截**
  - 在页面主世界（main world）注入拦截器，被动观察平台自身的 completion SSE 流，
    直接解析回复文本，不再依赖 MutationObserver + DOM 稳定性轮询
  - 仅旁路读取（response.clone / responseText 快照），不修改请求与响应
  - 正文提取区分并排除 THINK / reasoning 片段
  - DeepSeek：解析 response/fragments 的 THINK / RESPONSE 分片
  - Claude：解析 content_block_delta 的 text_delta（忽略 thinking_delta）
  - ChatGPT：解析 /backend-api/f/conversation 的裸 v 追加、patch 批量操作、
    message 快照（仅采纳 assistant）与 message/status 结束信号
  - 工具执行结果回传仍沿用原有模拟输入框发送方式

## [0.3.6] - 2026-09-08

### Fixed
- 添加标准编辑菜单，修复 macOS 无法在 DeepSeek 输入框复制/粘贴的问题

## [0.3.5] - 2026-09-08

### Fixed
- glob/grep 工具打包后 ripgrep ENOENT，通过 asarUnpack 解包二进制并修正运行路径
- 恢复 README 中 Codecov 覆盖率徽章

## [0.3.4] - 2026-09-07

### Fixed
- pwsh 工具改用 execFile，避免管道符被 cmd 预解析导致命令残缺
- 主窗口 UA 改为 Chrome 130 普通标识，避免 DeepSeek 提示隐私风险
- openBrowserWindow 工具窗口同步设置 Chrome 130 UA，不再暴露 Electron 标识
- XML invoke 检测不再要求必须位于文本开头，并避免提示语自触发循环
- 渲染进程可通过 --cuckoo-user-data 参数加载自定义 Provider

### Added
- Provider 发送扩展接口（provider.triggerSend），支持站点原生发送
- 流式稳定性双通道校验（mutation 快照 + interval 兜底）
- 完成检测兜底轮询（每 2s 主动复查），覆盖后台/最小化漏触发场景
- MCP 工具调用识别（await mcpXxx / log(await xxx））
- 无 pre 的 .md-code 代码容器兜底

### Changed
- 会话 ID 提取与跳转 URL 改为 Provider 方法，不再硬编码 DeepSeek 格式

## [0.3.0] - 2026-09-07

### Added
- 多平台 Provider 框架：支持 DeepSeek 与 Claude，按平台区分输入框/发送按钮/用户信息/消息解析
- 平台选择页：新窗口未指定平台时展示卡片式选择页（含官方品牌 logo）
- 提示词模板化：每平台独立模板，支持 `{{PLATFORM_INFO}}` `{{TOOL_API_TYPES}}` `{{TOOLS_LIST}}` `{{TOOL_SECTIONS}}` `{{PROJECT_DIR}}` `{{PROJECT_INTRO_SECTION}}` `{{MCP_SECTION}}` 占位符
- 自定义 Provider 功能：用户可通过平台选择页导入 JS 文件，支持复制到 userData、重名替换、删除前窗口占用检查
- 自定义 Provider 类型声明与模板：`src/providers/custom/provider.d.ts` + `provider.template.js`
- Provider 方法化：平台差异全部下沉到 Provider 方法（findInput/findSendButton/isResponseComplete/getMessageCandidates 等）
- Claude 自动解析：基于停止按钮边沿触发完成检测，跳过空消息，避免重复触发
- 按平台分文件记录渲染日志到 `wyp/log/{providerId}.log`
- 新增 Provider 单元测试

### Changed
- 系统提示词由单文件改为多平台模板，运行时按 providerId 选择并替换占位符
- 工具 API 类型定义从 `tools/cuckoo-tools.d.ts` 动态读取，避免多处维护
- 平台 logo 从首字母占位改为官方 SVG

### Fixed
- Claude 自动解析重复触发/漏触发问题
- 多个 `{{PROJECT_DIR}}` 占位符只替换第一个的问题
- 导入自定义 Provider 后源文件被删导致失效的问题

---

## [0.2.5-beta.1] - 2026-09-02

### Added
- 新增 MCP（Model Context Protocol）按需查询能力
  - mcpListServers() 查看已配置的 MCP server（名称/类型/状态/工具数/工具名）
  - mcpGetTools(serverName) 查看指定 server 的工具详情（描述+参数）
  - mcpCall(server, tool, args) 调用 MCP 工具
- MCP 启动时自动连接已启用的 server，初始化项目时等待连接（8 秒超时）
- MCP 配置保存前完整 JSON 结构校验（错误时明确提示且不覆盖输入）
- MCP 配置保存后弹确认框，由用户决定是否通知 AI（避免打断 AI 操作）
- showConfirmDialog 扩展支持确认/取消双按钮 + Promise 返回（向后兼容）
- 新增 McpCallTool、McpQueryTools 单元测试

### Changed
- MCP 提示词改为按需查看模式，不再全量注入工具列表（节省 token）
- MCP 保存后的自动通知改为简短格式，引导 AI 按需查询
- 移除 .cuckooCode/CUCKOO.md 作为全局项目介绍（避免干扰其他项目场景）

### Fixed
- 修复 connectEnabledServers 从未被调用导致 MCP 启动后未连接的问题
- 修复 initProject 同步逻辑中 MCP 连接时序竞态（改为 async + 等待）

---

## [0.2.0] - 2026-08-27

### Breaking Changes
- 主进程重构：main.js 拆分为 src/main/ 模块（应用生命周期、IPC、项目上下文、会话存储分离）
- preload 重构：preload.js 拆分为 src/preload/ 模块（DOM 监测、overlay UI、工具解析分离）
- 移除 MySQLTool.js（已无维护，提示词中不再暴露）
- 移除旧版工具桥接实现（ToolBridge.js、UnifiedToolManager.js、WebContentCapturer.js）
- bash/pwsh 不再强制要求 description 参数（改为可选）

### Added
- 新增 5 个对标 dsh 的工具实现：
  - read（offset/limit 分段读取，替代 readFile）
  - write（全量覆盖，替代 writeFile）
  - edit（精确替换，替代 editFile）
  - glob（ripgrep 引擎，替代旧 GlobTool）
  - grep（ripgrep JSON 输出，替代旧 GrepTool）
- 新增 todoWrite 工具（全量任务列表，对标 dsh todo_write）
- 新增 pwsh 工具（PowerShell 执行，对标 dsh tool-pwsh）
- 新增 webFetch 工具（HTML 转 Markdown，对标 dsh web_fetch）
- 新增 openBrowserWindow / injectJS 工具（打开调试窗口并注入 JS）
- 工具系统支持 section 机制（对标 dsh systemPrompt.section），每个工具有独立的 prompt section
- 系统提示词全面改版：中文 dsh 风格 + 动态平台检测（Windows/macOS/Linux）
- 发送延迟可配置（UI 设置 + localStorage 持久化）
- UI 全面改版：悬浮球模式（48px 右下角 FAB + 小面板），不再占用全高侧边栏
- 跨平台启动脚本 start.js（Windows/macOS/Linux 通用）
- 完整单元测试覆盖（tools / main / preload）

### Changed
- package.json start 脚本改为 node start.js（修复 macOS chcp: command not found）
- start.js 自动根据平台选择 UTF-8 编码设置
- 工具返回格式统一为 dsh 风格（纯文本 envelope / marker）
- 错误提示统一为英文 dsh 风格
- package.json 增加 allowScripts 配置（npm 新版本 electron postinstall 被阻止问题）

### Fixed
- edit 工具 CRLF 适配（LF 的 old_string 能匹配 CRLF 文件）
- bash/pwsh 非零退出不再报错，改用 [exit code: N] 标记
- glob 路径去掉 ./ 前缀
- Windows 平台信息动态生成（不再硬编码）
- Electron postinstall 被 npm allowScripts 阻止导致二进制缺失的问题
- JS 脚本无输出时提示使用 log()

### Security
- bash/pwsh 危险命令黑名单保留（Windows + PowerShell 特有命令）
- 命令执行超时限制保持 30 秒
- 输出缓冲 1MB 限制保持

### Dependencies
- 新增 @vscode/ripgrep（glob/grep 底层引擎）
- 新增 turndown + @joplin/turndown-plugin-gfm（webFetch HTML 转 Markdown）

---

## [1.0.0] - 2026-08-11

### Added
- 初始版本发布
- Electron 桌面应用，嵌入 DeepSeek 网页版
- 自动检测 AI 回复中的 cmd/powershell 代码块，弹窗确认后执行
- 工具调用系统：支持 file_write、file_read、file_edit、file_glob、file_grep、bash、file_delete 等工具
- 会话级项目目录绑定，工具操作以项目目录为基础
- 侧边覆盖层面板，显示命令预览、执行结果和历史记录
- Ctrl+Shift+C 快捷键切换覆盖层
- 项目初始化功能，自动生成目录树并注入系统提示词
- 支持危险命令检测与额外警告
- 会话持久化（cookies/localStorage 保存到 %APPDATA%/cuckoo-code-session）

### Security
- 命令执行前必须用户确认
- 危险命令（rm -rf /、format、shutdown 等）触发额外警告
- 30 秒命令执行超时限制
- 1MB 命令输出缓冲区限制
