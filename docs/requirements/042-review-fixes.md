---
id: 042
type: fix
title: 子代理审查修复（更新门禁锁死 + 停止兜底 exitCode）
status: done
branch: fix/042-review-fixes
created: 2026-10-13
updated: 2026-10-13
---

## 背景 / 动机

用 code-reviewer 子代理审查 v0.8.46~48 改动，发现 1 必须修复 + 4 建议 + 4 参考。

## 修复（已处理项）

### 🔴 必须修复 #1：更新门禁锁死新版本（真实回归）
- **根因**：`checkForUpdates` 的"已下载完成"分支 `installAndRestart()` **无参** → `targetVersion` 空 → 更新成功后新版首次启动被 `isUpdatePending` 判"未完成"拦截，**锁死最长 10 分钟**。
- **修法**：
  - `update-downloaded` 记 `downloadedVersion`，`installAndRestart` 带目标版本；
  - 标记新增 `fromVersion`（安装前版本），`isUpdatePending` 判定改「版本已变 / 已达目标 / 数据不完整」都放行；
  - 标记改**原子写**（临时文件 + rename）。
- **验证**：抽取判定逻辑跑 7 个分支用例（含"更新成功→版本已变→放行"）全过 ✓

### 🟡 建议 #2：停止兜底 exitCode
- `stop()` 兜底超时/!pid 分支未设 `exitCode`、未清 `stopping` → UI「退出码 undefined」。补 `exitCode ?? null` + 清 `stopping`；渲染层 `exitCode == null` 归「已结束」。

### 🟡 #3/#4/#5
- 注释修正 + 标记原子写（随 #1）；`expanded` 清空后裁剪（防无界累积）+ 修正陈旧注释。

### ⏭️ #8 未做
- `isUpdatePending` 单测：`src/updater/**` 被 vitest 排除（需 Electron 运行时），深 mock 违反「只写真实集成测试」规则，不做，靠真机验证。

## 验收

- 判定逻辑 7 分支用例全过 ✓
- 真机冒烟：停止态流转正常（stopping:true → exited + stopping:false + exitCode:1）✓
