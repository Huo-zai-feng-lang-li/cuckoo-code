---
id: 036
type: refactor
title: 统一项目规则目录到 .agents/rules/
status: done
branch: refactor/036-unify-agent-rules
created: 2026-10-13
updated: 2026-10-13
---

## 背景

用户使用多个 AI 工具（Cuckoo Code、Codex 等），各自的**项目级规则目录约定不同**：

| 工具 | 项目级规则位置 |
|---|---|
| Cuckoo Code | `.cuckoo/rules/*.md`（**硬编码**，scanner.ts:57） |
| 其他工具（用户方案） | `.agents/rules/README.md`（路由入口，靠全局规则指令读取） |

用户已确立统一方案：**`.agents/rules/README.md` 作项目规则总入口**（路由表），指向同目录的专项规则文件；全局规则（`~/.cuckoo/rules/global-override.md` 第 40 行）指令 AI 去读它。

**问题**：Cuckoo Code 系统层硬注入只认 `.cuckoo/rules/`，导致：
- 当前项目要维护**两套**（`.cuckoo/rules/` 给 Cuckoo，`.agents/` 给其他）
- 其他项目靠**全局指令软约束**读 README（AI 有概率漏读）

## 目标

让 Cuckoo Code 项目级规则**统一读 `.agents/rules/`**，与其他 AI 工具对齐。**一份真相源，所有工具可用。**

### 范围

- ✅ 改 `src/rules/scanner.ts` 项目级扫描路径：`.cuckoo/rules` → `.agents/rules`
- ✅ 当前项目规则文件搬移：`.cuckoo/rules/*.md` → `.agents/rules/*.md`
- ✅ `.agents/rules/README.md` 改为"路由版"（对齐用户其他项目格式）
- ✅ 删除此前方向错误的同步脚本（`sync-agent-rules.mjs`）与钩子段
- ✅ 更新 `CUCKOO.md` 等文档中提及规则路径处
- ❌ 不改用户级规则（`~/.cuckoo/rules/`，与项目级无关）

## 方案

### 技术改动（仅 1 行核心）

`src/rules/scanner.ts`：
```ts
// 旧：const project = projectDir ? scanDir(path.join(projectDir, '.cuckoo', 'rules'), 'project') : [];
// 新：
const project = projectDir ? scanDir(path.join(projectDir, '.agents', 'rules'), 'project') : [];
```

### 引用面（已取证，无需改调用方）

| 调用方 | 用途 | 影响 |
|---|---|---|
| `session/prompt-builder.ts:191` | 无 paths 规则 → 始终注入 | ✅ 自动跟随 |
| `tools/runtime/JsRunner.ts:376` | 有 paths 规则 → 按需注入 | ✅ 自动跟随 |
| `rules/files.ts` | 用户级规则 CRUD | ❌ 不涉及（只管 `~/.cuckoo/rules/`） |

### frontmatter 兼容

- `README.md`（无 `paths`）→ **always 注入**（作路由入口）
- 专项规则（有 `paths`）→ **按需注入**（精确匹配）

## 验收标准

- [x] Cuckoo 正确加载 `.agents/rules/` 下的规则（实测：11 个项目级）
- [x] README（无 paths）每轮注入；专项（有 paths）仅命中时注入（实测：始终=project/README/global-override，按需=9 个专项）
- [x] 用户级规则（`~/.cuckoo/rules/`）不受影响（实测：global-override 正常加载）
- [x] `.cuckoo/rules/` 旧目录不再被扫描（迁移完成，目录已空）
- [x] typecheck + lint + compile + test 全绿
- [x] 真机验证：node 直接调 scanRules，结果符合设计

## 补充（同批完成）

- **兼容 Cursor 格式**：`frontmatter.ts` 支持 `trigger`/`globs`（无 `paths` 时回退）。实测某 Cursor 项目：始终注入 17→4，按需 0→14。
- **内置默认全局规则**：首次启动写入 `~/.cuckoo/rules/global-default.md`（用户已有规则不覆盖；seed 标记防复活）。
- **UI 说明**：规则页加"本页=用户级全局规则 / 项目规则在 `.agents/rules/`"提示。

## 遗留

- 无（不合并上游，改核心无 fork 负担）
