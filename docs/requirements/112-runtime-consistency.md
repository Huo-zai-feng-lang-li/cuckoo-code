---
id: 112
type: fix
title: 编辑恢复、显示几何与代理切换一致性
status: done
branch: fix/112-runtime-consistency
created: 2026-11-10
updated: 2026-11-10
---

# 112：编辑恢复、显示几何与代理切换一致性

> 状态：**done**（2026-11-10，v0.10.215）
> 分支：`fix/112-runtime-consistency` → 已合并 master（a2f5461）

## 用户目标与约束

减少无效工具往返，保留模型有效上下文；4K 与多屏页面保持真实尺寸和缩放；保存代理后可靠生效。用户授权直接完成修复、验证并推送 tag。

账号封禁截图显示截止 November 12, 2026 18:51，但没有时区、平台判定细节或此次请求统计。不得把客户端缺陷或历史检测结果当作封禁的已证实原因，不承诺客户端修改可以解除账号限制。

## 实现范围

1. 四份模型提示词要求 edit 文本匹配失败后重新 read 相关片段，禁止凭记忆修改 oldString 重试；不改变模型选择、推理设置或内容截断策略。
2. 指纹脚本保留浏览器真实 Screen 与 devicePixelRatio；不通过缩小窗口、CSS 缩放、修改 viewport 来迎合固定屏幕预设，旧 profile 数据继续兼容。
3. 代理变更等待 setProxy 成功后关闭旧连接池；相同配置不重复关闭连接；失败向上传递，不报告成功、不直连加载目标站点。核查启动、保存、刷新和自动出口探测调用方。
4. 核查主世界 electronAPI 的真实调用方。若只供隔离 preload 使用，则移除不必要的主世界暴露，保留隔离世界接口及功能；不通过隐藏检测痕迹代替真实权限边界。
5. 记录审计证据，纠正历史 handoff 对封禁原因的过度归因。

## 验收

- 针对代理切换、失败传播及幂等性有回归证据。
- 在真实 Electron 中验证页面原生几何不被指纹脚本修改、隔离 API 可用且页面没有多余的 API 权限。
- typecheck、全量测试、lint、compile 通过；隔离 CUCKOO_HOME 启动验证并清理本任务进程。
- 更新 CHANGELOG、版本和 tag（下一版跳过含 4 的 0.10.214，使用 0.10.215）；推送后核验远程引用。

## 实现结果（v0.10.215）

| 项 | 实现 |
|---|---|
| 1. 提示词 edit 恢复 | 四份 `src/prompt/*.md` 增加「oldString 不匹配时禁止凭记忆重试，必须 read 后重取原文」 |
| 2. 指纹保留真实几何 | `src/app/fingerprint.ts` 移除 Screen / devicePixelRatio 伪造，保留 Chromium 原生值；旧 profile 字段继续兼容 |
| 3. 代理切换强一致 | `src/app/net-identity.ts` + `entry.ts`：setProxy 失败向上抛出 → 显示代理错误页而非直连；WeakMap 状态锁避免重复切连接池；首次应用不关连接池 |
| 4. 主世界 API 边界 | `src/bridge/api.ts`：仅 `file://` 本地页面通过 contextBridge 暴露，远程 AI 页面零暴露 |

## 验收结果

- 回归证据：`test/app/net-identity.test.js` 新增 5 条（失败传播、幂等关闭、代理→直连切换），`test/app/fingerprint.test.js` 更新真实几何断言。
- 真机（开发版 CDP 9444）：远程 AI 页面 `typeof window.electronAPI === 'undefined'`、`hasExecuteJs === false`；新建窗口正常加载平台选择页。
- typecheck / lint(0 errors) / test(135 文件 1395 用例) / compile 全绿。
- 版本 0.10.215（跳过含 4 的 0.10.214），三处一致；已推送分支与 tag，CI success（3m24s）。

## 顺带修复（同批提交的 4 个真实缺陷）

1. **纯净模式思考/正文重复**：真凶是 `BATCH` 批量帧的子项继承 `o='BATCH'`，旧判据只认 `SET` 才重置。改为内容前缀判定（`planFragmentsUpdate` 扩展 4 个可选参数）。
2. **平台选择页「API 未就绪」/ 无法新建窗口**：收紧暴露时误删 `exposeInMainWorld`，而该页跑在主世界。改为按 `file://` 协议判据恢复。
3. **发送延迟设置自我恢复**：overlay 保存只写 localStorage 不通知主进程，任何 sync 广播都会用文件旧值覆盖。改为走 `save-settings` IPC。
4. **初始提示只回显不发送 / 延迟分布偏低**：初始提示改 0ms；`randomDelay` 改按长度线性映射到配置区间。

## 实现结果（v0.10.215）

| 项 | 实现 |
|---|---|
| 1. 提示词 edit 恢复 | 四份 `src/prompt/*.md` 增加「oldString 不匹配时禁止凭记忆重试，必须 read 后重取原文」 |
| 2. 指纹保留真实几何 | `src/app/fingerprint.ts` 移除 Screen / devicePixelRatio 伪造，保留 Chromium 原生值；旧 profile 字段继续兼容 |
| 3. 代理切换强一致 | `src/app/net-identity.ts` + `entry.ts`：setProxy 失败向上抛出 → 显示代理错误页而非直连；WeakMap 状态锁避免重复切连接池；首次应用不关连接池 |
| 4. 主世界 API 边界 | `src/bridge/api.ts`：仅 `file://` 本地页面通过 contextBridge 暴露，远程 AI 页面零暴露 |

## 验收结果

- 回归证据：`test/app/net-identity.test.js` 新增 5 条（失败传播、幂等关闭、代理→直连切换），`test/app/fingerprint.test.js` 更新真实几何断言。
- 真机（开发版 CDP 9444）：远程 AI 页面 `typeof window.electronAPI === 'undefined'`、`hasExecuteJs === false`；新建窗口正常加载平台选择页。
- typecheck / lint(0 errors) / test(135 文件 1395 用例) / compile 全绿。
- 版本 0.10.215（跳过含 4 的 0.10.214），三处一致；已推送分支与 tag，CI success（3m24s）。

## 顺带修复（同批提交的 4 个真实缺陷）

1. **纯净模式思考/正文重复**：真凶是 `BATCH` 批量帧的子项继承 `o='BATCH'`，旧判据只认 `SET` 才重置。改为内容前缀判定（`planFragmentsUpdate` 扩展 4 个可选参数）。
2. **平台选择页「API 未就绪」/ 无法新建窗口**：收紧暴露时误删 `exposeInMainWorld`，而该页跑在主世界。改为按 `file://` 协议判据恢复。
3. **发送延迟设置自我恢复**：overlay 保存只写 localStorage 不通知主进程，任何 sync 广播都会用文件旧值覆盖。改为走 `save-settings` IPC。
4. **初始提示只回显不发送 / 延迟分布偏低**：初始提示改 0ms；`randomDelay` 改按长度线性映射到配置区间。

## 证据

- src/app/entry.ts:112 的 clampBounds 使用 Electron screen.getDisplayMatching(...).workArea。
- src/app/fingerprint.ts:289 起覆盖 Screen 和 devicePixelRatio，未改变真实窗口大小。
- src/bridge/api.ts:252 通过 exposeInMainWorld 暴露接口；contextIsolation 不阻止显式桥接。
- src/app/entry.ts:1715 保存代理后调用 applyNetIdentity 并 reload。
- src/app/net-identity.ts:201 捕获 setProxy 异常而不抛出，且未关闭旧连接。
- Electron 官方文档：https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig 、https://www.electronjs.org/docs/latest/api/context-bridge 。
