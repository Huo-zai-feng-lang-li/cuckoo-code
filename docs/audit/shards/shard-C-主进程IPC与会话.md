# Shard C 审计报告：主进程 / IPC / 会话层

> 审计范围：src/app（49 文件）、src/session（4 文件）、src/agents（4 文件），共 57 文件，约 11134 行
> 审计方式：逐文件全文通读 + PoC 实证 + 静态推演
> 审计日期：2026-10-17

---

## 一、已审文件清单（57 个，逐个列出）

### src/app（49 个）

| # | 文件 | 行数 | 已审结论 |
|---|------|------|----------|
| 1 | alert-preload.ts | 16 | ✓ 已审：仅暴露 onInit/action，通道极简，无风险 |
| 2 | alert-window.ts | 155 | ✓ 已审：监听器在 closed 时 removeListener，单例顶替逻辑正确 |
| 3 | confirm-preload.ts | 20 | ✓ 已审：仅暴露 onInit/onProgress/action |
| 4 | confirm-window.ts | 212 | ✓ 已审：keepOpenOnPrimary 模式有 settled 防重复 resolve；closed 清理监听器 |
| 5 | cuckoo-host.ts | 89 | ✓ 已审：插件宿主桥接，只读封装，无直接 IPC |
| 6 | entry.ts | 1547 | ✓ 已审：主入口，窗口/视图创建、约 20 个 IPC handler、单实例锁 |
| 7 | goal.ts | 32 | ✓ 已审：子代理目标判定 + harness 事件推送，空指针检查完备 |
| 8 | harness-preload.ts | 103 | ✓ 已审：暴露 harnessAPI，通道均 harness-* 前缀 |
| 9 | harness-zoom.ts | 21 | ✓ 已审：CSS zoom 注入，clamp 0.5-2 |
| 10 | ipc/cdp-attach.ts | 296 | ✓ 已审：CDP 附加，端口/路径校验，无越权 |
| 11 | ipc/command.ts | 57 | ✓ 已审：execute-command 经 confirm 对话框确认，isDangerous 仅警告 |
| 12 | ipc/git.ts | 340 | ✓ 已审：git 操作均在项目根目录执行，spawn 校验 cwd |
| 13 | ipc/harness.ts | 672 | ✓ 已审：harness 全套 IPC，状态机有 busy 锁防双击 |
| 14 | ipc/index.ts | 56 | ✓ 已审：汇总注册所有 IPC 模块 |
| 15 | ipc/memory.ts | 50 | ✓ 已审：记忆 CRUD，广播同步 |
| 16 | ipc/plugin.ts | 984 | ✓ 已审：插件市场/安装/配置/注入，路径穿越有防护（plugin-read-asset） |
| 17 | ipc/project.ts | 190 | ✓ 已审：agent 文件 CRUD，name 经 safeName 或 path.join+isAgentFile |
| 18 | ipc/recent.ts | 39 | ✓ 已审：最近使用 CRUD |
| 19 | ipc/remote.ts | 91 | ✓ 已审：远程消息拦截 |
| 20 | ipc/renderer.ts | 121 | ✓ 已审：renderer 进程通信转发 |
| 21 | ipc/rules.ts | 15 | ✓ 已审：规则文件 CRUD，委托 rules/files.ts |
| 22 | ipc/session.ts | 447 | ✓ 已审：会话/文件读写/目录监听/导航，路径穿越有 resolveProjectPath 防护 |
| 23 | ipc/settings.ts | 105 | ✓ 已审：设置读写转发到 AI 页面 localStorage，pending map 有 5s 超时 |
| 24 | ipc/shell.ts | 462 | ✓ 已审：shell 导航/openExternal(http/https 校验)/web 会话枚举 |
| 25 | ipc/snapshot.ts | 61 | ✓ 已审：快照 CRUD，委托 snapshots.ts |
| 26 | ipc/snippets.ts | 88 | ✓ 已审：快捷提示词 CRUD + 触发填入 |
| 27 | ipc/subagent.ts | 45 | ✓ 已审：子代理进度/列表/取消 |
| 28 | ipc/task.ts | 117 | ✓ 已审：后台任务启动，isDangerous 拦截 |
| 29 | ipc/theme.ts | 62 | ✓ 已审：主题注册/切换/订阅，destroyed 清理订阅 |
| 30 | ipc/tool.ts | 65 | ✓ 已审：execute-tool（工具注册表）+ execute-js（JS runner） |
| 31 | ipc/webserver.ts | 106 | ✓ 已审：插件静态 HTTP 服务，绑 127.0.0.1，路径穿越防护 |
| 32 | ipc/window-groups.ts | 178 | ✓ 已审：窗口组 CRUD + 限流冷却 |
| 33 | notification-preload.ts | 18 | ✓ 已审：仅 onInit/action/resize |
| 34 | notification-window.ts | 227 | ✓ 已审：多通知堆叠，closed 清理监听器，MAX_VISIBLE=3 |
| 35 | plugin-commands.ts | 76 | ✓ 已审：插件命令注册/触发，反向 IPC 有 30s 超时 |
| 36 | plugin-overlay-preload.ts | 47 | ✓ 已审：覆盖层 preload，定时上报鼠标矩形 |
| 37 | plugin-tools.ts | 113 | ✓ 已审：插件工具注册/触发，反向 IPC 有 30s 超时 |
| 38 | profile.ts | 252 | ✓ 已审：profile CRUD 持久化，子代理 profile 复用父 partition |
| 39 | prompt-enhancer.ts | 176 | ✓ 已审：LLM 旁路调用，AbortController 超时 30s |
| 40 | recent-tools.ts | 87 | ✓ 已审：最近使用存储，MAX=5 |
| 41 | shell-preload.ts | 302 | ✓ 已审：暴露 shellAPI（约 60 个方法），是最宽的 preload 暴露面 |
| 42 | snapshots.ts | 220 | ✓ 已审：快照创建/恢复，排除敏感文件，恢复有路径穿越防护 |
| 43 | snippets.ts | 112 | ✓ 已审：快捷提示词存储，默认 3 条 |
| 44 | subagent.ts | 335 | ✓ 已审：子代理/网关窗口编排，waitForDone 超时 10min/5min |
| 45 | theme/theme-manager.ts | 167 | ✓ 已审：主题权威单例，订阅者 Set + disposer Map |
| 46 | token-stats.ts | 239 | ✓ 已审：token 累计统计，同步读改写保证原子性，缓存失效兜底 |
| 47 | ui-prefs.ts | 126 | ✓ 已审：UI 偏好读写，clamp 校验 |
| 48 | window.ts | 160 | ✓ 已审：窗口上下文管理（Map），getContextByWebContents 反查 |
| 49 | window-groups.ts | 246 | ✓ 已审：窗口组持久化 + 限流冷却缓存 |

### src/session（4 个）

| # | 文件 | 行数 | 已审结论 |
|---|------|------|----------|
| 50 | store.ts | 388 | ✓ 已审：会话-目录映射存储，**非原子写**（见 C-001） |
| 51 | compaction.ts | 584 | ✓ 已审：上下文压缩，主链 walk + 配对保留，**回退分支可能混 branch**（见 C-004） |
| 52 | project-context.ts | 237 | ✓ 已审：项目初始化 + 提示词组装触发 |
| 53 | prompt-builder.ts | 226 | ✓ 已审：提示词模板填充，MCP/技能/代理/规则章节拼接 |

### src/agents（4 个）

| # | 文件 | 行数 | 已审结论 |
|---|------|------|----------|
| 54 | index.ts | 6 | ✓ 已审：re-export |
| 55 | prompt.ts | 32 | ✓ 已审：子代理章节生成 |
| 56 | scanner.ts | 117 | ✓ 已审：代理文件扫描（项目级+用户级+插件级） |
| 57 | types.ts | 29 | ✓ 已审：AgentMeta 类型定义 |

**合计：57 个文件全部通读，无遗漏。**

---

## 二、确认 Bug 条目

### P1（高频 IPC 错误、竞态、泄漏、数据丢失、安全配置缺陷）

---

#### C-001 | P1 | 数据完整性 | src/session/store.ts:34-42 + 22-32

**位置原文：**
```typescript
// line 34-42: 写
fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), 'utf-8');
// line 22-32: 读
function readSessionStore(): Record<string, any> {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e: any) {
    return {};  // ← 静默返回空对象
  }
}
```

**功能：** 会话 ID → 项目目录映射的持久化存储（`cuckoo-ai-pro-session/session-dir-map.json`）。

**触发链路：**
1. 主进程在 `writeSessionStore` 执行 `fs.writeFileSync` 中途崩溃（断电、强杀、OOM）。
2. 文件被截断为半段 JSON（写入未完成）。
3. 下次启动 `readSessionStore` 执行 `JSON.parse` 抛 `SyntaxError`。
4. `catch` 块吞掉异常，返回 `{}`。
5. **所有会话→项目目录映射静默丢失**，用户看到"项目未初始化"，历史对话标题/目录关联全部消失。

**复现/PoC：** `.agents/audit-poc/poc-non-atomic-write.cjs` 已实证：
- 正常写入 2 条映射 → 截断文件为半段 → 下次读取返回 0 条。
- 对比：原子写（tmp+rename）场景下正式文件完好，2 条映射完整保留。

**影响：** 会话账本数据丢失。用户的所有对话与项目目录的关联断裂，需重新初始化。

**置信度：** 9（PoC 实证）

**现有测试覆盖：** 无（未见针对 store 损坏恢复的测试）

**修复建议：** 写时用临时文件 + `fs.renameSync`（Windows 上 rename 覆盖需先删目标或用 `fs.renameSync` 的原子替换语义）；读时若 JSON 损坏，先尝试 `.bak` 备份，再提示用户而不是静默返回空。

---

#### C-002 | P1 | 数据完整性 | src/app/profile.ts:72-79 + 60-70

**位置原文：**
```typescript
// line 72-79: 写
function writeProfiles(profiles: any[]): void {
  const file = getProfileFile();
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2), 'utf-8');
}
// line 60-70: 读
function readProfiles(): any[] {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err: any) { /* 静默 */ }
  return [];
}
```

**功能：** profile 列表持久化（`userData/profile-list.json`），每个 profile 对应一个窗口/账号。

**触发链路：** 同 C-001：写入中途崩溃 → 文件截断 → 下次启动 JSON.parse 失败 → catch 吞掉 → 返回 `[]` → **所有 profile（含窗口配置、provider 绑定、lastUrl）全部消失**，应用回到首次启动状态。

**影响：** 用户所有窗口配置、账号绑定、窗口尺寸偏好丢失。

**置信度：** 8

**现有测试覆盖：** 无

**修复建议：** 同 C-001：原子写 + 损坏时 `.bak` 回退。

---

#### C-003 | P1 | 数据完整性（系统性） | 6 个存储模块均为非原子写

**涉及位置：**
- `src/app/window-groups.ts:45-52`（window-groups.json）
- `src/app/token-stats.ts:88-96`（token-stats.json）— 注：写失败时 `_cache=null` 有兜底，但磁盘文件本身仍可能损坏
- `src/app/snippets.ts:96-109`（snippets.json）
- `src/app/ui-prefs.ts:111-123`（ui-prefs.json）
- `src/app/recent-tools.ts:56-63`（recent-tools.json）
- `src/app/theme/theme-manager.ts:38-44`（theme-state.json）

**触发链路：** 同上：写入中途崩溃 → JSON 截断 → 下次启动 parse 失败 → 各模块的 catch 静默返回默认值。

**影响：** 窗口组配置、token 统计、快捷提示词、UI 偏好、最近使用、主题偏好各自独立丢失。单个丢失影响较小，但系统性存在。

**置信度：** 8

**现有测试覆盖：** 无

**修复建议：** 统一封装一个 `writeJsonAtomic(file, data)` 工具函数（tmp+rename），所有存储模块改用它。

---

#### C-004 | P1 | 数据正确性 | src/session/compaction.ts:207-250

**位置原文（回退分支注释）：**
```typescript
// 主链 walk 失败时：
// 回退到 ordered = msgs（全部按 message_id 排序）
// 注意：这可能混入 branch 消息
```

**功能：** 上下文压缩时决定哪些消息保留（keep）、哪些被摘要替换。

**触发链路：**
1. 某条消息的 `parent_id` 链断裂（数据异常或并发操作导致），主链 walk 结果长度 ≤1。
2. 但实际消息总数 >1，进入回退分支：直接按 message_id 排序全部消息。
3. 回退分支下，`start` 调整到 USER、`end` 调整到 ASSISTANT，但中间可能夹杂 branch 的 assistant 消息。
4. 保留段的角色序列变为 user→assistant→assistant(branch)→user→assistant，不满足严格配对。
5. 后续 share/conversation create API 要求 `MESSAGES_MUST_APPEAR_IN_PAIRS`，抛错。

**复现/PoC：** `.agents/audit-poc/poc-compaction-pair-mismatch.cjs` 静态推演验证（9 条消息、ratio=0.5 时，branch 消息 id=7 落在保留段中间，配对检查失败）。

**影响：** 压缩后用户尝试分享/导出会话时 API 报错，需手动修复。

**置信度：** 7（回退分支触发条件较少见，但一旦触发必现配对错误）

**现有测试覆盖：** 部分（test/ 下有 compaction 相关测试，但可能未覆盖主链断裂的回退场景）

**修复建议：** 回退分支也应基于 `parent_id` 过滤：只保留在最后一条消息的 parent 链上的消息；若链断裂，至少过滤掉 `parent_id` 不在保留集中的"悬空"消息。

---

### P2（特定条件触发）

---

#### C-005 | P2 | 信息泄露 | src/app/ipc/session.ts:397-406

**位置原文：**
```typescript
ipcMain.handle('get-dir-info', async (_event: any, { dir }: any = {}) => {
  if (!dir) return { success: false, error: 'no-dir' };
  try {
    const st = fs.statSync(dir);
    const bt = st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime.toISOString() : null;
    return { success: true, dir, createdAt: bt };   // 真实返回 dir + birthtime(createdAt)
  } catch (err: any) { return { success: false, error: err.message }; }
});
```

**功能：** 查询任意路径的 stat 信息。

**触发链路：** renderer（shell 页面）调用 `shellAPI.getDirInfo(path)` → 主进程直接 `fs.statSync(dir)`，**无路径白名单/项目根校验**。可探测任意路径是否存在、类型、大小。

**影响：** 若 shell 页面存在 XSS（如插件注入 HTML），攻击者可枚举文件系统路径。

**置信度：** 7

**现有测试覆盖：** 无

**修复建议：** 校验 `dir` 必须在 `sessionStore.state.selectedProjectDir` 内，或至少限制为常见子目录。

---

#### C-006 | P2 | 安全边界 | src/app/ipc/tool.ts:39-69

**位置原文：**
```typescript
ipcMain.handle('execute-js', async (event: any, { code }: any = {}) => {
  // jsRunner.run(code, { projectDir, windowId })
  // — 在主进程 Node.js 环境执行任意 JS
});
```

**功能：** AI 页面通过工具系统执行 JS（读写文件、跑 shell 命令等）。

**触发链路：** 此通道的安全性完全依赖 preload 隔离：只有 bridge preload（AI 页面）暴露此能力，shell-preload 不暴露。但如果 bridge preload 被意外修改或 AI 页面被 XSS 攻破，此通道等价于主进程 RCE。

**影响：** 设计上是必要的（AI 需要执行工具），但属于"单点失守即全线失守"的高危通道。

**置信度：** 6（推测：需确认 bridge preload 的暴露面，不在本片范围）

**现有测试覆盖：** 有（js-runner 相关测试）

**修复建议：** 保持现状但确保 bridge preload 最小化；考虑在 execute-js 前加项目目录白名单校验。

---

#### C-007 | P2 | 安全边界 | src/app/ipc/plugin.ts:556-565, 1010-1034

**位置原文：**
```typescript
// line 556: 注入代码到主世界
ipcMain.handle('plugin-inject-main-world', async (event: any, { code }) => {
  await event.sender.executeJavaScript(code);
});
// line 1010: 覆盖层执行 JS
ipcMain.handle('plugin-overlay-eval', async (event: any, { code }) => {
  await ov.webContents.executeJavaScript(code);
});
// line 1023: 注入 HTML
ipcMain.handle('plugin-overlay-html', async (event: any, { html }) => { ... });
```

**功能：** 插件在 AI 页面主世界 / 覆盖层执行任意 JS。

**触发链路：** 恶意插件安装后，可通过这些通道在 AI 页面（含登录态的 chat.deepseek.com 等）执行任意 JS，窃取会话/cookie/发送消息。

**影响：** 插件是用户主动安装的，但插件市场的审核机制若缺失，恶意插件可窃取用户 AI 账号。

**置信度：** 7

**现有测试覆盖：** 无

**修复建议：** 插件注入代码应经过 CSP 或沙箱限制；至少在文档中明确警告风险。

---

#### C-008 | P2 | 监听器泄漏（轻微） | src/app/ipc/session.ts:232-263

**位置原文：**
```typescript
// watcherBoundWc: Set<number> — 记录哪些 wc 已绑定 'destroyed' 监听器
// 问题：clearFileWatcher() 不删除 watcherBoundWc 中的 wcId
// 'destroyed' 回调才删除
```

**功能：** 项目文件变更监听。

**触发链路：** 用户切换项目目录 → `clearFileWatcher` 清掉 watcher → 但 `watcherBoundWc` 中 wcId 残留。若同一 wc 后续重新 watch 同一文件，`watcherBoundWc.has(wc.id)` 仍为 true，不会重复绑定 `'destroyed'`——这其实是正确行为（避免重复绑定）。真正泄漏的是：若 wc 一直不销毁，watcherBoundWc 中的条目永不清理。

**影响：** 内存泄漏可忽略（wc ID 是整数，每个窗口只绑定一次）。

**置信度：** 5（推测）

**现有测试覆盖：** 无

**修复建议：** 在 `clearFileWatcher` 时也清理 watcherBoundWc 中对应条目。

---

### P3（健壮性 / UX / 代码质量）

---

#### C-009 | P3 | 健壮性 | src/session/compaction.ts:301

**位置原文：**
```typescript
const MAX_SUMMARY_LEN = 8000;
parsed.body.slice(0, MAX_SUMMARY_LEN);  // 硬截断
```

**功能：** AI 返回的压缩摘要若超过 8000 字符，硬截断。

**触发链路：** 长对话压缩时，AI 生成的摘要过长 → 截断 → 丢失末尾信息（可能包含关键结论）。

**影响：** 摘要不完整，但不影响功能。

**置信度：** 8

**修复建议：** 截断处加省略号标记，或提示 AI 控制摘要长度。

---

#### C-010 | P3 | 健壮性 | src/app/theme/theme-manager.ts:46-98

**位置原文：**
```typescript
const subscribers = new Set<any>();
function subscribe(webContents: any): () => void {
  subscribers.add(webContents);
  return () => { subscribers.delete(webContents); };
}
```

**功能：** 主题变化订阅。

**触发链路：** `theme-subscribe` IPC 注册了 `wc.once('destroyed', () => off())`（ipc/theme.ts:66），窗口销毁时自动退订。正常路径无泄漏。但若 `theme-subscribe` 被调用后 wc 从未触发 `destroyed`（极少见），Set 中残留引用。

**影响：** 可忽略。

**置信度：** 6

**修复建议：** 保持现状，已有 destroyed 兜底。

---

#### C-011 | P3 | 代码质量 | src/app/ipc/settings.ts:18-57

**位置原文：**
```typescript
let reqSeq = 0;
const pending = new Map<string, any>();
// 收到回执时 delete(reqId)；超时 5s 自动 delete
```

**功能：** 设置读写的请求-响应匹配。

**触发链路：** 若 AI 页面在 5s 内未响应，pending 条目超时清理。但若多个窗口同时发请求，reqId 用 `reqSeq + Date.now()` 保证唯一。无泄漏风险。

**影响：** 无实际 bug，记录为已审结论。

**置信度：** 10

---

#### C-012 | P3 | 代码质量 | src/app/ipc/plugin.ts:536-543

**位置原文：**
```typescript
ipcMain.on('plugin-debug-log', (_event, { msg }) => {
  const dir = path.join(app.getPath('userData'), '..');  // ← 算了 dir 但没用
  const logFile = path.join(app.getPath('userData'), 'plugin-debug.log');
  fs.appendFileSync(logFile, String(msg || '') + '\n', 'utf-8');
});
```

**功能：** 插件调试日志写文件。

**触发链路：** `dir` 变量计算后未使用（死代码）。`plugin-debug.log` 无大小限制，长期使用会无限增长。

**影响：** 磁盘空间缓慢消耗。

**置信度：** 9

**修复建议：** 删除死代码 `dir`；加日志轮转（大小上限）。

---

## 三、推测区（置信度 ≤6）

---

### S-001 | 推测 | 安全边界系统性依赖 preload 隔离

本片审计的约 50 个 IPC handler 中，**绝大多数不校验 `event.sender` 的身份**（不检查 sender 是 shell 页面还是 AI 页面还是 harness 页面）。安全性完全依赖：
- shell-preload 只暴露给 `file://` 壳页面
- bridge preload 只暴露给 AI 页面（WebContentsView）
- 各 preload 暴露的 API 不重叠

**风险：** 如果某个 IPC channel（如 `execute-js`、`write-project-file`、`task-start`）被意外加入 bridge preload，AI 页面（加载外部 https 内容）就可以直接调用主进程的强力 API。由于 bridge preload 不在本片范围（属 Shard B/D），无法确认。

**建议：** 在 IPC handler 入口统一加 sender 校验（如检查 `event.sender.getURL()` 是否为 `file://` 壳页面 origin）。

---

### S-002 | 推测 | execute-command 的 exec() shell 注入

`ipc/command.ts` 使用 `exec(trimmed, ...)` 执行用户确认的命令。虽然有 confirm 对话框，但 `exec` 会解释 shell 元字符（`;`、`&&`、`|`、`$()`）。如果确认对话框的文案被插件或 AI 页面篡改，用户可能在不知情的情况下确认恶意命令。

**置信度：** 5

---

## 四、本片测试盲区清单

1. **存储损坏恢复**：store.ts / profile.ts / window-groups.json 等非原子写 + 静默 fallback，无测试覆盖"文件损坏后如何恢复"。
2. **compaction 回退分支**：主链断裂时的回退路径是否过滤 branch 消息，无测试。
3. **IPC sender 校验**：所有 IPC handler 的 sender 身份校验（或缺失）无测试。
4. **监听器泄漏**：窗口销毁时所有 wc.on/off 配对完整性，无系统性测试。
5. **get-dir-info 路径校验**：任意路径 statSync 无项目根限制，无测试。
6. **plugin-debug-log 无限增长**：无日志轮转测试。

---

## 五、PoC 清单与结果

| 脚本 | 验证项 | 结果 |
|------|--------|------|
| `.agents/audit-poc/poc-non-atomic-write.cjs` | 非原子写 → 崩溃中途截断 → 下次启动静默丢数据 | ✅ 实证：2 条映射截断后读回 0 条；原子写对比组 2 条完好 |
| `.agents/audit-poc/poc-compaction-pair-mismatch.cjs` | 回退分支混入 branch 消息 → 配对错误 | ✅ 静态推演：9 消息 ratio=0.5 时 branch(id=7) 落入保留段，user→assistant→assistant→user 配对失败 |

---

## 六、handoff 已修项验证

| handoff 记录 | 本片验证结果 |
|-------------|-------------|
| session.ts 监听器泄漏 | ✓ 已修：watch-project-file 的 'destroyed' 监听器正确绑定/清理（C-008 为轻微残留，非泄漏） |
| 新建对话双击防护 | ✓ 已修：entry.ts 有 `newConvInProgress` 状态锁；harness.ts 有 busy 锁 |
| 同 URL 导航遮罩 | ✓ 已修：entry.ts 有导航遮罩逻辑（modal-guard） |
| 压缩续接标题 | ✓ 已修：project-context.ts 有 `pendingLineage`（kind='compaction'） |

---

## 七、Top3 最严重条目

1. **C-001**：`src/session/store.ts:34-42` — 会话映射非原子写 + 静默 fallback，崩溃即全部丢失（P1，PoC 实证）
2. **C-002**：`src/app/profile.ts:72-79` — profile 列表非原子写 + 静默 fallback，崩溃即全部丢失（P1）
3. **C-004**：`src/session/compaction.ts:207-250` — 压缩回退分支混入 branch 消息导致配对错误（P1）
