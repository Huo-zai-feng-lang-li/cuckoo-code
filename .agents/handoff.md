# 最新接续状态 (2026-11-10 14:01)

## 核心进展

**需求 112 已合并 master 并发布 v0.10.215。**

- 合并提交：`a2f5461 merge: 合并需求 112（运行一致性、重复渲染与设置回退修复）`
- 功能提交：`c39cf03 fix: 修复纯净模式重复渲染、设置回退、平台页 API 与延迟分布 (v0.10.215)`
- 分支：`fix/112-runtime-consistency` → 已合并 master
- tag：`v0.10.215`（跳过含 4 的 0.10.214），分支与 tag 均指向 `c39cf03`
- CI：Build and Release **success**（3m24s）
- 四绿：typecheck / lint(0 errors) / test(135 文件 1395 用例) / compile

## 本轮交付的 4 个真实修复

### 1. 纯净模式思考/正文重复渲染（两份、三份）
- **真凶**：不是「SET 覆盖语义」，而是 `BATCH` 批量帧。`flattenDelta`（deepseek-protocol.ts:26-41）展开 BATCH 时子项 `o` **继承 'BATCH'**，旧 `planFragmentsUpdate` 只认 `op === 'SET'` 才重置 → 整组重放的 BATCH 帧被当增量累加。
- **修法**：改内容前缀判定。`planFragmentsUpdate` 新增 `prevText/prevThink/nextText/nextThink` 四个可选参数；本帧重建内容以已累积内容为前缀（含相等）→ 快照重放，重置；否则真实增量，追加。无内容信息时退回旧的类型判定（向后兼容）。
- 涉及 `src/providers/hooks/shared/deepseek-protocol.ts`、`src/providers/hooks/deepseek.ts`。新增 4 条回归用例。

### 2. 平台选择页「API 未就绪」/ 开发环境无法新建窗口
- **真凶**：收紧主世界暴露时误删 `contextBridge.exposeInMainWorld`，而 `platform-select.html` 运行在主世界、脚本直接读 `window.electronAPI`。新建窗口必然加载该页 → 永远报错。
- **修法**：按协议判据恢复——**仅 `file://` 本地页面暴露**，远程 AI 页面（https）继续零暴露。

### 3. 发送延迟设置「过一会儿自己恢复成 6s」
- **真凶**：overlay 设置面板保存时只写 localStorage + state，**从不通知主进程**；`agent-settings.json` 才是唯一真相源，任何一次 `cuckoo-sync-settings` 广播都会把文件旧值写回 localStorage，覆盖用户刚改的配置。
- **修法**：overlay 保存后同步调用新增的 `electronAPI.saveSettingsGlobal`（走 `save-settings` IPC），与壳页面共用同一条落盘+广播链路。

### 4. 初始提示只回显不发送 + randomDelay 分布偏低
- 初始提示：`sendInitialPromptToInput` 原用 `randomDelay(系统提示词)`，数万字符顶到配置上限（默认 36s）。改为 0ms 立即发送。
- randomDelay：原 `cognitiveBase = 3000 + min(20000, len/100*800)` 硬上限只有 23000ms。改为 `ratio = min(1, len/4000)` 线性映射到 [min,max]。

## 真机验证结果（开发版 + CDP 9444，DeepSeek 已登录）

| 验证项 | 结果 |
|---|---|
| 远程 AI 页面主世界 API | `typeof window.electronAPI === 'undefined'`，`hasExecuteJs === false` ✅ |
| 新建窗口 | `{success:true}`，平台选择页正常渲染 4 个卡片，`hasAPI: object` ✅ |
| 设置落盘 | 保存 11/55 → `~/.cuckoo/agent-settings.json` 为 11/55 ✅ |
| 设置广播同步 | AI 页面 localStorage 同步 `11000/55000`，不再被冲回 6/36 ✅ |
| 恢复默认 | 保存 6/36 → localStorage `6000/36000` ✅ |

## 待办事项 (Next Steps)

- [ ] **待用户真机确认三项**（我无法在不开真实对话的情况下验证）：
  - 纯净模式开深度思考，思考块是否还重复
  - 「用该项目新建会话」提示词是否立即发出
  - 延迟调成 10~60s，观察是否真有接近 60s 的等待
- [ ] 若三项验证发现问题，从 master 开新分支修

## 关键上下文

- 目录: `D:\Desktop\Super-File\cuckoo-code`
- 当前分支: `master`
- 版本: `0.10.215`
- 主要文件:
  - `src/providers/hooks/shared/deepseek-protocol.ts` → `planFragmentsUpdate`（内容前缀判定）
  - `src/providers/hooks/deepseek.ts` → `consumeSingleDelta` 的 fragments 分支
  - `src/bridge/api.ts` → 协议判据暴露 + `saveSettingsGlobal`
  - `src/overlay/panels/settings.ts` → `saveSettings` 同步主进程
  - `src/overlay/chat-input.ts` → `randomDelay` / `sendInitialPromptToInput`
- 真机测试方式: `$env:CUCKOO_SESSION_DIR='cuckoo-dev-verify'; Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.','--remote-debugging-port=9444'`
- **注意**：打包版 `Cuckoo-Code.exe` 占 7799 端口是正常的，不要 kill。开发版独立用 `cuckoo-dev-verify` userData。
- 已知坑: PowerShell 按 GBK 解码 UTF-8 导致中文乱码，读文件显式用 UTF-8 或 Node 读。
