---
id: 097
type: fix
title: 手机 APK 通知小图标改用 Cuckoo 品牌图标
status: done
branch: fix/097-remote-notify
created: 2026-10-29
updated: 2026-10-29
---

# 需求 097：手机 APK 通知小图标改用 Cuckoo 品牌图标

## 1. 背景与重要更正
原以为"任务完成系统通知不弹"是权限未请求导致。**经逐行核实，此判断错误**：

- `android/app/src/main/java/com/cuckoo/cuckoocode/MainActivity.java:15-20` **已在每次冷启动**用原生 `requestPermissions(POST_NOTIFICATIONS, 101)` 请求通知权限（未授予则每次启动都请求）。
- 因此"用户从未有机会授权"不成立。通知权限由原生层负责，可靠性已足够。
- 曾尝试在 JS 侧加 `ensureNotifyPermission` 预请求，属**冗余**，且与原生请求叠加可能造成同一启动内**双重权限弹窗**（新 bug）。已撤销。

## 2. 真实改动（仅此一处）
`src/remote/pwa/app.js` 的 `notifyReply()` 中：
- 旧：`smallIcon: 'ic_stat_icon_config_sample'`（Capacitor 模板自带白色对勾占位图）
- 新：`smallIcon: 'ic_stat_cuckoo'`（新建的 Cuckoo 鸟形纯白单色 vector，24dp，符合 Android 通知小图标规范）

同时删除无用的 `res/drawable/ic_stat_icon_config_sample.xml`（全库无其它引用）。

## 3. 涉及文件
- `src/remote/pwa/app.js`（1 行：smallIcon）
- `android/app/src/main/res/drawable/ic_stat_cuckoo.xml`（新增）
- `android/app/src/main/res/drawable/ic_stat_icon_config_sample.xml`（删除）

## 4. 通知在后台是否可靠送达（未验证，另需真机排查）
权限已由原生保证，但 **WebView 在 App 切后台时 JS 可能被系统节流/冻结**：
- `task-done` 是 WebSocket 下行消息，依赖 JS `onmessage` 处理。
- 若后台 JS 被冻结，消息会排队到回前台才处理，此时 `document.visibilityState === 'visible'` → 不弹通知。
- 这不是权限问题，而是 WebView 后台执行问题，属另一条独立的较大改动（需原生侧接收/轮询或防节流），本需求不改。

## 5. 验收标准
- [ ] typecheck / test / lint / compile 全绿
- [ ] 通知小图标显示为 Cuckoo 鸟形（非白块/对勾）
- [ ] 真机确认：App 在后台时任务完成能弹通知（若不能，按第 4 节另立项）

## 6. 遗留
- WebView 后台节流导致的送达问题（第 4 节）需真机确认后另行处理。
