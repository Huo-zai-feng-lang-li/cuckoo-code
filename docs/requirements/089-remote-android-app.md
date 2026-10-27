# 089 安卓原生 App 适配（Cuckoo Remote 保活与扫码连接）

## 一、背景与痛点
当前的手机端远程控制是基于 PWA（网页）实现的。由于手机系统的强制保活限制（尤其是内存回收和冻结策略），导致：
1. 切后台经常被系统杀掉进程，切回前台时页面重新加载，产生几秒的“白屏/连接中”等待，打断体验。
2. 网页无法在后台维持长连接，无法实现真正的“秒级”消息推送。

## 二、目标
基于现有的 PWA 代码，使用 Capacitor 套壳生成安卓原生 App（APK）。
在不改动电脑端核心通讯逻辑的前提下，利用 Android 系统的 **前台服务（Foreground Service）** 实现真正的后台永久保活，达到 0 延迟、切后台绝不重连的体验。

## 三、技术方案
1. **UI 层**：完全复用现有的 `src/remote/pwa` 下的前端代码。
2. **容器层**：引入 `@capacitor/core` 与 `@capacitor/android`。
3. **原生插件层**：
   - 编写 Android 原生代码，启动前台服务（常驻通知栏）。
   - Android 13+ 处理通知权限（`POST_NOTIFICATIONS`）。
   - 引导用户忽略电池优化（`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）。
4. **连接层**：
   - 环境判断：若是原生 App，禁用 `visibilitychange` 探活重连（因为 App 根本没死，WebSocket 一直活着）。
   - 依赖原生的 `App.addListener('appStateChange')` 仅在切回前台且连接确实断开时触发重连。
5. **扫码配对**：
   - 电脑端远程设置页新增“手机扫码连接”按钮，弹出一个带当前 Token 和 URL 的二维码。
   - 手机端 App 增加扫码功能，扫完后自动填入 Token 和 URL，无需手动输入。

## 四、细节设计
### 4.1 保活机制与通知栏
- **方案**：使用原生 Foreground Service，创建一个低优先级的通知渠道。
- **通知文案**：“⚡ Cuckoo Remote 正在后台保持连接”。
- **权限**：App 启动时强制请求通知权限。如果用户拒绝，提示“若关闭通知，系统将无法保活”。
- **电池白名单**：App 首次启动弹出友好对话框，引导用户点击“去设置”，跳转系统白名单页面。

### 4.2 界面适配
- 首页：如果没有 Token 或 URL，显示扫码界面。
- 设置页：新增一个“后台常驻运行（保活）”的开关（默认开启）。
- 状态栏：若原生环境，强制把状态栏颜色和 App 主题一致。

### 4.3 CI 自动化打包
修改 `.github/workflows/release.yml`，增加 `android` 任务：
- 环境：`ubuntu-latest`
- 安装 JDK 17 和 Android SDK。
- 执行 `npx cap sync android`。
- 在 CI 中自动生成一个自签名的 Keystore，执行 `./gradlew assembleRelease` 生成 APK。
- 将生成的 `app-release.apk` 上传到 Release 附件。

### 4.4 扫码配对逻辑
- 二维码内容格式：`cuckoo://connect?url=<tunnel_url>&token=<token>`
- 电脑端使用轻量库（或纯 Canvas 生成二维码）展示。
- 手机端使用原生扫码 SDK（如 `@capacitor-mlkit/barcode-scanning`）。

## 五、风险与规避
1. **安卓机型碎片化**：华为/小米等杀后台策略极其严格。即使有前台服务，有时候依然会被杀。
   - *规避*：通过电池白名单引导，加上前台服务双管齐下，可以拦截 99% 的杀后台。
2. **体积**：打出来的 APK 预计 5MB 左右，对手机无感知。
3. **代码污染**：Android 原生工程代码通过 Capacitor 管理，不会打包进电脑端，不影响电脑端构建。

## 六、执行步骤
1. `npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/app`
2. 生成并配置 `capacitor.config.json`。
3. 编写原生保活插件。
4. 改造 PWA 连接逻辑（识别原生环境）。
5. 接入扫码配对。
6. 修改 GitHub Actions 流水线，自动打 APK。
