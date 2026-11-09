# 需求 110：原生物理级发送防封、自适应认知延迟与智能提示词放权

## 一、背景与动机
- **当前状态**：进行中 (In Progress)
- **核心痛点**：
  1. **防封号与小延迟冲突**：用户之前将延迟设置较大（6~76秒），一旦设置调小就容易触发网站风控封号。追查根因发现，系统在 DeepSeek 等平台的回调发送中使用合成事件（`btn.click()`、`dispatchEvent(KeyboardEvent)`），其 `event.isTrusted` 恒为 `false`，在短间隔下被风控探针直接捕获为自动化机器外挂；
  2. **体验卡顿与死等**：延迟算法采用纯离散均匀随机，即使只有几个字符的简单确认回复，也有几率随机等待 70 秒，整体编码心流严重受阻；
  3. **提示词机械拘谨与注意力稀释**：各平台提示词写死“一次一小步”，迫使模型哪怕只读几个已知文件也必须分多轮往返等待，消耗大量无谓延迟；同时缺乏本地数据精炼指导，长日志回传冲淡上下文，引发模型降质。
- **目标**：
  1. **原生物理级发送**：彻底摒弃合成事件，统一调用 Electron 主进程的 `webContents.sendInputEvent`，确保所有 Enter 按键与必要交互的 `event.isTrusted` 100% 为 `true`；
  2. **自适应认知拟人延迟**：根据回显内容字符长度与认知负荷动态自适应计算等待时间，短输出快速回传（3~6s），长输出模拟人类思考阅读（15~25s），兼顾流畅度与极佳的风控信誉；
  3. **动静分流智能提示词**：放权只读排查阶段的批量并发执行（使用 `Promise.all` 等减少 70% 往返），保留核心修改阶段的单步推理链，引导在 JS 沙箱内做前置过滤，实现“又快又聪明且绝不降质”。

## 二、架构设计与方案

1. **原生物理级事件发送管线（Native Input Pipeline）**：
   - 在 `src/overlay/chat-input.ts` 的 `triggerSend` 与 `fallbackSend` 中，废弃 `btn.click()` 与合成 `KeyboardEvent`；
   - 统一通过 `electronAPI.sendEnterToChat()` 驱动 Chromium C++ 输入管线注入原生 `Enter`（`isTrusted: true`）；
   - 若平台有特殊的发送按钮且 Enter 无法触达，通过主进程 `simulate-mouse` 派发真实物理鼠标坐标点击。
2. **原生函数包装原型链对齐**：
   - 检查 `src/providers/hooks/shared/native-mask.ts`，修复被包装函数的 `prototype` 属性残留，确保 `fn.hasOwnProperty('prototype') === false`，符合 V8 内置原生函数规范。
3. **自适应认知延迟（Adaptive Cognitive Delay）**：
   - 重构 `src/overlay/chat-input.ts` 中的 `randomDelay()`；
   - 动态判定回传文本长度：短文本基准 3000ms，按字符数以人类平均阅读速度递增，附加轻量随机抖动（Jitter），并在用户配置的 `[min, max]` 区间内钳制；
   - 保证简单操作 3~6s 秒级推进，长任务自动拉长保护频率。
4. **提示词动静分流升级**：
   - 改造 `src/prompt/deepseek.md`、`src/prompt/claude.md`、`src/prompt/default.md`；
   - 将“一次一小步”进化为“调查摸底并行化，核心改动严密化”；
   - 明确传授在 `cuckoo` JS 脚本中本地精炼数据、切片过滤的方法，防止巨量上下文冲淡模型推理焦点。

## 三、验收标准

1. `triggerSend` / `fallbackSend` 不再派发 `isTrusted: false` 的合成按键或点击；
2. 延迟计算支持自适应认知模式，且严格保持向下兼容；
3. 单元测试覆盖自适应延迟计算逻辑与原生输入调用路径；
4. 全量 `typecheck`、`lint`、`test`、`compile` 100% 通过。
