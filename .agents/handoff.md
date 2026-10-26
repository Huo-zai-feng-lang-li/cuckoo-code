# 会话接续状态

## 最近完成的工作
- **Cuckoo 远程控制 PWA 深度优化 (v0.10.71)**：
  - **秒开体验**：引入本地历史缓存，启动/切后台直接渲染，不再有“正在同步”或“重连中”的闪烁。缓存按 `profileId` 隔离，防止多窗口串台。
  - **设备去重**：`clientId` 从 `sessionStorage` 迁移至 `localStorage`，切后台保持唯一，服务端秒踢旧连接，在线数精准锁死。
  - **IP 详情**：接入百度 `qifu.baidu.com` IP 画像接口（去除了误导性的风控标签），前端使用 `📍 地区` / `📡 网络` 两行卡片布局展示。
  - **安全与稳定性**：修复 `sanitize` 的 XSS 绕过风险；修复 `case` 作用域导致的 Lint 报错；缩短探活与 IPC 超时，提升重连速度。

## 验证结果
- Typecheck / Test (1245 用例) / Lint (0 error) / Compile 全绿。
- 远端 master 与 v0.10.71 已同步。

## 待办 / 备注
- **GitHub Release 标记**：由于连续推送 Tag 导致竞态，需在网页端手动将 v0.10.71 的 Release 设为 Latest。
