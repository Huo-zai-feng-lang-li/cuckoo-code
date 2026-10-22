# 最新接续状态 (2026-10-23)

## 已发布 v0.10.44

### 本轮改动 (v0.10.44)

| 版本 | 类型 | 内容 | 影响面 |
|---|---|---|---|
| v0.10.44 | fix | 窗口底栏"对话上下文"实时刷新（原只在整轮结束更新，流式中一直停在旧值） | `src/overlay/events.ts` |
| v0.10.44 | fix | 切会话时旧会话残余流帧污染新会话底栏（SPA 切会话不中断 fetch） | `events.ts` / `observer.ts` / `hooks/deepseek.ts` |
| v0.10.44 | fix | 手机端多个思考块同时展开时被 flex 压扁、正文裁切 | `src/remote/pwa/style.css` |

### 关键实现

- **底栏实时刷新**：新增 `liveContext`（仅显示，不写缓存/不累加）；显示优先级 `实时 > 本会话缓存 > 服务端最近值`；`onStream` 收到 acc 即刷新（500ms 节流，finished 立即刷）；IPC 签名去重；子代理窗口跳过广播。
- **跨会话隔离**：`dispatchStream`/`observeBody` 加 `sessionId` 参数（fetch 传 `fetchSessionId`、XHR 传 `reqSessionId`），observer 透传，overlay 校验不匹配则丢弃；任一方缺失放行（兼容 ChatGPT/Claude）。
- **思考块高度**：根因是 `.messages` 为 flex column + `.think-block` 的 `overflow:hidden` 使 `min-height:auto` 解析为 0，被 `flex-shrink:1` 压扁。修复：`.msg` 统一加 `flex-shrink: 0`。实测三块 377px→222px 的压扁已消除。

### 验证状态

- typecheck / test(129 文件 1230 条) / lint(0 errors) / compile 全绿
- 真机（开发版干净实例，CDP 注入）：
  - 同会话 acc=54321 → 底栏 2.26万 → 5.43万 实时跟随
  - 异会话 acc=999888 → 底栏不动，正确拦截
  - 思考块：修复前三块均 222px，修复后均 377px；逐块独立展开/收起正常（open 377 / closed 38）；user/ai/sys 三类消息无回归

### 关键教训（重要，下次别再踩）

1. **杀 electron 进程别用 bash 后台任务的 PID**：`Stop-Process -Id <bash任务PID>` 杀不掉 electron 主进程。曾因此让最早实例（PID 7988）一直霸占 9444 端口，后续"重启"全部失败，CDP 一直连僵尸进程跑旧代码，白白排查了十几轮。
   **正确做法**：`Get-NetTCPConnection -LocalPort 9444 -State Listen` 查真实占用者再杀；或 `Get-CimInstance Win32_Process` 按命令行筛选 `cuckoo-dev-verify` 全部清理。
2. **验证前先确认端口占用者已更换**，否则所有探针结果都不可信。
3. **CDP 注入要注意 execution context**：overlay 与页面脚本同在 isolated world，页面主世界是另一个 context，注入/读取必须选对。
4. `test/infra/run-captured.test.js` 的 A-006 用例偶发超时失败（进程时序敏感），单独重跑即过，非真实回归。

### 已知遗留（有意不修）

- 底栏实时刷新只验证了 DeepSeek（ChatGPT/Claude 不下发 accumulatedTokens，走原路径，理论无回归但未真机跑）
- 500ms 节流未做长时间（10 分钟级）压测
- 跨会话中断为 CDP 模拟派发，非真实"生成中手动切会话"

### 历史版本

- v0.10.43: 工具代码块内 JSON/XML 误触纠错、插件显隐、系统 Prompt 重构
- v0.10.42: fix(retry) 发送重试提示词前检查输入框
- v0.10.41 / v0.10.40: 手机端切窗口同步提示 / 补发历史
- v0.10.31 ~ v0.10.39: 详见 CHANGELOG.md

---

## 历史（v0.10.30 及之前）

见 CHANGELOG.md。master 在 v0.10.30 时为 `e89b72b`。
