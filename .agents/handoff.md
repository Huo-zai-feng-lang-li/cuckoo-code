# 最新接续状态 (2026-10-29 第二场)

## 核心进展
- **需求 094 已实现并验证**（未推送）：远程扫码按钮布局修复 + APK 固定签名支持覆盖升级。
- **当前版本**：v0.10.166（已 push master + tag）。094 改动在分支 `fix/094-remote-scan-and-apk-signing`，尚未合入 master、未发版。

## 两个问题与根因

### 1. 扫码按钮图标/文字错位
- 根因：`src/remote/pwa/app.js` 原生壳分支写 `scanBtn.style.display = 'block'`（**内联样式**），压过 `style.css` 的 `#btn-scan{display:flex}`，flex 失效 → 图标独占一行、文字掉第二行居中。
- 历史坑：上一个提交 `cbe042d` 只改了 HTML 的 `<span>` 和 CSS 的 `svg{display:block}`，**没碰那行 JS**，所以没修好。
- 修复：改为 `scanBtn.style.display = ''`，回落 CSS flex。

### 2. APK 每版签名不同，无法覆盖安装
- 根因：CI 跑 `./gradlew assembleDebug`，而 `build.gradle` 无 `signingConfigs` → 用 AGP 默认调试签名。GitHub runner 全新环境，每版自动生成一把新 `debug.keystore` → 签名每次不同 → Android 拒绝覆盖。
- 修复：仓库内置固定 keystore `android/app/cuckoo-release.keystore`（PKCS12，alias `cuckoo`，密码 `cuckoo-remote-2026`，CN=Cuckoo Remote，有效至 2056），`build.gradle` 的 **debug 与 release 两个变体都指向它**。
- 同时把 `versionCode/versionName` 从 10153/0.10.153 对齐到 10166/0.10.166（CI 仍由 sync-version.js 按 tag 覆盖）。

## 关键取证
- **反向验证**：把产物临时改回 `'block'`，Playwright 实测 `computedStyle.display === 'block'`、布局错位；改回 `''` 后为 `flex`，图标与文字中心线偏差 **0px**、gap **8px**（390×844 视口，截图见 `D:\cuckoo-code\mcp-cwd\.agents\tmp\scan-fixed.png`）。
- **浏览器场景不回归**：独立 page（无 `window.Capacitor`）实测扫码按钮与地址行均 `display:none`。
- **keystore 可被 Java 读取**：临时下载 JDK21 JRE，用其 `keytool -list -v` 成功读出 `PrivateKeyEntry`，`SHA256: C1:F9:DF:3F:…:1C:6E:C6`，签名算法 `SHA256withRSA`（与 openssl 输出一致）。验证后已删除临时 JRE。
- **cap sync 不会重写** `android/app/build.gradle`（只写 `capacitor.build.gradle`），签名配置安全。

## 验证结果
- `npm run typecheck` ✅
- `npm test` ✅ 131 文件 / 1299 用例全过
- `npm run lint` ✅ 0 error（65 个既有 warning）
- `npm run compile` ✅
- 布局：Playwright 实测 ✅（原生壳 + 浏览器两场景）
- keystore：keytool 实读 ✅
- **未做**：CI 实跑（需推 tag）、真机安装覆盖升级

## 安全声明（务必保留）
`cuckoo-release.keystore` 与密码**明文随仓库公开**，等同公开私钥：仅用于内部覆盖升级，**不可用于商店分发**。任何拿到仓库的人都能签出可覆盖本 App 的 APK。若未来需私密签名，改走 CI Secrets 并轮换密钥（届时老用户需再卸载重装一次）。

## 迁移成本
旧版 APK 各自用不同临时 debug 签名，**首次升级必须卸载重装一次**；本版起后续版本签名恒定，可正常覆盖。

## 待办
- 推送分支、合入 master、递增版本号 + 更新 CHANGELOG + 打 tag 触发 CI（用户确认后再做）。
- CI 实跑后核对 APK 签名指纹是否恒定（`keytool -printcert -jarfile xxx.apk`）。
- 真机安装验证覆盖升级。
- 本文件上方的 092 章节（子代理并发池）仍有真机验证清单 A~H 未做，遗留至今。
- **v0.10.164 tag 违规**（含数字 4）已推 origin，是否删除仍待用户决定。

## 教训（延续）
- 改 UI 布局类 bug，光看 CSS/HTML 不够——**必须 grep 是否有 JS 在写内联 `style.display`**，内联样式优先级高于样式表。上一个提交就栽在这里。
- 涉及签名/证书，别只信 openssl 自检，**用目标 JDK 的 keytool 实读一次**才算闭环。
