# 最新接续状态 (2026-10-12)

> 面向下次会话的 AI，**开工前先读**。以本地源码为准。
> 上一份 handoff 是 10-11 会话的内容（已归档在 backup/pre-ff 分支）。

## 当前 git 状态

| 项 | 值 |
|---|---|
| 分支 | master |
| HEAD | `7ffb02d` |
| 工作区 | 干净 |
| 领先 origin | 45 commits（**未 push**） |
| 基座 | v0.8.11（合并自 8555uuy/personal/full，commit `862d144`） |
| 备份分支 | `backup/pre-ff`（会话改动存档 `d0fe406`，99 文件） |

### 本次会话两次提交
- `e32d898` fix: 窗口组跳过忙碌窗口等会话修复（29 文件）
- `7ffb02d` feat: 限流窗口自动关闭 + 自动创建 .agents/handoff.md + 项目规则（3 文件）

## 重要事件：git 被外部改变

reflog 显示会话中途**有人执行了合并**（非本 AI 操作，用户未确认是否其亲手）：
```
862d144 HEAD@{0}: merge 8555uuy/personal/full: Fast-forward
181df32 HEAD@{1}: checkout: moving from backup/pre-ff to master
d0fe406 HEAD@{2}: commit: backup: 会话改动存档
```
把 master 从 0.8.10 快进到 0.8.11。**收益**：0.8.11 内置了插件需要的全部后端 API
（memories / snapshots / ipc / tools）——之前"插件缺后端"的问题从根解决。

## 本次会话完成的改动

1. **发送延迟统一**：初始提示秒发；任务反馈 + 11 处系统消息走 0.5~1s 区间；默认值 2000/4000 → 500/1000
2. **并发发送丢消息修复**：`chat-input.ts` sendToChat 改串行链（sendChain），cancelPendingSend 释放链
3. **停止按钮恢复**：observer.ts 整个工具流程 showToolMask(停止回调)；panel.ts 恢复显示；overlay.css 改顶部非阻塞提示条
4. **overlay 死代码清理**：events.ts 删死绑定、panel.ts 精简、executor.ts 精简、bridge/entry.ts 清理
5. **构建健壮性**：copy-monaco 幂等化；tsconfig exclude src/ui/vendor
6. **任务栏图标**：新增 scripts/patch-electron-icon.mjs，集成 start.js
7. **插件侧栏入口修复**（与 0.8.11 重合）
8. **窗口名显示**：statusbar 显示窗口名 + IPC + 渲染
9. **窗口组跳过忙碌窗口**（entry.ts + window.ts setGenerating/isGenerating + harness.ts 记录 ai-state）
10. **限流窗口自动关闭**：runSwitchForGroup 加 closeSource 参数，限流路径传 true（跳过确认框，延迟 1500ms）
11. **自动创建 .agents/handoff.md**：project-context.ts 加 ensureAgentsHandoff
12. **项目规则** `.cuckoo/rules/project.md`（无 paths，始终适用）
13. **全局规则修正** `~/.cuckoo/rules/global-override.md`（不在 git）：删悬空引用 .agents/rules/README.md、加"handoff 不存在则创建"、Skills 名具体化。已备份 .bak

## 未完成 / 待办

### 1. 遗留 4 项（在 backup/pre-ff，master 没有）
- **子进程树 taskkill**（tools/impl/bash.ts、pwsh.ts）
- **IPC 协议白名单**（app/ipc/shell.ts）
- **rules 管理功能**（src/rules/files.ts、src/app/ipc/rules.ts、rules 页面）
- **删 fab.ts**（0.8.11 又带回）
> 注意：**不能直接 git checkout backup/pre-ff -- 文件**（backup 是 0.8.10 基座，会丢 0.8.11 改动），要逐段挑。

### 2. 重启验证（改的是主进程，需 npm start）
- 限流关窗口、自动建 handoff、窗口组跳过忙碌、停止按钮、窗口名

### 3. 未决
- 未 push（45 commits）
- 限流窗口"关" vs "只停不关"——用户尚未最终决定
- agent-mode 提示词段注册时机问题（未真机验证）

## 关键背景

- **overlay 是纯 UI**，不 import bridge/session/app
- **bridge/session 不依赖 overlay/state**，数据经回调推送
- **窗口结构**：地址栏在 win.webContents（壳页面），AI 页面在 ctx.view
- **生成物禁手改**：*.generated.ts、src/tools/api.d.ts、src/ui/shell.html
- 目录：D:\Desktop\Super-File\cuckoo-code
- 外网代理：http://127.0.0.1:51081

## 规则遵循自省（下次务必避免）

1. **未挂载 Skills 套件**（~/.agents/skills/）—— 规则要求改代码前读 SKILL.md 并标记 [Auto-Skill]
2. **未建需求档案 / 分支**
3. **未创建 .agents/plan-*.md 计划文档**
4. 本次曾误把临时文件 `_cm.txt` 提交，已用 git rm --cached + amend 修正（教训：提交前检查 git status）

## 验证状态

- typecheck ✅ / test 926 passed ✅ / lint 0 errors（warning 均为既有模板/测试/plugin-src）✅
- 尚未真机 npm start 验证本轮运行时改动
