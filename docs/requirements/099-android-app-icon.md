---
id: 099
type: feat
title: Android 应用图标可切换（activity-alias 方案，4 套可选）
status: done
branch: (直接主分支)
created: 2026-10-29
updated: 2026-10-29
---

# 099 · Android 应用图标可切换

- **类型**：feature
- **状态**：done
- **分支**：直接主分支
- **日期**：2026-10-29

## 背景

Android 端（Capacitor 壳）目前只有一套写死的图标。用户希望像很多国产 App 一样，在应用内提供「更换图标」选项，共 4 套：

| id | 名称 | 说明 |
|---|---|---|
| `default` | Cuckoo（默认） | 现有 Windows 图标（黑底双蛋 + 弧线），与桌面端品牌统一 |
| `glass` | 玻璃鸟 | 玻璃质感蓝鸟 + 声波线（素材 `app-icon/1.png`） |
| `sticker` | 像素贴纸 | 卡通贴纸风（素材 `app-icon/2.png`） |
| `gold` | 深蓝金鸟 | 深蓝底金边鸟夹在 `<>` 之间（素材 `app-icon/3.png`） |

## 技术方案

Android 不支持运行时直接修改 `android:icon`。标准做法是 **`activity-alias` + `PackageManager.setComponentEnabledSetting`**：

1. 主 `MainActivity` 移除 `LAUNCHER` intent-filter，改为 4 个 `activity-alias`，每个 alias 指向 `MainActivity` 并带自己的 `android:icon` / `android:roundIcon` / `LAUNCHER` filter。
2. 同一时刻只有 1 个 alias 处于 enabled 状态（默认 `MainActivity_default`）。
3. 原生插件 `AppIconPlugin` 暴露 `get()` / `set({ id })`，内部：
   - 校验 id 合法
   - 若目标已是当前状态，直接 resolve（幂等）
   - 否则先 `disable` 当前 alias，再 `enable` 目标 alias，均带 `DONT_KILL_APP`
4. 选择结果持久化在 `SharedPreferences`（`cuckoo_app_icon`），`get()` 用它回读——不能依赖 `getComponentEnabledSetting`，因为部分 ROM 读回状态有延迟。
5. PWA 端在顶栏「更多」区加入口，弹出一个图标选择面板，调用插件切换。

## 已知限制（产品层面需接受）

1. **切换后需要重启应用才彻底生效**（用户已确认接受）。实际上大部分 Launcher 会在几秒内刷新，但国产 ROM（MIUI/EMUI/ColorOS）可能延迟甚至需要重启桌面。
2. 切换 alias 会导致桌面快捷方式被移除重建。这是系统行为。
3. 切换时使用 `DONT_KILL_APP`，不会杀掉当前进程。

## 资源生成

- 新增 `scripts/gen-android-icons.mjs`：把源图（`assets/android-icons/*.png`，1024×1024）生成全部 mipmap 资源
- 每套图标生成：
  - `ic_launcher_<id>.png` + `ic_launcher_<id>_round.png`（5 密度，48/72/96/144/192，圆角遮罩）
  - `ic_launcher_<id>_foreground.png`（5 密度，108dp，内容区 72dp 居中、外圈透明）
  - `mipmap-anydpi-v26/ic_launcher_<id>.xml` + `_round.xml`（adaptive-icon）
  - `values/ic_launcher_background_<id>.xml`（从源图边缘采样得到的底色）
- 源图预处理：2048 → 1024，裁掉中心 90% 外的白圆角边，避免系统遮罩切到白边

## 验证

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿
- **APK 构建与真机验证由 CI / 用户完成**（本机无 JDK，无法本地编译 APK）
- 需要人工检查生成的 PNG 是否「好看」

## 影响面

- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/java/com/cuckoo/cuckoocode/MainActivity.java`
- 新增 `android/app/src/main/java/com/cuckoo/cuckoocode/AppIconPlugin.java`
- 新增 `android/app/src/main/res/mipmap-*/ic_launcher_{default,glass,sticker,gold}*.png`
- 新增 `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_{...}.xml`
- 新增 `android/app/src/main/res/values/ic_launcher_background_*.xml`
- 新增 `scripts/gen-android-icons.mjs`
- 新增 `assets/android-icons/*.png`
- `src/remote/pwa/index.html`（图标选择面板）
- `src/remote/pwa/app.js`（插件调用 + UI 逻辑）
- `src/remote/pwa/style.css`（面板样式）
- `package.json`（`sharp` devDependency）
