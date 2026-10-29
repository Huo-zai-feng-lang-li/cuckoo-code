# 最新接续状态 (2026-10-29 13:15)

## 核心进展
- **需求 099 · Android 应用图标可切换** 已完成（待真机验证）。

## 核心动机与背景 (Motivation & Background)

**需求来源**：用户提供了三张 AI 生成的图标（`D:/Desktop/app-icon/{1,2,3}.png`），希望 Android 端除默认图标外还能在应用内切换。默认图标沿用现有 Windows 版图标（黑底双蛋 + 弧线），保持品牌统一。

**技术约束（调研结论）**：
- Android 不支持运行时直接改 `android:icon`，唯一标准做法是 `activity-alias` + `PackageManager.setComponentEnabledSetting`。
- 桌面端（Windows/macOS）图标打包时写死进 .exe/.app 和快捷方式，**运行时不可改**，因此本需求只针对 Android。
- Capacitor 8 手动注册的原生插件需要 `cap.registerPlugin('xxx')` 动态获取代理（不能用 `cap.Plugins.xxx` 硬编码，虽然有兜底）。

## 关键设计与实现 (Implementation & Decisions)

### 资源生成（scripts/gen-android-icons.mjs）
- 四套图标：`default / glass / sticker / gold`，源图统一 1024×1024 存 `assets/android-icons/`。
- `--prepare` 模式：外部原图（2048×2048）→ 按各图标独立 `crop` 比例中心裁切 → 缩放到 1024 → **BFS flood fill 从四边清除连通近白像素**（阈值 RGB≥235）去掉白圆角边。
  - sticker 裁到 0.82（去掉厚灰框），其余 0.92，default 1.0（原本就是透明圆角）。
- 每套图标生成：5 密度 × (legacy 方/圆 + adaptive 前景 108dp) = 15 张 PNG，加 2 个 anydpi XML + 1 个 color 资源。
- adaptive 背景色：**四角内侧 5%~18% 区域**采样平均色（早期版本用边缘环带会采到贴纸灰框/金边，已修）。
- legacy 圆角用 SVG mask `dest-in` 合成；adaptive 前景是 108dp 画布 72dp 内容居中。

### Android 端
- `AndroidManifest.xml`：主 `MainActivity` 移除 LAUNCHER filter，改为 4 个 `activity-alias`，默认 `MainActivity_default` enabled=true，其余 false。
- `AppIconPlugin.java`：
  - `get()` 返回 `{ current, available }`，状态从 SharedPreferences（`cuckoo_app_icon`）读——**不能依赖 getComponentEnabledSetting 回读**，部分 ROM 有延迟。
  - `set({id})` 幂等：目标已生效直接 resolve；否则 disable 旧 → enable 新 → 兜底 disable 其余全部，均带 `DONT_KILL_APP`。
  - `isAliasEnabled` 处理 `COMPONENT_ENABLED_STATE_DEFAULT`：此时以 manifest 为准，只有 default 视为启用。
- `MainActivity.java`：`registerPlugin(AppIconPlugin.class)`。

### PWA 端（src/remote/pwa）
- 顶栏新增 `btn-app-icon`（调色板图标），**仅在 APK 内显示**（`getAppIconPlugin()` 返回 null 时隐藏）。
- 底部弹出面板 `#icon-sheet`：4 宫格卡片，选中态高亮，点击调 `plugin.set({id})`。
- 本地极简 toast `showIconToast`（PWA 原本没有全局 toast）。
- 预览图 `src/remote/pwa/app-icons/*.png`（128×128，由 assets/android-icons 缩放）。

### 清理
- 删除旧 `ic_launcher.{png,xml}` / `ic_launcher_foreground.xml` / `ic_launcher_background.xml` 及其密度副本（无引用，避免 APK 双份资源）。
- `package.json` files 排除 `assets/android-icons/**`（6.21MB，不参与 Electron 打包）。

## 验证结果
- `npm run typecheck` ✅
- `npm run lint` ✅ 0 error（65 warning 全为历史遗留）
- `npm test` ✅ 131 files / 1304 tests
- `npm run compile` ✅
- `node --check src/remote/pwa/app.js` ✅
- **未做**：APK 构建 + 真机验证（本机无 JDK；需 CI 或用户出包验证）

## 待办事项 (Next Steps)
- [ ] **真机验证**（需构建 APK）：
  1. 首次安装默认图标是黑底双蛋
  2. 顶栏调色板按钮出现（浏览器/PWA 网页模式下不出现）
  3. 依次切 glass/sticker/gold，桌面图标几秒内更新
  4. 切换后重启 App，图标保持
  5. 反复切换不出现双图标（同 app 两个桌面入口）
  6. 国产 ROM（MIUI/EMUI）延迟表现
- [ ] 低优先级：`ForegroundService` 通知小图标目前用系统 `android.R.drawable.ic_dialog_info`，可考虑换成 `ic_stat_cuckoo` 的品牌版（不在本需求范围）。
- [ ] 历史遗留：172/173 真机验证；092 并发池 A~H；v0.10.164 tag 违规仍待定。

## 关键上下文
- 目录: `D:/Desktop/Super-File/cuckoo-code`
- 主要文件:
  - `scripts/gen-android-icons.mjs` — 图标资源生成（`--prepare` 预处理源图）
  - `assets/android-icons/{default,glass,sticker,gold}.png` — 1024 源图（**已去白边**）
  - `android/app/src/main/AndroidManifest.xml` — 4 个 activity-alias
  - `android/app/src/main/java/com/cuckoo/cuckoocode/AppIconPlugin.java` — 图标切换插件
  - `src/remote/pwa/index.html` — `btn-app-icon` + `#icon-sheet` 面板
  - `src/remote/pwa/app.js` — `initAppIconSwitcher()` / `showIconToast()` / `getAppIconPlugin()`
  - `src/remote/pwa/style.css` — 末尾图标面板样式
  - `src/remote/pwa/app-icons/*.png` — 128×128 预览图
  - `docs/requirements/099-android-app-icon.md` — 需求档案
