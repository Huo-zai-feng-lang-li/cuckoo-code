# 最新接续状态 (2026-10-28 23:51)

## 核心进展
- **v0.10.158 已发版并推送**（commit `2ecc7bd`，tag `v0.10.158` → origin 已确认收到）：手机端切前后台无感重连回归 + 格式纠正 0 延迟防队列误 flush。改动 3 个文件：`src/remote/pwa/app.js`、`src/overlay/chat-input.ts`、`src/bridge/intercept/observer.ts`。

## 核心动机与背景 (Motivation & Background)
- **用户现象**：APK 切前后台感觉"卡"、顶栏一直显示「重连中」、电脑端消息不能及时推送；怀疑网速或缓存修坏。
- **根因（逐版本 git diff 取证）**：v0.10.155（commit `71412c5`）为修「离线仍显示在线」的假状态，把切前台探活的**防误杀保护 `if (lastPong >= probeAt) return;` 一并删了**，超时还从 1500ms 缩到 1000ms。健康 socket 被误判半开 → 强制重连 → 1~3 秒真空期消息丢失、状态栏闪「重连中」。同提交还让 `connect()` 无条件 `setConn('connecting')`、`onclose` 立即 `setConn('off')`。
- **保活没坏**：Android 前台服务链路完整（`KeepAlivePlugin.java` → `ForegroundService.java` + `START_STICKY` + Android 13+ 通知权限），切后台 socket 通常不断。卡是 UI 状态机退化 + 探活误杀，与保活/网速无关。
- **第二个问题**：格式纠正提示（JSON/XML 工具调用纠正）走 `randomDelay()` 6~16s。延迟窗口内 harness 看不到「框架在驱动」，6 秒静默期满 → `maybeFlushQueue()` 提前 flush 待发队列（本轮任务其实没完）。

## 关键设计与实现 (Implementation & Decisions)
- **`src/remote/pwa/app.js`**（5 处）：
  1. 探活超时 1000→**1500ms**，加回 `probeAt` + `if (lastPong >= probeAt) return;`（v0.10.54 原样）。
  2. `connect()` 开头：有消息/有缓存时静默重连，不切「重连中」。
  3. `onclose`：立即 `off` → **3 秒防抖**；执行态清理（`hideExec`/`setExecuting`）也挪进 3 秒回调，重连成功则保持执行态。
  4. 启动：有缓存 + **仅原生壳**（`isNativeShell()`）乐观 `setConn('on')` + **8 秒看门狗**降级；浏览器诚实从 `connecting` 起步。
  5. `onopen` 清 `startupWatchdog`。
- **`src/overlay/chat-input.ts`**：`sendMessageToChat(msg, tag?, afterSent?, fixedDelay?)` 新增第 4 参，透传给 `sendToChat`。
- **`src/bridge/intercept/observer.ts`**：JSON / XML 格式纠正改 `fixedDelay=0` 立即发出（两处调用：`(msg, 'JSON工具调用提示', undefined, 0)` / `(hint, 'XML工具调用纠正', undefined, 0)`）。0ms 让 `emitMessageDelivered` 立即触发 → harness 进忙态 → 队列不误 flush。
- **审查结论**：code-reviewer 无高危/中危缺陷（3 条 [轻微]，2 条已修：onclose 执行态时机不一致、浏览器乐观假在线；1 条参数顺序不改——非 bug）；arch-guard 架构合规（依赖方向 / overlay 纯 UI / bridge 不 import session-app / 生成物禁手改 / 圈复杂度 <9 全过）。
- **验证全绿**：typecheck ✅ / test **131 套件 1281 用例** ✅ / lint 0 errors ✅ / compile ✅。

---

## 手动真机验证手册（v0.10.158）

> 前提：手机上的旧 APK 内嵌的是旧 `app.js`，**不会自动更新**。必须先下载并安装 v0.10.158 的 APK。

### 第 0 步：获取并安装新 APK

**方式 A（推荐）：GitHub Release 直接下载**
1. 浏览器打开 `https://github.com/Huo-zai-feng-lang-li/cuckoo-code/releases/tag/v0.10.158`
2. 等 CI 构建完成（tag 推送后约 10~20 分钟），页面出现 **`cuckoo-remote-android-v0.10.158.apk`**
3. 手机浏览器直接点该文件下载安装（需允许「安装未知来源应用」）
4. 若之前装过旧版，**直接覆盖安装**即可（同包名同签名，数据/登录态保留）

**方式 B：GitHub Actions 产物（Release 未就绪时）**
1. 打开 `https://github.com/Huo-zai-feng-lang-li/cuckoo-code/actions`
2. 找到最新 `Build and Release` 运行（对应 tag `v0.10.158`）
3. 页面底部 **Artifacts** 下载 `dist-android`（zip），解压得 apk
4. 传到手机安装

**验证安装成功**：打开 APP，顶栏不应出现旧版的「一闪一闪重连中」现象。

---

### 第 1 步：切后台 → 切回（核心验收）

**准备**：电脑端已开远程控制、手机已连上（顶栏显示「已在线」）。

1. 手机打开 APP，确认顶栏 **「已在线」**
2. 在电脑端准备一条待发消息（或让 AI 正在生成中）
3. 手机按 **Home 键** 切到桌面（APP 进后台）
4. **等待 60 秒**（不要划掉 APP，让它留在后台）
5. 切回 APP

**✅ 通过标准**：
- 顶栏**保持「已在线」**，不出现「重连中」字样
- 切回后 **2 秒内**收到电脑端在后台期间推送的消息
- 若电脑端正在生成，切回后流式文字**继续滚动**，不中断

**❌ 失败表现**（需回退排查）：
- 顶栏闪「重连中」超过 1 秒
- 切回后消息延迟 > 3 秒才出现
- 生成中的文字丢了一段

---

### 第 2 步：冷启动 + 锁屏长时（缓存与恢复）

**2a. 冷启动**
1. 手机设置里**强行停止** APP（或从最近任务划掉）
2. 重新打开 APP
3. **✅ 通过**：有历史对话 → 秒出内容 + 顶栏直接「已在线」（不闪「连接中」）
4. 若 8 秒内没连上（如电脑关机），**✅ 通过**：降级为「已离线」（诚实兜底，不假在线）

**2b. 锁屏长时**
1. APP 保持前台，锁屏
2. 等 **5 分钟**
3. 解锁回到 APP
4. **✅ 通过**：顶栏「已在线」，不长时间卡「重连中」
5. **可接受**：有一次短暂重连（1~2 秒），但不应超过 3 秒

---

### 第 3 步：纯净模式队列「立即发送」（桌面端或手机端均可）

> 这是验证「手动发送要停旧任务 + 清输入框 + 不回填旧结果」

1. 进入**纯净模式**（新对话）
2. 发一条会**长时间运行**的任务（如「搜索 D 盘所有 .log 文件」）
3. 任务运行中，输入框再输入 2 条消息，按发送（进**待发队列**）
4. 观察队列出现「待发队列 2 条」
5. 点队列某条的 **↑ 立即发送**按钮

**✅ 通过标准**：
- 原任务立即停止（工具卡片转「已停止」）
- 输入框被清空
- 旧任务的工具结果**不回填**到输入框
- 队列该项正常发出

**❌ 失败表现**：
- 旧任务还在跑，新消息就发出去了
- 旧工具结果文本出现在输入框
- 输入框残留旧草稿

---

### 第 4 步：格式纠正 0 延迟 + 队列不误 flush（关键新功能）

> 这是验证「AI 返回错误格式时，纠正提示立即出现，且队列不被提前 flush」

**构造错误格式**：让 AI 输出 JSON 或 XML 工具调用（而非 cuckoo 代码块）。

**方法一（自然触发）**：给 AI 一个容易触发旧习惯的提示，例如：
- 「用 JSON 格式调用 bash 工具运行 dir」

**方法二（强制触发，需改提示词）**：临时在系统提示里暗示「优先用 JSON」，观察 AI 是否输出 JSON 工具调用。

**测试步骤**：
1. 先发一条让 AI 返回错误格式的消息
2. **AI 返回前**，再在队列里放 1 条消息（不要让它立即发）
3. 观察 AI 返回了 JSON/XML 错误格式

**✅ 通过标准**：
- 纠正提示 **立即**出现（≤1 秒），不再干等 6~16 秒
- 队列消息 **不**被自动发出（仍显示「待发队列 1 条」）
- AI 开始按正确格式重新调用工具，任务继续

**❌ 失败表现**（说明修复没生效）：
- 纠正提示延迟 6~16 秒才出现
- 队列消息在格式纠正之前就被发出去了（和纠正提示撞车）

---

### 第 5 步：抓日志（可选，出问题时用）

**电脑端日志**（`npm start` 或打包版的日志）：

- 正常切前后台，**不应**频繁出现：
  ```
  [Remote] 回到前台探活超时，判定连接半开，立即重连
  ```
- 若出现 1~2 次属正常（那次探活确实 1.5 秒没收到 pong）；**频繁出现**说明网络有问题

**手机端日志**（若用 adb）：
```bash
adb logcat | findstr /C:"Cuckoo" /C:"Remote" /C:"KeepAlive"
```
- 应看到 `[KeepAlive] 前台服务已启动`
- 不应看到 `[KeepAlive] 插件不可用，保活功能降级`（说明保活异常）

---

### 验证记录建议

每项打完勾记结果，失败时记：
- 手机型号 / Android 版本
- 网络环境（WiFi / 4G / 5G）
- 具体现象（延迟多久、闪什么文案）
- 日志片段

---

## 待办事项 (Next Steps)
- [ ] 按上述「第 0~5 步」完成真机验证，逐项打勾
- [ ] 观察 Android 15 `dataSync` 前台服务 6 小时限制隐患（`ForegroundService.java` 未重写 `onTimeout()`，长会话挂一整天可能触发系统回调被杀）——尚未修，属遗留隐患
- [ ] 若第 4 步失败：检查 `src/bridge/intercept/observer.ts` 两处 `sendMessageToChat(..., undefined, 0)` 是否真的生效（可在浏览器 devtools 打断点确认 `fixedDelay` 参数值）

## 关键上下文
- 目录: `d:\Desktop\Super-File\cuckoo-code`
- 版本: `0.10.158`（不含数字 4，合规）；上一版 v0.10.157
- 主要文件:
  - `src/remote/pwa/app.js` — PWA 连接状态机（`connect` / `visibilitychange` / `onclose` / 启动段）
  - `src/overlay/chat-input.ts` — `sendMessageToChat` / `doSendToChat` / `randomDelay`
  - `src/bridge/intercept/observer.ts` — `processInterceptedResponse`（格式纠正调用点）
  - `src/ui/harness.html` — `sendQueueItemNow` / `waitForAiIdleThenSend` / `onTaskIdle` / `onAiState`
  - `android/app/src/main/java/com/cuckoo/cuckoocode/` — `KeepAlivePlugin.java` / `ForegroundService.java` / `MainActivity.java`
- CI 配置: `.github/workflows/release.yml`（tag `v*` 触发 → build-win + build-android → publish Release）
- APK 产物名: `cuckoo-remote-android-v0.10.158.apk`（debug 构建）
- Release 地址: `https://github.com/Huo-zai-feng-lang-li/cuckoo-code/releases/tag/v0.10.158`
- 参考：v0.10.54 的 `app.js` 探活逻辑为正确基准（`git show v0.10.54:src/remote/pwa/app.js`）
