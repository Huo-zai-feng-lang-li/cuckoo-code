'use strict';
/**
 * harness 页面（src/ui/harness.html）内联脚本守卫测试。
 *
 * 背景：这个文件是内联 JS，没有模块边界，改错只能靠真机跑出来 ——
 * 运行态状态机已被改坏过两次（先"网页在跑、界面却停了"，后"网页答完、界面还在跑"）。
 * 这里钉住三条底线：
 *   1) 内联脚本语法可解析（防手改引入语法错误）
 *   2) 权威终态信号 task-idle 必须接住（收尾不靠超时猜）
 *   3) 静默兜底必须有界（不允许出现数分钟级的"卡在运行态"）
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HTML_PATH = path.join(import.meta.dirname, '..', '..', 'src', 'ui', 'harness.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

/** 取出内联 <script> 正文（harness.html 只有一个内联脚本） */
function inlineScript() {
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert.ok(start >= 0 && end > start, 'harness.html 应含内联 <script>');
  return html.slice(start + '<script>'.length, end);
}

const script = inlineScript();

test('内联脚本语法可解析', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'harness-inline.js' }));
});

test('接住权威终态信号 task-idle（网页执行完就收尾）', () => {
  assert.ok(script.includes("case 'task-idle'"), '事件分发应处理 task-idle');
  assert.ok(/function onTaskIdle\s*\(/.test(script), '应有 onTaskIdle 处理函数');
  // 收尾必须落到"就绪"，否则网页答完界面仍显示运行中
  const fn = script.slice(script.indexOf('function onTaskIdle'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.ok(body.includes("setStatus('就绪', 'ready')"), 'task-idle 应收尾为就绪');
});

test('框架侧投递有运行态反馈（framework-send）', () => {
  assert.ok(script.includes("case 'framework-send'"), '事件分发应处理 framework-send');
  assert.ok(/function onFrameworkSend\s*\(/.test(script), '应有 onFrameworkSend 处理函数');
});

test('接住权威生成状态心跳 ai-state（解套"卡在运行中"）', () => {
  assert.ok(script.includes("case 'ai-state'"), '事件分发应处理 ai-state');
  assert.ok(/function onAiState\s*\(/.test(script), '应有 onAiState 处理函数');
  const idx = script.indexOf('function onAiState');
  // 按函数体边界切片（不写死字符数）：用下一个顶层 function 作为终点，
  // 避免实现里加注释就把后面的断言挤出窗口。
  const nextFn = script.indexOf('\n  function ', idx + 10);
  const body = script.slice(idx, nextFn > 0 ? nextFn : idx + 2000);
  // 权威判定"已停止"时必须清零工具计数（防 tool-end 丢失导致永久卡住）
  assert.ok(body.includes('toolRunningCount = 0'), 'ai-state 收尾时应清零工具计数');
  assert.ok(body.includes("setStatus('就绪', 'ready')"), 'ai-state 收尾时应复位为就绪');
  // 静默期保护：刚投递消息的窗口内不能据"未生成"收尾，否则会退回"网页在跑界面却停了"
  assert.ok(/AI_STATE_QUIET_MS/.test(script), '应有静默期保护常量');
});

test('静默兜底有界：不允许数分钟级卡在运行态', () => {
  const m = script.match(/var limit = Date\.now\(\) < frameworkDriveUntil \? (\d+) : (\d+);/);
  assert.ok(m, '应能找到静默兜底的容忍上限');
  const inWindow = Number(m[1]);
  const outWindow = Number(m[2]);
  assert.ok(inWindow > outWindow, '框架驱动窗口内的容忍度应更宽');
  assert.ok(inWindow <= 180000, '框架驱动窗口上限不应超过 3 分钟（实测: ' + inWindow + '）');
  assert.ok(outWindow <= 60000, '常规静默上限不应超过 1 分钟（实测: ' + outWindow + '）');
});

test('兜底超时后必须重置为就绪（不能只换文案）', () => {
  const idx = script.indexOf('var limit = Date.now() < frameworkDriveUntil');
  assert.ok(idx > 0, '应能找到兜底判定');
  const tail = script.slice(idx, idx + 400);
  assert.ok(tail.includes("setStatus('就绪', 'ready')"), '超时后应重置为就绪');
});

test('工具计数泄漏有自愈兜底（tool-end 丢失不会永久卡住）', () => {
  // 定位兜底 setInterval 里那段（而非 onTaskIdle 的早退分支）：用其独有的超时判据锚定
  const idx = script.indexOf('Date.now() - lastActivityAt > AI_STATE_QUIET_TOOL_MS');
  assert.ok(idx > 0, '应有工具计数泄漏兜底');
  const tail = script.slice(idx, idx + 400);
  assert.ok(tail.includes('toolRunningCount = 0'), '超过上限应清零工具计数');
  assert.ok(tail.includes("setStatus('就绪', 'ready')"), '超过上限应复位为就绪');
});

test('goal 收束仍走 goalDone 工具事件（回归保护）', () => {
  assert.ok(script.includes("case 'goal-done'"), '事件分发应处理 goal-done');
  assert.ok(!script.includes('[[GOAL_DONE]]'), '不应回退到文本标记方案');
});

test('发送队列：运行中 Enter 入队而非丢弃', () => {
  // Enter 分支：busy 时应入队，而不是直接 return 丢弃
  assert.ok(/if \(isBusy\(\)\) \{ tryEnqueue\(\); return; \}/.test(script), 'busy 时 Enter 应入队');
  assert.ok(/function tryEnqueue\s*\(/.test(script), '应有 tryEnqueue 函数');
  assert.ok(/function maybeFlushQueue\s*\(/.test(script), '应有 maybeFlushQueue 函数');
  assert.ok(/function renderSendQueue\s*\(/.test(script), '应有 renderSendQueue 函数');
});

test('发送队列：空闲时自动 flush（setStatus 就绪分支）', () => {
  const idx = script.indexOf("generating = (state === 'busy');");
  assert.ok(idx > 0, '应能找到 setStatus 的 generating 赋值');
  const tail = script.slice(idx, idx + 400);
  assert.ok(tail.includes('maybeFlushQueue'), 'setStatus 就绪时应触发队列 flush');
});

test('发送队列：用户主动停止后不自动发（aborted 拦截）', () => {
  const idx = script.indexOf('function maybeFlushQueue');
  assert.ok(idx > 0, '应有 maybeFlushQueue');
  const body = script.slice(idx, idx + 300);
  assert.ok(body.includes('aborted()'), '主动停止后不应自动 flush（应判 aborted）');
});

test('发送队列：goal/plan 指令不入队（保持即时语义）', () => {
  const idx = script.indexOf('function tryEnqueue');
  const body = script.slice(idx, idx + 800);
  assert.ok(/\\\/goal/.test(body) && /\\\/plan/.test(body), 'tryEnqueue 应识别并排除 goal/plan 指令');
  assert.ok(body.includes('return false'), 'goal/plan 指令应返回 false 不入队');
});

test('发送队列：flush 不覆盖用户正在输入的内容（备份/恢复）', () => {
  const idx = script.indexOf('function maybeFlushQueue');
  const body = script.slice(idx, idx + 900);
  assert.ok(body.includes('savedInput'), 'flush 前应备份 input.value');
  assert.ok(body.includes('input.value = savedInput'), 'flush 后应恢复用户输入');
});

test('对话导航：基于用户消息重建锚点 + 点击滚动', () => {
  assert.ok(/function updateConvNav\s*\(/.test(script), '应有 updateConvNav 函数');
  assert.ok(/function updateConvNavActive\s*\(/.test(script), '应有 updateConvNavActive 函数');
  assert.ok(script.includes("querySelectorAll('.msg.user')"), '导航应基于用户消息节点');
  assert.ok(script.includes('scrollIntoView'), '点击锚点应滚动定位');
});

test('发送队列：编辑/删除锁定对象引用（防 flush 移走队首后 idx 错位）', () => {
  const idx = script.indexOf('// 点击文本 → 变多行文本域编辑');
  assert.ok(idx > 0, '应有队列项编辑逻辑');
  const body = script.slice(idx, idx + 2600);
  assert.ok(body.includes('sendQueue.indexOf(it)'), '编辑保存应按对象引用定位');
  assert.ok(body.includes('var at = sendQueue.indexOf(it)'), '删除应按对象引用定位');
  // 反例：不允许裸 idx 写回/删除
  assert.ok(!/sendQueue\[idx\]\.text = /.test(body), '不应按 idx 写回');
  assert.ok(!/sendQueue\.splice\(idx/.test(body), '不应按 idx 删除');
});

test('就地编辑统一为多行文本域（ck-mledit）', () => {
  // 统一编辑类：多行、保留换行
  assert.ok(/\.ck-mledit \{/.test(html), '应有统一定义的多行编辑类 ck-mledit');
  assert.ok(/\.ck-mledit \{[^}]*white-space:\s*pre-wrap/.test(html), 'ck-mledit 应保留换行');
  // 目标框与队列项都使用 textarea + ck-mledit
  assert.ok(/<textarea class="g-text" id="goal-text"/.test(html), '目标框应为 textarea');
  const qEdit = script.slice(script.indexOf('// 点击文本 → 变多行文本域编辑'), script.indexOf('// 点击文本 → 变多行文本域编辑') + 500);
  assert.ok(qEdit.includes("createElement('textarea')"), '队列项编辑应为 textarea');
  assert.ok(qEdit.includes("'ck-mledit'"), '队列项编辑应使用统一类 ck-mledit');
  // 多行提交语义：Ctrl/Cmd+Enter 提交（Enter 换行）
  assert.ok(/key === 'Enter' && \(ev\.ctrlKey \|\| ev\.metaKey\)/.test(script), '队列编辑应 Ctrl+Enter 提交');
});

test('发送队列：左侧三操作按钮（编辑/发送/关闭），无序号', () => {
  assert.ok(/\.sq-actions \{/.test(html), '应有操作按钮组 sq-actions');
  assert.ok(/sq-edit-btn/.test(script), '应有编辑按钮');
  assert.ok(/sq-send-btn/.test(script), '应有立即发送按钮');
  assert.ok(/function sendQueueItemNow\s*\(/.test(script), '应有立即发送函数');
  assert.ok(!/sq-idx/.test(script), '不应再有序号元素 sq-idx');
  // 编辑框隐藏滚动条
  assert.ok(/\.ck-mledit::-webkit-scrollbar \{ display: none;/.test(html), '编辑框应隐藏滚动条');
});

test('发送队列：关闭图标尺寸', () => {
  const m = html.match(/\.sq-item \.sq-del \{[^}]*width:\s*(\d+)px/);
  assert.ok(m, '应能找到关闭按钮宽度');
  assert.ok(Number(m[1]) >= 24, '关闭图标按钮宽度应不小于 24px（实测: ' + m[1] + '）');
});

test('对话导航：收起态为横线、悬停展开为摘要面板', () => {
  // 收起态：只显示细横线（cn-bar），文本（cn-text）默认隐藏
  assert.ok(/\.conv-nav-dot \.cn-text \{ display: none;/.test(html), 'cn-text 收起态应隐藏');
  assert.ok(/\.conv-nav-dot \.cn-bar \{/.test(html), '应有横线条样式 cn-bar');
  // 悬停整条导航 → 文本显现（展开态）
  assert.ok(/\.conv-nav:hover \.conv-nav-dot \.cn-text \{ display: block;/.test(html), '悬停 nav 应展开文本');
  assert.ok(/\.conv-nav-dot\.active \.cn-bar/.test(html), '当前项横线应高亮');
});

test('对话导航：空态/切会话时清空（无残留）', () => {
  const idx = script.indexOf('function showEmptyState');
  const body = script.slice(idx, idx + 500);
  assert.ok(body.includes('getConvNavEl'), '空态应清空导航');
  assert.ok(body.includes("remove('show')"), '空态应移除导航展开态');
});

test('发送队列：文本去除原生 title、hover 底色铺满变色、文字垂直居中', () => {
  // 1. sq-text 不应带有原生 title
  assert.ok(!/<span class="sq-text" title=/.test(script), 'sq-text 文本不应带有原生 title');
  assert.ok(/<span class="sq-text"><\/span>/.test(script), 'sq-text 应为纯净无 title 的 span 节点');

  // 2. hover 整条铺满变色
  assert.ok(/\.sq-item:hover\s*\{[^}]*background:\s*var\(--surface-hover\)/.test(html), 'sq-item:hover 应整行底色变色');
  assert.ok(!/\.sq-item \.sq-text:hover \{/.test(html), '不应再保留仅文字局部的孤立 hover 底色');

  // 3. 文字垂直居中：align-items: center
  assert.ok(/\.sq-item\s*\{[^}]*align-items:\s*center;/.test(html), 'sq-item 应采用 align-items: center 垂直居中');
  assert.ok(/\.sq-item \.sq-text\s*\{[^}]*line-height:\s*20px;/.test(html), 'sq-text 应有固定行高保障居中');
});

test('对话导航与全局 Tooltip：告别系统原生 title，统一自定义 Tooltip 呈现', () => {
  // 1. 导航圆点：文本超过展开面板宽度（会省略号截断）时才挂 data-tooltip
  assert.ok(script.includes('textOverflowsPanel(full)'), '导航圆点应用 textOverflowsPanel 判定溢出');
  assert.ok(script.includes("dot.setAttribute('data-tooltip', full)"), '溢出时导航圆点应挂 data-tooltip');

  // 2. harness 内置统一自定义 Tooltip 样式与脚本
  assert.ok(/\.ck-tooltip\s*\{/.test(html), '应包含 .ck-tooltip 样式');
  assert.ok(script.includes('initHarnessTooltip'), '内联脚本应初始化 Tooltip 引擎');
  assert.ok(script.includes("removeAttribute('title')"), 'Tooltip 引擎应自动拦截并清除原生 title');
});

test('消息气泡：纯图标悬浮操作条（编辑/复制/删除），用户消息操作栏置于气泡左侧不遮挡文本', () => {
  // 1. 纯图标按钮样式及气泡外部排列
  assert.ok(/\.msg-actions \{/.test(html), '应有 .msg-actions 操作条样式');
  assert.ok(/\.msg\.user\s*\{\s*display:\s*flex;\s*justify-content:\s*flex-end;\s*align-items:\s*flex-start;\s*gap:\s*8px;/.test(html), '用户气泡与操作栏应 flex 排列，避免遮挡气泡文字');
  assert.ok(/\.msg-act-btn \{[^}]*width:\s*24px;[^}]*height:\s*24px;/.test(html), '操作按钮应为统一小图标');

  // 2. 支持编辑、复制、删除动作定义与挂载
  assert.ok(script.includes('function deleteUserMessage'), '应有用户消息删除函数');
  assert.ok(script.includes('function editUserMessage'), '应有用户消息就地编辑函数');
  assert.ok(script.includes('function attachUserActions'), '应有用户消息动作条挂载函数');
  assert.ok(script.includes('function attachAssistantActions'), '应有助手消息动作条挂载函数');

  // 3. 键盘快捷键：输入框为空时按 ArrowUp 快速编辑上一条消息
  assert.ok(script.includes("e.key === 'ArrowUp'"), '应支持 ArrowUp 快捷键');
  assert.ok(script.includes("lastUser.querySelector('.act-edit')"), 'ArrowUp 应触发最后一条用户消息的编辑');

  // 4. 队列单条发送：立即触发发出
  assert.ok(script.includes('function doSendQueueItem'), '应有单条发送执行函数');
  assert.ok(script.includes('clearAbortSuppression'), '立即发送应清除中止抑制');

  // 5. 编辑和删除按钮 hover 不需要 tip
  assert.ok(!script.includes("editBtn.setAttribute('data-tooltip'"), '编辑按钮不应设置 data-tooltip');
  assert.ok(!script.includes("delBtn.setAttribute('data-tooltip'"), '删除按钮不应设置 data-tooltip');
  assert.ok(!script.includes('class="sq-btn sq-edit-btn" title='), '队列编辑按钮不应设置 title');
  assert.ok(!script.includes('class="sq-btn sq-del" title='), '队列删除按钮不应设置 title');
});

test('消息气泡：最后一条重发与历史消息截断重发/填入输入框闭环', () => {
  // 1. 判定函数存在
  assert.ok(script.includes('function isLatestUserMessage'), '应有判定是否为最后一条用户消息的函数');
  assert.ok(script.includes('function truncateUserMessage'), '应有物理截断消息函数');

  // 2. 截断函数必须彻底 splice 历史
  const trIdx = script.indexOf('function truncateUserMessage');
  const trBody = script.slice(trIdx, trIdx + 800);
  assert.ok(trBody.includes('history.splice(at)'), 'truncateUserMessage 应截断从当前项起的所有历史');

  // 3. 历史消息编辑栏提供填入输入框与截断重发按钮
  assert.ok(script.includes('msg-edit-quote'), '历史消息编辑栏应有填入输入框按钮');
  assert.ok(script.includes('msg-edit-truncate'), '历史消息编辑栏应有截断重发按钮');
  assert.ok(/\.msg-edit-bar \{/.test(html), '应有 .msg-edit-bar 样式');
  assert.ok(/\.msg-edit-btn \{/.test(html), '应有 .msg-edit-btn 样式');
});

test('消息气泡：历史消息编辑（仅保存已移除，改为截断重发 + 本地兜底）', () => {
  // 1. 「仅保存 / 保存修改」已移除 —— 它只改 DOM + localStorage，AI 服务端上下文不变，
  //    用户改了 AI 也不知道，无实际意义（详见 harness.html 里 doSaveOnly 的注释）。
  assert.ok(!script.includes('msg-edit-save-only'), '「仅保存 / 保存修改」按钮应已移除');
  assert.ok(!script.includes('function doSaveOnly'), 'doSaveOnly 函数应已移除');

  const editIdx = script.indexOf('function editUserMessage');
  const editBody = script.slice(editIdx, editIdx + 6000);

  // 2. 历史消息 Ctrl+Enter 提交改为截断重发（原为 doSaveOnly）
  assert.ok(editBody.includes('if (isLatest) doSubmitLatest(); else doTruncate();'), '历史消息快捷键应为截断重发');

  // 3. doTruncate 本地兜底链路完整
  assert.ok(editBody.includes('truncateUserMessage(msgEl, histItem)'), '无 webMsgId 时应回退到本地物理截断');
  assert.ok(editBody.includes('input.value = newText'), '截断后应将新文本填入输入框');
  assert.ok(editBody.includes('send()'), '截断后应重新触发发送生成');
});

// ===== 目标推进死锁三处修复（2026-10-18 实测复现后修）=====

test('历史恢复：未收尾工具必须落终态，不能永久显示运行中', () => {
  // 历史里 success===null 表示上次崩溃/刷新时工具没收尾。
  // 若只 addToolStart 不 addToolEnd，卡片永远"运行中"，isBusy() 与 DOM 脱节 → 目标推进卡死。
  const idx = script.indexOf('function restoreHist');
  assert.ok(idx > 0, '应有 restoreHist');
  const body = script.slice(idx, idx + 1800);
  assert.ok(/addToolEnd\(false/.test(body), '未收尾工具应以失败终态落定（addToolEnd(false, ...)）');
  assert.ok(body.includes('上次会话中断'), '终态应给出可辨识的中断原因');
});

test('目标续跑：nudge 遇忙不丢弃，改为退避重试', () => {
  assert.ok(/function scheduleGoalNudgeRetry\s*\(/.test(script), '应有退避重试函数');
  assert.ok(/GOAL_NUDGE_RETRY_MAX/.test(script), '应有重试上限常量（防无限重试）');
  const idx = script.indexOf('function scheduleGoalNudge()');
  const body = script.slice(idx, idx + 500);
  assert.ok(body.includes('scheduleGoalNudgeRetry()'), 'nudge 到点仍忙时应转重试，不能直接丢弃');
});

test('目标续跑：task-idle 遇工具计数残留也调度续跑（不白等）', () => {
  const idx = script.indexOf('function onTaskIdle');
  const body = script.slice(idx, idx + 700);
  assert.ok(body.includes('scheduleGoalNudgeRetry()'), 'task-idle 遇计数残留应调度续跑兜底');
});

test('目标续跑：退避有上限，不会无限循环', () => {
  const idx = script.indexOf('function scheduleGoalNudgeRetry');
  const body = script.slice(idx, idx + 900);
  assert.ok(body.includes('goalNudgeRetries >= GOAL_NUDGE_RETRY_MAX'), '应有重试上限判定');
  assert.ok(/Math\.min\(GOAL_NUDGE_DELAY \* Math\.pow\(2/.test(body), '应为指数退避且有上限');
});



test('历史消息编辑：三态按钮组（中间/已完成末轮/待发送）', () => {
  const idx = script.indexOf('function editUserMessage');
  assert.ok(idx > 0, '应有 editUserMessage');
  const body = script.slice(idx, idx + 2500);
  assert.ok(body.includes('msg-edit-truncate danger'), '中间消息应有截断重发');
  assert.ok(body.includes('msg-edit-quote'), '中间消息应有填入输入框');
  assert.ok(/hasRepliedAfter/.test(body), '应区分最后一轮是否已回复');
  assert.ok(body.includes('msg-edit-save primary'), '待发送消息应有重新发送');
});
