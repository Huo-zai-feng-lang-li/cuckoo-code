# Git 钩子

由 `package.json` 的 `prepare` 脚本挂载：`git config core.hooksPath .githooks`。

## 现有钩子

| 钩子 | 作用 |
|---|---|
| `pre-commit` | 提交前跑 `npm run docs:index`，自动更新需求索引 |

## 为什么没有 post-commit

这里曾经有一个 `post-commit`，每次提交后自动执行 `git push origin <当前分支>`。

**已移除（v0.10.203 之后）**，原因是它把「提交」和「发布」耦合在一起：

1. 提交了个坏版本 → 钩子立刻推到远程 → 别人/CI 可能已经拉到
2. 用 `git commit --amend` 修正后，本地是新提交、远程还是旧的坏提交，需要手动 `--force-with-lease` 才能对齐
3. 钩子对 amend / rebase 这类本地修正操作完全无感，只会把中间态推出去

实际事故：v0.10.203 的 CHANGELOG 被误写导致丢 1253 行历史，坏提交被钩子自动推到远程，amend 修正后远程仍是坏的，靠 `--force-with-lease` 才救回来。

## 现在的做法

**手动推送**：

```bash
git push origin master
git push origin vX.Y.Z     # 打 tag 后单独推
```

推之前自己确认：`git status` 干净、`git log origin/master..HEAD` 内容正确、测试全绿。
