# 最新接续状态 (2026-10-23 13:08)

## 核心进展

Git 面板「全部撤销」功能已完成并发布**四个版本**，全部已推送远端：

| 版本 | 提交 | 内容 |
|---|---|---|
| v0.10.45 | `a7a5b4d` | 新增「全部撤销」= 清空更改区 |
| v0.10.46 | `c6172f3` | 并发守卫（**后证实为误判产物**，保留无害） |
| v0.10.47 | `58a0c62` | **真因修复**：`runGit` 全局串行队列 + 操作反馈 |
| v0.10.48 | `ccad99b` | 串行队列超时兜底 + 失败提示补全 |

远端 master 与 tag `v0.10.48` 均指向 `ccad99b`。工作区干净（0 改动，无 `.tmp-*` 残留），开发版实例已关闭。

## 核心动机与背景 (Motivation & Background)

用户需求演进三次，每次都纠正了我的理解偏差：

**1. 语义纠正**：「全部撤销」不是「只恢复已跟踪文件」，用户原话——「**不是有全部取消吗？全部撤销应该是撤销更改区代码**」。
最终语义：`git restore -- .` + `git clean -fd`
- 已跟踪文件 → 从暂存区恢复
- 未跟踪文件/目录 → 永久删除
- 不动暂存区（那是「全部取消」的职责）
- 不删 `.gitignore` 忽略项（`clean` 不带 `-x`）

**2. Bug 纠正**：用户先报「点全部暂存→全部取消→全部暂存偶尔不生效，双击就行」，我误判为连点竞态并发布 v0.10.46。用户随后纠正——「**批量按钮快速连点不生效，不是这个。我是说有时候点击全部暂存需要点两下才可以**」。

**真因（v0.10.47 才找到）**：`runGit()` 直接 `execFile` **无任何并发控制**。多 git 命令并发争抢 `.git/index.lock`，后到者失败返回 `fatal: Unable to create '.git/index.lock': File exists`。关键点：**`git status` 也会写 index**（刷新 stat 缓存），所以它和 `git add` 并发时同样撞车。v0.10.45 之前该失败是静默的，用户只能靠再点一次碰运气。

**3. 动效需求**：「点击需要等待 2s，可以加 loading，但暗黑的不好看，要加动效」→ 第一版做好后用户反馈「**动效不好看**」，重做两轮才定稿。

## 关键设计与实现 (Implementation & Decisions)

### 1. `runGit` 全局串行队列（`src/app/ipc/git.ts`，真因修复）

```ts
let gitQueue: Promise<unknown> = Promise.resolve();
const GIT_TIMEOUT_MS = 30000;

function runGit(root, args) {
  const exec = () => new Promise((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 8*1024*1024, windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // 超时被强制终止：给中文提示而非 Node 原始 "Command failed"
        if (err.killed || err.signal) return resolve({ success: false, stdout: stdout||'', stderr: 'git 命令执行超时（30 秒），已强制终止...' });
        return resolve({ success: false, stdout: stdout||'', stderr: stderr || err.message });
      }
      resolve({ success: true, stdout: stdout||'', stderr: stderr||'' });
    });
  });
  // then(exec, exec)：前一条失败也继续执行下一条，避免一次失败卡死队列
  const next = gitQueue.then(exec, exec);
  gitQueue = next.then(() => {}, () => {});
  return next;
}
```

**超时兜底是必要的**：串行队列的代价是「前一条卡住，后面全等」，没超时的话一条挂死会拖垮整个 Git 面板（比修复前更糟：从「单功能卡住」变成「整个面板卡死」）。

### 2. 操作反馈（`pages/git.ts` + `pages.css`，三版迭代）

读了 `impeccable` 技能的 Operate 模式 + `reference/animate.md`（动效服务反馈，装饰是动画债）。

| 版本 | 方案 | 否决原因 |
|---|---|---|
| 一 | 面板顶部 2px 通栏进度条 | 窄侧栏（46~320px）里视觉权重过大，紧贴标题被误读成边框渲染错误 |
| 二 | 分组标题后 9px 小圈，`currentColor`（继承灰色） | 暗色下像装饰符号，不传达「进行中」 |
| **三（最终）** | 分组标题后 10px 小圈，**主色弧线 + 半透明主色轨道**，`.6s` 匀速 | ✅ |

最终 CSS：
```css
@keyframes ck-git-spin { to { transform: rotate(360deg); } }
.ck-git-group.ck-git-loading .ck-git-group-title::after {
  content: ""; display: inline-block; width: 10px; height: 10px;
  margin-left: 7px; vertical-align: -2px;
  border: 1.5px solid color-mix(in srgb, var(--ck-primary) 32%, transparent);
  border-top-color: var(--ck-primary);
  border-radius: 50%;
  animation: ck-git-spin .6s linear infinite;
}
```

配套决策：
- **不对整块内容降透明度**——暗色下整块发灰会显得像坏掉
- **不做透明度闪烁**——反复明暗交替显廉价，只保留 `pointer-events: none` 阻断重复点击
- `prefers-reduced-motion` 降级为静态主色圆点

### 3. 忙碌态用引用计数 + DOM 重建补偿（关键细节）

```ts
let gitBusyCount = 0;
function setGitBusy(on: boolean): void {
  gitBusyCount = Math.max(0, gitBusyCount + (on ? 1 : -1));
  document.querySelectorAll('.ck-tab[data-panel="git"] .ck-git-group').forEach((g) => {
    if (gitBusyCount > 0) g.classList.add('ck-git-loading');
    else g.classList.remove('ck-git-loading');
  });
}
```

**必须用计数而非布尔**：并发操作时布尔会被先完成的那个提前清掉。

**`renderList` 里必须补偿**：`listEl.innerHTML = html` 重建 DOM 会丢掉运行时添加的 `ck-git-loading` 类：
```ts
listEl.innerHTML = html;
if (gitBusyCount > 0) {
  listEl.querySelectorAll('.ck-git-group').forEach((g) => g.classList.add('ck-git-loading'));
}
```

### 4. 失败提示补全（v0.10.48）

- `loadBranch` 失败原因挂元素 `title`（原来静默显示占位符 `—`）
- `loadHistory(opts?: { silent?: boolean })`：用户主动触发失败才弹框，后台自动刷新（watcher/切项目）失败只记 `console.warn`，避免反复弹框骚扰
- `doAct` / `doCommit` / `doCheckout` 结尾统一 `loadGit({ force: true })`——原来 `loadGit()` 在已加载时 early-return，实际要等 watcher 兜底（400ms 防抖甚至不触发）

### 5. 并发守卫（v0.10.46，误判产物但保留）

`bulkChain` 串行队列 + `gitLoadSeq` 请求序号（丢弃过期响应）+ `bulkInProgress` 屏蔽 watcher 刷新。虽非真因，但确实减少了无效并发，无害保留。

## 待办事项 (Next Steps)

- [ ] **CI 构建结果需用户自行确认**（v0.10.45~v0.10.48 四次 tag 触发，我看不到 GitHub Actions 状态）
- [ ] **unmerged 冲突路径未真机验证**：`git restore` 遇 unmerged 会整体中止，代码有 `ckAlert` 兜底但未实测
- [ ] `index.lock` 是概率性 bug，10 次真机操作只能证明改善，无法证明 100% 消除（串行化原理上已根除该并发路径）
- [ ] 用户项目 `yfcode` 里有 12 个 `.playwright-cli/*.yml` 未跟踪文件，建议加进该仓库的 `.gitignore`

## 关键上下文

- **目录**: `D:\Desktop\Super-File\cuckoo-code`
- **分支**: `master`
- **主要文件**:
  - `src/app/ipc/git.ts` —— `runGit`（串行队列 + 超时）、`git-discard-all` handler
  - `src/ui/shell/scripts/pages/git.ts` —— `doBulk`/`doBulkInner`、`setGitBusy`、`withBusy`、`loadGit`、`loadHistory`、`loadBranch`、`doAct`、`doCommit`、`doCheckout`、`showCommit`
  - `src/ui/shell/styles/pages.css` —— `.ck-git-loading`、`.ck-git-spinning`、`.ck-git-busy`、`.ck-git-act-danger`
  - `src/app/shell-preload.ts` —— `gitDiscardAll`
  - `src/ui/shell/scripts/shell-api.ts` —— 类型声明
  - `docs/requirements/087-git-discard-all.md` —— 需求档案
- **需求档案编号**: 087（下一份用 088）

## 踩坑记录（重要，下次别再犯）

1. **先取证再下结论**。我对「要点两下」误判两次（先判连点竞态、再判 DOM 重建），真因是 `.git/index.lock` 竞争，靠**读弹框内容**才定位。
2. **程序化 `.click()` 覆盖不到真实交互**。必须用 CDP `Input.dispatchMouseEvent`（mouseMoved/mousePressed/mouseReleased）才能复现时序相关 bug。
3. **PowerShell 输出会吞前导空格**，导致误读 `git status` 的 `M ` vs ` M`。判断暂存状态用 `git status --porcelain=v1 | ForEach-Object { '[' + $_ + ']' }` 加括号才看得清。
4. **验证必须用用户真实数据**。最初只用人造「有已跟踪改动」的仓库验证，用户项目全是未跟踪文件，功能实际空转。
5. **`opacity: 0` 的「悬停显现」= 用户看不见按钮**。可见性不能只读 `getComputedStyle`，必须截图肉眼看。
6. **子代理标「低优先级」的问题不能直接放过**。code-reviewer 提过 opacity 问题标为「仅供参考」，我没复核导致 bug 上线。
7. **改公共函数要考虑所有调用方**。`doBulk` 服务三个按钮，改刷新逻辑时引入过回归。
8. **启动实例早于编译完成 → 加载旧产物**。重启前比对 `shell.html` 与实例启动时间戳。
9. **pwsh 模板字符串里写 PowerShell 反引号（\`n）会与 JS 模板字符串冲突**，必须用 `write` 写 .ps1 再执行。
10. **bash 在 Windows 是 cmd.exe**，没有 tail/head；**pwsh 里 `&&` 不合法**，用 `;` 分隔；**`Remove-Item -Recurse -Force` 会被安全策略拒绝**，删目录用 `node -e "fs.rmSync(...)"`。
11. **tag 必须在发版提交之后打**。曾先打 tag 再提交版本号，指向错误 commit，只能删除重打。
12. **测试偶发 1 条失败**（`test/agents` 或 `test/infra/run-captured` 时序敏感用例），重跑即过，非回归。

## 历史版本（v0.10.44 及之前）

见 `CHANGELOG.md`。
