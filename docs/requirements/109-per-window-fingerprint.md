# 需求 109：每窗口自动分配独立浏览器硬件指纹

## 一、背景与动机
- **当前状态**：已完成 (Completed)
- **多账号与防风控诉求**：用户在多窗口架构中管理不同平台与多个账号，除了已实现的独立网络代理（SOCKS5/HTTP）、独立时区语言与 Cookie 隔离外，需要实现更底层的**物理硬件层隔离**。
- **痛点分析**：
  1. 同一物理机器的多窗口具有相同的 Canvas、Audio、CPU 核心数、内存和显卡特征，极易被高级反欺诈大数据打上“关联账号”标签；
  2. 市面上低劣的指纹插件采用“随机噪点”方案，破坏重入一致性（多次提取 Hash 发生改变），容易被 Cloudflare Turnstile、DataDome、Arkose 等现代风控系统秒级识别为“恶意注入与篡改”；
  3. 参数自相矛盾（如 Windows 系统搭配 Mac 显卡驱动、64 核配 2GB 内存）易在异常检测模型中直接被拦截。
- **目标**：为每一个窗口（Profile）**全自动分配并持久化绑定**一套真实自洽、无原型链破绽、重入 100% 幂等的硬件指纹（包含 CPU 并发核心、设备内存、屏幕分辨率/DPR、WebGL 渲染器/供应商、Canvas 确定性微扰与 Audio 确定性微扰）。

## 二、架构设计与方案

1. **真实硬件模板池（Hardware Presets Pool）**：
   - 预设 6 套来源于真实主流 Windows PC 的自洽配置（Intel UHD 630、Intel Iris Xe、NVIDIA RTX 3060、NVIDIA RTX 4070、AMD RX 6600、Intel UHD 770）；
   - 各维度的 CPU、内存、显卡驱动字符串、屏幕几何参数均在现实中真实存在且完全吻合。
2. **窗口自动分配与持久化**：
   - Profile 创建或加载时若无指纹配置，通过确定性哈希散列算法自动抽取一套硬件模板并生成唯一的微扰种子（`canvasSeed`、`audioSeed`）；
   - 持久化保存在 `profile.fingerprint`，实现同一窗口生命周期内指纹“终生固化绑定”，绝不动态跳变。
3. **主世界原生镜像注入（Anti-detect Native Cloaking）**：
   - **重入一致性保证**：Canvas 确定性微扰基于种子与坐标运算，多次提取 `toDataURL()` / `getImageData()` 输出 100% 相同哈希；
   - **原生契约对齐**：所有被覆盖的函数及 Getter（`hardwareConcurrency`、`deviceMemory`、`getParameter`、`toDataURL`、`getChannelData`）通过 WeakMap 伪装 `Function.prototype.toString`，全部返回 `function () { [native code] }`，严格保持原生属性描述符（`enumerable: true`, `configurable: true`）；
   - **CDP 原生屏幕指标接管**：通过 `Emulation.setDeviceMetricsOverride` 原生覆盖屏幕分辨率与 DPR。
4. **依赖与隔离**：
   - 独立模块 `src/app/fingerprint.ts`；
   - 与 `src/app/net-identity.ts` 无缝联动，合并为一个 CDP `Page.addScriptToEvaluateOnNewDocument` 脚本，零额外进程，<3KB 极小体积，<0.1ms 微秒级耗时。

## 三、验收标准

1. 新建任何窗口时，无需手动配置即可自动获得完整的 `profile.fingerprint`；
2. 旧窗口读取时自动向后兼容补齐；
3. 单元测试覆盖模板生成、散列分配、注入脚本生成、重入幂等性与原生 toString 伪装；
4. 全量类型检查、代码规范、测试套件与编译打包 100% 全绿通过。
