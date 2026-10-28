---
id: 094
type: fix
title: 远程扫码按钮布局修复 + APK 固定签名（支持覆盖升级）
status: done
branch: fix/094-remote-scan-and-apk-signing
created: 2026-10-29
updated: 2026-10-29
---

# 需求 094：远程扫码按钮布局修复 + APK 固定签名（支持覆盖升级）

## 1. 背景
用户反馈两个问题：
1. 手机端登录页「扫码连接电脑」按钮布局错乱——图标与文字上下堆叠、文字居中，不在同一行。
2. 每个新版本 APK 安装时提示「签名不一致」，无法覆盖升级，只能卸载重装。

## 2. 根因定位（已取证）

### 2.1 扫码按钮错位
- `src/remote/pwa/app.js:206` 在原生壳分支里执行 `scanBtn.style.display = 'block'`。
- 这是**内联样式**，优先级高于 `src/remote/pwa/style.css:328` 的 `#btn-scan { display: flex }`。
- 结果：flex 布局完全失效，`#btn-scan svg` 的 `display:block` 让图标独占一行，`<span>扫码连接电脑</span>` 掉到第二行并被父级 `text-align:center` 居中。
- 佐证：上一个提交 `cbe042d`（"align scan button icon and text"）只补了 HTML 的 `<span>` 与 CSS 的 `svg{display:block;flex-shrink:0}`，**没有改这行 JS**，所以没修好。
- 反向验证：把产物临时改回 `'block'` 后 Playwright 实测 `getComputedStyle(btn).display === 'block'`，flex 失效；改回 `''` 后为 `flex`。

### 2.2 APK 签名不一致
- `.github/workflows/release.yml:88` 执行的是 `./gradlew assembleDebug`。
- `android/app/build.gradle` 原本没有任何 `signingConfigs`，debug 变体使用 AGP 的**默认调试签名**：当 `~/.android/debug.keystore` 不存在时自动生成一把新的。
- GitHub Actions runner 是全新环境，**每个版本都会重新生成一把不同的 debug.keystore** → 每次 CI 产出的 APK 签名都不一样 → Android 拒绝覆盖安装。
- 附带问题：仓库里 `versionCode/versionName` 硬编码为 `10153 / 0.10.153`，落后于当前 v0.10.166（CI 里由 `scripts/sync-version.js` 按 tag 临时改写，本地与实际产物不同步）。

## 3. 方案

### 3.1 扫码按钮（src/remote/pwa/app.js）
`scanBtn.style.display = 'block'` → `scanBtn.style.display = ''`，清空内联样式后回落到 CSS 的 `display:flex`，图标与文字恢复同一行、垂直居中。
浏览器场景分支（`display='none'`）保持不变。

### 3.2 固定签名（android/app/ 新增 keystore + build.gradle）
- 新增仓库内置签名文件 `android/app/cuckoo-release.keystore`（PKCS12，别名 `cuckoo`，CN=Cuckoo Remote，有效期至 2056，SHA256 指纹 `C1:F9:DF:3F:…:1C:6E:C6`）。
- `android/app/build.gradle` 新增 `signingConfigs.release` 指向该文件，**debug 与 release 两个变体都用它签名**。
  - debug 也走固定签名，因为 CI 当前构建的是 `assembleDebug`；两变体同签名后，未来无论产出哪种包都能互相覆盖。
- `versionCode / versionName` 对齐当前版本（随发版由 `sync-version.js` 按 tag 覆盖）。

### 3.3 迁移说明
旧版本 APK 用的是各自临时生成的 debug 签名，与新固定签名不同，**首次升级需要卸载旧版重装一次**；从本版起后续版本签名恒定，可正常覆盖升级。

### 3.4 安全声明（重要）
`cuckoo-release.keystore` 与其密码**明文随仓库公开**，等同公开签名私钥：
- 仅用于内部/个人覆盖升级，**不可用于正式商店分发或需要防伪的场景**。
- 任何拿到本仓库的人都能签出可覆盖本 App 的 APK。若未来需要私密签名，应改为 CI Secrets 注入并轮换密钥（届时老用户需再卸载重装一次）。

### 3.5 为何仍用 assembleDebug
CI 保持 `./gradlew assembleDebug` 而非改 `assembleRelease`，是为把改动面压到最小（release 会改变产物路径与命名、需额外核对 minify/R8）。debug 包仅多出 `android:debuggable="true"`，对本 App（本机 PWA 客户端，无敏感本地数据）无实质影响。若后续需要 release 包，只需把 workflow 的 `assembleDebug` 换成 `assembleRelease` 并同步改产物路径（签名配置已就绪，无需再动 `build.gradle`）。

## 4. 涉及文件
- `src/remote/pwa/app.js`
- `android/app/build.gradle`
- `android/app/cuckoo-release.keystore`（新增）
- `android/.gitignore`（补注释说明 keystore 为有意入库）
- `.github/workflows/release.yml`（无逻辑改动，保持 `assembleDebug`）

## 5. 验收标准
- [x] 原生壳模式下，扫码按钮 `display:flex`、图标与文字中心线偏差 0px、gap 8px（Playwright 390×844 实测 + 截图确认）
- [x] 浏览器模式下，扫码按钮与地址输入行均保持隐藏（独立 page 实测 `hasCapacitor:false` → `display:none`）
- [x] keystore 可被读取：私钥可解出、证书 keyUsage=Digital Signature/Key Encipherment、extendedKeyUsage=Code Signing
- [x] `npm run typecheck` / `npm test`（131 文件 1299 用例）/ `npm run lint`（0 error）/ `npm run compile` 全绿
- [ ] CI 实跑一次，确认 APK 签名指纹在不同 tag 间恒定（需推送 tag 后验证）
- [ ] 真机安装验证覆盖升级

## 6. 遗留
- 旧版用户首次升级需卸载重装一次（签名切换的必然代价）。
- 若后续要上架商店或需要私密签名，迁移到 CI Secrets 并轮换密钥。
