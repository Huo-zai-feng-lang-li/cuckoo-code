# 最新接续状态 (2026-11-10 13:45)

## 核心进展

分支 `fix/112-runtime-consistency`（基线 e313aa9 / v0.10.213 → 目标 **v0.10.215**）。**全部修复完成并真机验证通过，四绿全绿，准备提交打 tag。**

四绿：`typecheck` ✅ / `lint` 0 errors ✅ / `test` 135 文件 1395 用例 ✅ / `compile` ✅

## 本轮修复（4 个真实 bug）

### 1. 纯净模式思考/正文重复渲染（两份、三份）
- **真凶**：不是「SET 覆盖语义」，而是 `BATCH` 批量帧。`flattenDelta`（deepseek-protocol.ts:26-41）展开 BATCH 时子项 `o` **继承 'BATCH'**，旧 `planFragmentsUpdate` 只认 `op === 'SET'` 才重置 → 整组重放的 BATCH 帧被当增量累加。
- **修法**：改内容前缀判定。`planFragmentsUpdate` 新增 `prevText/prevThink/nextText/nextThink` 四个可选参数；本帧重建内容以已累积内容为前缀（含相等）→ 快照重放，重置；否则真实增量，追加。无内容信息时退回旧的类型判定（向后兼容）。
- 涉及 `src/providers/hooks/shared/deepseek-protocol.ts`、`src/providers/hooks/deepseek.ts`（fragments 分支改为先算 frameText/frameThink 再判定）。新增 4 条回归用例。

### 2. 平台选择页「API 未就绪」/ 开发环境无法新建窗口
- **真凶**：我此前收紧主世界暴露时删掉了 `contextBridge.exposeInMainWorld`，但 `platform-select.html` 运行在主世界、脚本直接读 `window.electronAPI`。新建窗口必然加载该页 → 永远报错。
- **修法**：按协议判据恢复暴露——**仅 `file://` 本地页面暴露**，远程 AI 页面（https）继续零暴露。涉及 `src/bridge/api.ts`。

### 3. 发送延迟设置「过一会儿自己恢复成 6s」
- **真凶**：overlay 设置面板保存时只写 localStorage + state，**从不通知主进程**；而 `agent-settings.json` 才是唯一真相源，任何一次 `cuckoo-sync-settings` 广播都会把文件里的旧值写回 localStorage，覆盖用户刚改的配置。
- **修法**：overlay 保存后同步调用新增的 `electronAPI.saveSettingsGlobal`（走 `save-settings` IPC），与壳页面共用同一条落盘+广播链路。涉及 `src/bridge/api.ts`、`src/overlay/panels/settings.ts`。

### 4. 初始提示只回显不发送 + randomDelay 分布偏低
- 初始提示：`sendInitialPromptToInput` 原用 `randomDelay(系统提示词)`，数万字符顶到配置上限（默认 36s）。改为 0ms 立即发送。
- randomDelay：原 `cognitiveBase = 3000 + min(20000, len/100*800)` 硬上限只有 23000ms。改为 `ratio = min(1, len/4000)` 线性映射到 [min,max]。
- 涉及 `src/overlay/chat-input.ts`，含 2 条回归用例。

## 真机验证结果（开发版 + CDP 9444，DeepSeek 已登录）

| 验证项 | 结果 |
|---|---|
| 远程 AI 页面主世界 API | `typeof window.electronAPI === 'undefined'`，`hasExecuteJs === false` ✅ |
| 新建窗口 | `{success:true}`，平台选择页正常渲染 4 个卡片，`hasAPI: object` ✅ |
| 设置落盘 | 保存 11/55 → `~/.cuckoo/agent-settings.json` 为 11/55 ✅ |
| 设置广播同步 | AI 页面 localStorage 同步 `11000/55000`，不再被冲回 6/36 ✅ |
| 恢复默认 | 保存 6/36 → localStorage `6000/36000` ✅ |

## 需求 112 全部内容（均已暂存）

- 四份 `src/prompt/*.md`：edit 失败先 read 重取原文
- `src/app/fingerprint.ts`：移除 Screen / DPR 伪造，保留 Chromium 真实值
- `src/app/net-identity.ts` + `entry.ts`：代理切换强一致、失败传播、WeakMap 幂等锁
- `src/bridge/api.ts`：收紧主世界 electronAPI 暴露
- `docs/requirements/112-runtime-consistency.md`

## 待办事项 (Next Steps)

- [ ] 暂存所有改动（含 `src/overlay/panels/settings.ts` 未暂存部分）
- [ ] 提交（提交信息含 4 个修复 + 需求 112）
- [ ] push 分支 + 打 tag `v0.10.215` + push tag
- [ ] 核验远程引用与 CI
- [ ] **待用户真机确认**：纯净模式思考不再重复、初始提示立即发出、长延迟可逼近配置上限

## 关键上下文

- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 分支: `fix/112-runtime-consistency`
- 版本: `0.10.215`（已跳过含 4 的 0.10.214，三处一致：package.json / CHANGELOG 顶部 / 待打 tag）
- 主要文件:
  - `src/providers/hooks/shared/deepseek-protocol.ts` → `planFragmentsUpdate`（内容前缀判定）
  - `src/providers/hooks/deepseek.ts` → `consumeSingleDelta` 的 fragments 分支
  - `src/bridge/api.ts` → 协议判据暴露 + `saveSettingsGlobal`
  - `src/overlay/panels/settings.ts` → `saveSettings` 同步主进程
  - `src/overlay/chat-input.ts` → `randomDelay` / `sendInitialPromptToInput`
- 真机测试方式: `$env:CUCKOO_SESSION_DIR='cuckoo-dev-verify'; Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.','--remote-debugging-port=9444'`
- **注意**：打包版 `Cuckoo-Code.exe` 占 7799 端口是正常的，不要 kill。开发版独立用 `cuckoo-dev-verify` userData。
- 已知坑: PowerShell 按 GBK 解码 UTF-8 导致中文乱码，读文件显式用 UTF-8 或 Node 读。
