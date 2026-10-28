# 最新接续状态 (2026-10-28 深夜)

## 核心进展

- **v0.10.158 发版**：手机端切前后台无感重连回归 + 格式纠正 0 延迟（修队列误 flush）。
- **根因定位（逐版本 diff 取证）**：用户反馈 APK 切前后台「卡、显示重连中、消息不及时」。逐行对比 v0.10.54 与 v0.10.157 的 `app.js` 发现：
  - v0.10.155（commit 71412c5）为修「离线仍显示在线」的假状态，把切前台探活的 **`if (lastPong >= probeAt) return;` 防误杀保护删了**，超时还从 1500ms 缩到 1000ms → 健康 socket 被误判半开 → 强制重连 → 1~3 秒真空期消息丢失。
  - 同提交把 `connect()` 开头改成无条件 `setConn('connecting')`、`onclose` 改成立即 `setConn('off')` → 每次重连都闪「重连中」。
- **保活本身没坏**：Android 前台服务链路完整（KeepAlivePlugin → ForegroundService + START_STICKY + Android 13+ 通知权限），切后台 socket 通常不断。卡是 UI 状态机退化 + 探活误杀。

## 本轮改动（6 处，3 个文件）

1. **`src/remote/pwa/app.js`**
   - 探活超时 1000→1500ms，加回 `probeAt` + `if (lastPong >= probeAt) return;`（v0.10.54 原样）。
   - `connect()` 开头：有消息/有缓存时静默重连，不切「重连中」。
   - `onclose`：立即 `off` → 3 秒防抖；执行态清理（hideExec/setExecuting）也挪进 3 秒回调，重连成功则保持执行态。
   - 启动：有缓存 + **仅原生壳**乐观 `setConn('on')` + 8 秒看门狗降级；浏览器诚实从 connecting 起步。
   - `onopen` 清 `startupWatchdog`。
2. **`src/overlay/chat-input.ts`**：`sendMessageToChat(msg, tag?, afterSent?, fixedDelay?)` 新增第 4 参透传。
3. **`src/bridge/intercept/observer.ts`**：JSON / XML 格式纠正改 `fixedDelay=0` 立即发出。根因：原走 randomDelay 6~16s，延迟窗口内 harness 看不到「框架在驱动」，6 秒静默期满 → `maybeFlushQueue()` 提前发队列（本轮任务其实没完）。

## 审查结论

- **code-reviewer**：无高危/中危缺陷。3 条 [轻微]：①参数顺序与内层相反（非 bug，不改）②onclose 执行态与状态降级时机不一致（**已修**）③浏览器乐观显示假在线（**已修**，仅限原生壳）。
- **arch-guard**：架构合规（依赖方向 / overlay 纯 UI / bridge 不 import session-app / 生成物禁手改 / 圈复杂度 <9 全部通过）。

## 验证结果（全绿）

- `npm run typecheck` → 通过
- `npm test` → **131 套件 / 1281 用例全绿**
- `npm run lint` → 0 errors（65 warnings 均为历史存量）
- `npm run compile` → 通过（shell.html 522080 字节）

## 未闭环项（真机验证，本机无法代劳）

- [ ] **APK 需重新打包**才含新 `app.js`（手机上的旧 APK 不会自动更新）。
- [ ] APK 切后台 1 分钟 → 切回 → 顶栏保持「已在线」不闪，2 秒内收到电脑推送。
- [ ] APK 冷启动有缓存 → 秒出历史、不闪「连接中」；锁屏 5 分钟再开 → 快速恢复。
- [ ] 纯净模式队列点「立即发送」→ 旧任务停、输入框清空、旧工具结果不回填。
- [ ] AI 返回错误格式 → 提示**立即**出现（不再等 6~16 秒），且期间队列**不**自动 flush。

## 关键上下文

- 工作目录: `d:\Desktop\Super-File\cuckoo-code`
- 版本: `0.10.158`（不含数字 4，合规）
- 上一版: v0.10.157（网关/子代理共用并发池）
