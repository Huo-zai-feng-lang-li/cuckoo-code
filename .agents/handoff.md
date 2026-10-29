# 最新接续状态 (2026-10-29 · v0.10.170 已发版)

## 核心进展
- **需求 097 已合入 master 并随 v0.10.170 发布**：手机端远程 App 任务完成通知的小图标由 Capacitor 模板占位图改为 Cuckoo 品牌鸟形图标。
- 近期版本：094（扫码布局+APK 固定签名）→ 095（子代理泄漏远程事件）→ 096（停止气泡误报）→ 097（通知小图标）。

## 097 根因更正记录（重要教训）
最初判断「任务完成通知不弹 = 权限只在后台请求」。**该判断被证伪**：
- `android/app/src/main/java/com/cuckoo/cuckoocode/MainActivity.java:15-20` 每次冷启动都原生请求 `POST_NOTIFICATIONS`（Android 13+）。
- 据此在 JS 侧加的 `ensureNotifyPermission()` 是冗余的，且会与原生请求叠加造成**双重权限弹窗**，已全部撤销。
- 教训：读不到文件内容时不要断言「子代理误读」。本轮曾错误驳回子代理的正确结论，后经 `readLines` 亲验纠正。

## 097 实际改动（极小）
- `src/remote/pwa/app.js`：`smallIcon` 由 `ic_stat_icon_config_sample` → `ic_stat_cuckoo`（1 行）
- `android/app/src/main/res/drawable/ic_stat_cuckoo.xml`：新增 Cuckoo 鸟形纯白单色 vector（24dp）
- `android/app/src/main/res/drawable/ic_stat_icon_config_sample.xml`：删除（模板占位图，无其它引用）

## 097 验证
- typecheck ✅ / test ✅ 131 文件 1304 用例 / lint ✅ 0 error（65 既有 warning）/ compile ✅
- 子代理 code-reviewer 审查 + 主代理独立复核：diff 仅 1 行代码，无 ensureNotifyPermission 残留、无旧图标残留、新图标合法。
- **未做真机验证**

## 未解决的真问题（待真机确认后另立项）
**App 切后台时 WebView JS 可能被系统节流/冻结** → `task-done` 的 WebSocket 消息排队到回前台才处理 → 此时 `visibilityState === 'visible'` → 不弹通知。
这不是权限问题，也不是图标问题。要修需原生侧接收或防节流，属独立较大改动。

## 真机验证清单（097）
- A. 任务完成且 App 在后台时，能否弹系统通知（若不能 → 印证上面的节流问题）
- B. 通知小图标显示为 Cuckoo 鸟形，非白块/对勾
- C. App 在前台时不弹通知（不刷屏）

## 历史遗留
- 096 真机验证清单 A~C 仍未做。
- 092 子代理并发池真机验证 A~H 仍未做。
- `v0.10.164` tag 违规（含数字 4）仍在 origin。
