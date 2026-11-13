---
id: 120
type: refactor
title: CHANGELOG 按月拆分 + 内容规范收紧
status: doing
branch: refactor/120-changelog-split
created: 2026-11-13
updated: 2026-11-13
---

# 120：CHANGELOG 按月拆分 + 内容规范收紧

> 状态：**doing**
> 分支：`refactor/120-changelog-split`

## 一、用户原始目标与痛点

1. `CHANGELOG.md` 已膨胀到 3693 行 / 184KB（340 个版本，日均 3.6 版）。
2. 文件过大导致 AI 读写易截断（`readLines` 默认 2000 行，v0.10.226 发版时曾把历史截掉 3263 行，已修复）。
3. 分类混乱：`Fixed` 221 次 + `修复` 37 次中英混用，自造分类 20+ 种；内部「### 验证」章节混入用户可见变更记录。

## 二、根因

- 发版纪律只要求"汇总全部提交"，未规定**内容粒度与分类标准**，内部实现/验证细节被全量写入。
- 单文件无轮转机制，随版本数线性膨胀。

## 三、方案

### 3.1 按月拆分（用户已确认）

- 目录：`changelogs/YYYY-MM.md`，按版本发布日期归属月份。
- 根 `CHANGELOG.md` 保留：索引表（版本区间 → 文件）+ 最近 5 个版本完整条目。
- 轮转无决策成本：发版看当天日期直接追加当月文件。
- GitHub Release 不受影响（不读该文件，源码/脚本均无引用，已 grep 确认）。

### 3.2 内容规范（写入 `project.md` 发版纪律）

- 只写**用户可感知的变更**（功能、行为变化、性能、安全、依赖），不写内部验证、重构细节、测试补丁；
- 分类只用 Keep a Changelog 标准六类：`Added / Changed / Fixed / Removed / Performance / Security`；
- 单版本条目建议 ≤ 15 行，超出说明应拆版本。

### 3.3 工具

- `scripts/changelog-locate.mjs <version>`：按索引定位版本所在文件，避免查历史时读错/读全量。
- `scripts/migrate-changelog.mjs`：一次性迁移脚本（按 `## [版本] - 日期` 切分，不手抄）。

## 四、验证

- 迁移后版本总数 340 守恒、每个版本号可在 `changelogs/` 中检索到；
- 根文件 + 归档文件的正文字符总量与原文一致（忽略索引新增）；
- `npm run typecheck` + `npm test` + `npm run lint` + `npm run compile` 全绿；
- `node scripts/changelog-locate.mjs 0.10.226` 与 `0.8.12` 均能正确定位。

## 五、实施结果

| 项 | 结果 |
|---|---|
| 迁移版本数 | 340 个（2026-08: 2、09: 24、10: 293、11: 21） |
| 完整性校验 | 版本号 340/340 无缺失无多余，**内容逐字节一致**（差异 0） |
| 根 `CHANGELOG.md` | 184377 → 6402 字符（3693 → 131 行） |
| 新增文件 | `changelogs/2026-08.md`、`2026-09.md`、`2026-10.md`、`2026-11.md` |
| 新增脚本 | `scripts/migrate-changelog.mjs`（迁移，支持 --dry-run）、`scripts/changelog-locate.mjs`（定位） |
| 规则更新 | `project.md` 发版纪律（月归档 + 内容粒度 + 标准六类）、`README.md` 速查同步 |

定位脚本实测：`0.10.226` → `changelogs/2026-11.md:6`；`0.8.12` → `changelogs/2026-10.md:2256`；`v0.2.0` → `changelogs/2026-08.md:6`。

## 六、验证

- `npm run typecheck` / `npm test` / `npm run lint` / `npm run compile` 全绿
- 迁移完整性脚本校验：版本数守恒、内容零差异
