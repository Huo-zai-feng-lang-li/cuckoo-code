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

test('ai-state 心跳不得刷新 lastActivityAt（否则静默兜底永久失效）', () => {
  // 回归背景：心跳每 2s 一次且无条件续命 lastActivityAt，
  // 使 onAiState / 1.5s 兜底的静默判据永远不成立 → AI 侧已停止（如限流重试耗尽）
  // 时界面永久卡在运行中，只能手动点停止解套。
  const idx = script.indexOf('api.onEvent(function (payload)');
  assert.ok(idx > 0, '应能找到事件分发入口');
  const body = script.slice(idx, idx + 800);
  assert.ok(
    /if \(payload\.type !== 'ai-state'\) lastActivityAt = Date\.now\(\);/.test(body),
    'ai-state 必须排除在活动刷新之外'
  );
});

test('自动重试状态接入：等待期间保持忙、耗尽立即收尾', () => {
  assert.ok(script.includes("case 'retry-state'"), '事件分发应处理 retry-state');
  assert.ok(/function onRetryState\s*\(/.test(script), '应有 onRetryState 处理函数');
  const idx = script.indexOf('function onRetryState');
  const nextFn = script.indexOf('\n  function ', idx + 10);
  const body = script.slice(idx, nextFn > 0 ? nextFn : idx + 2000);
  // 等待期间：必须置忙（否则倒计时开始界面就"就绪"了）
  // 实现：pending 启动每秒刷新的倒计时 tick，由 tick 置忙并逐秒更新文案
  assert.ok(body.includes('startRetryTick(d)'), 'pending 应启动倒计时');
  const startIdx = script.indexOf('function startRetryTick');
  const startBody = script.slice(startIdx, startIdx + 800);
  // 进入忙态只做一次（在 startRetryTick 里），tick 内只做轻量文案刷新
  assert.ok(/setStatus\([^)]*'busy'\)/.test(startBody), '倒计时启动必须进入忙态');
  const tickIdx = script.indexOf('function renderRetryTick');
  const tickBody = script.slice(tickIdx, tickIdx + 1200);
  assert.ok(tickBody.includes('stopRetryTick'), '倒计时结束必须自停（防泄漏）');
  // 耗尽：必须立即收尾，不能等超时
  assert.ok(body.includes("setStatus('重试已达上限', 'ready')"), 'exhausted 应收尾');
  // 等待窗口内静默判据要被豁免（onAiState 与 1.5s 兜底两处都必须）
  const guards = script.split('if (retryUntil > Date.now())').length - 1;
  assert.ok(guards >= 2, 'onAiState 与 1.5s 兜底都应豁免重试等待窗口');
  // 清理路径必须有：否则残留会让后续任务永远豁免静默收尾
  assert.ok(body.includes('retryUntil = 0'), 'onRetryState 应清 retryUntil');
  const clearFn = script.slice(script.indexOf('function clearTransientState'));
  assert.ok(
    clearFn.slice(0, 2000).includes('retryUntil = 0'),
    'clearTransientState 应清 retryUntil'
  );
});

test('onAssistantDone 接 hasTool：含工具时保持忙态，避免闪「就绪」', () => {
  // 回归背景：observer 先通知 assistant-done、后执行工具（发 tool-start）。
  // 此刻 toolRunningCount 仍为 0，若不看 hasTool，状态栏会短暂显示「就绪」。
  const idx = script.indexOf('function onAssistantDone');
  assert.ok(idx > 0, '应能找到 onAssistantDone');
  const nextFn = script.indexOf('\n  function ', idx + 10);
  const body = script.slice(idx, nextFn > 0 ? nextFn : idx + 2000);
  assert.ok(/function onAssistantDone\s*\(text, hasTool\)/.test(body), '应接收 hasTool 参数');
  assert.ok(body.includes('else if (hasTool) setStatus('), 'hasTool 为真时应保持忙态');
  // 透传链路两端都要接上
  assert.ok(
    script.includes('onAssistantDone(adRaw, payload.hasTool)'),
    'assistant-done 分支应透传 hasTool'
  );
});

test('过渡态用状态位而非文案前缀匹配', () => {
  // 回归背景：原先 onStream 靠 /^框架：/ 匹配状态栏文案判断过渡态，
  // 文案一改（技术词→人话）就静默失效，状态栏会整轮冻在过渡文案上。
  assert.ok(/var inFrameworkPhase = false;/.test(script), '应有 inFrameworkPhase 状态位');
  const setIdx = script.indexOf('function setStatus');
  const setNext = script.indexOf('\n  function ', setIdx + 10);
  const setBody = script.slice(setIdx, setNext > 0 ? setNext : setIdx + 1200);
  assert.ok(setBody.includes('inFrameworkPhase = false'), 'setStatus 应清状态位');
  const fwIdx = script.indexOf('function onFrameworkSend');
  const fwNext = script.indexOf('\n  function ', fwIdx + 10);
  const fwBody = script.slice(fwIdx, fwNext > 0 ? fwNext : fwIdx + 1500);
  assert.ok(fwBody.includes('inFrameworkPhase = true'), 'onFrameworkSend 应置状态位');
  // 置位必须在 setStatus 之后：setStatus 会清零，先置后清等于没置
  const setCallAt = fwBody.indexOf('setStatus(');
  const flagAt = fwBody.indexOf('inFrameworkPhase = true');
  assert.ok(setCallAt >= 0 && flagAt > setCallAt, '置位必须在 setStatus 之后，否则会被立刻清掉');
  // clearTransientState 直接改 DOM 绕过 setStatus，必须显式清
  const clearIdx = script.indexOf('function clearTransientState');
  assert.ok(
    script.slice(clearIdx, clearIdx + 2500).includes('inFrameworkPhase = false'),
    'clearTransientState 应清状态位（它绕过 setStatus）'
  );
});

test('暂停通知在运行态同步期间保持优先，并在暂停结束后切等待投递', () => {
  assert.ok(/var sendPauseActive = false;/.test(script), '应记录长暂停活动状态');
  const syncIdx = script.indexOf('function syncPet');
  const syncEnd = script.indexOf('\n  function ', syncIdx + 10);
  const syncBody = script.slice(syncIdx, syncEnd > 0 ? syncEnd : syncIdx + 1500);
  assert.ok(syncBody.includes('if (sendPauseActive)'), '运行态同步应优先维持暂停情绪');
  assert.ok(syncBody.includes("petMood('pausing')"), '同步期间内嵌宠物应保持暂停情绪');
  assert.ok(syncBody.includes("state: 'pausing'"), '同步期间独立宠物应保持暂停状态');
  const eventIdx = script.indexOf("case 'send-pause'");
  const eventBody = script.slice(eventIdx, eventIdx + 900);
  assert.ok(eventBody.includes('sendPauseActive = !!payload.active'), '暂停开始和结束都应更新状态');
  assert.ok(eventBody.includes("petMood('waiting')"), '暂停结束应先切等待投递情绪');
});

test('长暂停结束先进入等待投递态，不能回落「生成中」', () => {
  // 回归背景：tool-end 为了保活 sendTick 把 generating 置为 true；
  // 暂停结束直接 syncPet() 会命中 generating 分支，宠物先冒「生成中…」，
  // 随后 framework-send 才冒「把结果发给 AI…」，用户看到的状态顺序颠倒。
  const eventIdx = script.indexOf("case 'send-pause'");
  assert.ok(eventIdx > 0, '应处理 send-pause');
  const eventEnd = script.indexOf("case 'send-result'", eventIdx);
  assert.ok(eventEnd > eventIdx, 'send-pause 分支后应有 send-result 分支');
  const eventBody = script.slice(eventIdx, eventEnd);
  const branchStart = eventBody.indexOf('else if (wasPauseActive) {');
  assert.ok(branchStart > 0, 'send-pause 应有暂停结束分支');
  const branchEnd = eventBody.indexOf('if (sendPauseActive)', branchStart);
  assert.ok(branchEnd > branchStart, '暂停结束分支后应有运行态分支');
  const branchBody = eventBody.slice(branchStart, branchEnd);
  assert.ok(branchBody.includes('stopSendTick()'), '暂停结束必须停表');
  assert.ok(branchBody.includes("petMood('waiting')"), '暂停结束应切等待投递情绪');
  assert.ok(branchBody.includes('把结果发给 AI'), '暂停结束应提示结果正在发给模型');
  assert.ok(/正在发送/.test(branchBody), '状态栏应进入正在发送态，不能停在上一个暂停文案');
  assert.ok(!/^\s+syncPet\(\);/m.test(branchBody), '暂停结束不能直接 syncPet（会被 generating 按回生成中）');
});

test('长暂停下排显示次数/总时长/等待秒数，不走等待发送旧文案', () => {
  // 回归背景：暂停期间等待发送秒表仍在每秒把下排刷回「等待发送 Xs」，
  // 暂停分支只切了上排情绪，下排看不出这是触发了随机概率延迟。
  const eventIdx = script.indexOf("case 'send-pause'");
  assert.ok(eventIdx > 0, '应处理 send-pause');
  const eventBody = script.slice(eventIdx, eventIdx + 600);
  assert.ok(eventBody.includes('pauseCount++'), '每次暂停开始应累计次数');
  assert.ok(/pauseDurationMs = payload\.active \? \(payload\.durationMs \|\| 0\) : 0;/.test(eventBody), '应记录本次暂停时长（毫秒）');
  assert.ok(script.includes('触发随机概率延迟'), '下排文案应点明触发随机概率延迟');
  assert.ok(script.includes('等待发送'), '下排应保留等待发送已走秒数');
  const syncIdx = script.indexOf('function syncPet');
  const syncEnd = script.indexOf('\n  function ', syncIdx + 10);
  const syncBody = script.slice(syncIdx, syncEnd > 0 ? syncEnd : syncIdx + 1500);
  assert.ok(syncBody.includes('pauseStatusText()'), '暂停分支应调用统一文案函数');
  const psIdx = script.indexOf('function pauseStatusText');
  assert.ok(psIdx > 0, '应有暂停下排文案函数');
  const psBody = script.slice(psIdx, psIdx + 400);
  assert.ok(psBody.includes('pauseDurationMs'), '文案函数应使用记录的暂停时长');
  assert.ok(psBody.includes('Math.round(pauseDurationMs / 1000)'), '暂停时长应换算成秒');
});

test('暂停期间 petBubble 下发浮窗 state 保持 pausing（不被打回 thinking）', () => {
  // 回归背景：renderSendTick 每秒经 petBubble 下发浮窗状态，原三元只看
  // toolRunningCount/generating，暂停期间 generating=true 会把浮窗 state 覆盖回 thinking，
  // 上排走神句被拉回 thinking 组。
  const idx = script.indexOf('function petBubble');
  assert.ok(idx > 0, '应有 petBubble 函数');
  const body = script.slice(idx, idx + 600);
  assert.ok(/state: sendPauseActive \? 'pausing' :/.test(body), '暂停态浮窗 state 应为 pausing');
});

test('切会话/新对话清零暂停次数（按当前会话计数）', () => {
  const idx = script.indexOf('function clearTransientState');
  assert.ok(idx > 0, '应有 clearTransientState');
  const body = script.slice(idx, idx + 2000);
  assert.ok(body.includes('pauseCount = 0'), '切会话/新对话应清零暂停次数');
});

test('长暂停结束不重置 sendStartAt（避免幽灵「等待发送」窗口）', () => {
  // 回归背景：暂停结束分支原先把 sendStartAt 重置为当前时刻；
  // 但 chat-input 在 didLongPause 分支已清零常规延迟，消息即刻发出，
  // 真实不存在「等待发送」窗口，UI 却从 0 计秒，显示一段幽灵等待。
  const eventIdx = script.indexOf("case 'send-pause'");
  assert.ok(eventIdx > 0, '应处理 send-pause');
  const eventBody = script.slice(eventIdx, eventIdx + 900);
  const branchStart = eventBody.indexOf('else if (wasPauseActive) {');
  assert.ok(branchStart > 0, 'send-pause 应有暂停结束分支');
  const branchBody = eventBody.slice(branchStart, branchStart + 300);
  assert.ok(
    branchBody.includes('stopSendTick()'),
    '暂停结束必须停表，否则会显示不存在的「等待发送 Ns」'
  );
  assert.ok(
    !branchBody.includes('sendStartAt = Date.now()'),
    '暂停结束不得重置 sendStartAt（会造成幽灵计时）'
  );
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

// ===== 逐请求回执：失败回填草稿，不覆盖用户新输入 =====

test('回执草稿：有 pendingDraft 状态与 settleDraft 配对函数', () => {
  assert.ok(/var pendingDraft = null;/.test(script), '应有 pendingDraft 状态');
  assert.ok(/function settleDraft\s*\(/.test(script), '应有 settleDraft 配对函数');
  assert.ok(/function newRequestId\s*\(/.test(script), '应生成本地 requestId');
});

test('回执草稿：失败仅在输入框为空时回填，非空不覆盖', () => {
  const idx = script.indexOf('function settleDraft');
  const body = script.slice(idx, idx + 900);
  assert.ok(body.includes('pendingDraft.requestId !== requestId'), '回执须按 requestId 配对，旧回执不串');
  assert.ok(body.includes('pendingDraft = null'), 'settle 后必须清草稿（幂等）');
  assert.ok(/!input\.value\.trim\(\)/.test(body), '回填前必须判输入框为空');
  assert.ok(body.includes('input.value = draft.text'), '回填用户原文');
  assert.ok(body.includes('autoGrowInput()'), '回填后应复位输入框高度');
});

test('回执草稿：事件通道 send-result 按 requestId 配对 settle', () => {
  const idx = script.indexOf("case 'send-result'");
  assert.ok(idx > 0, '事件分发应处理 send-result');
  const body = script.slice(idx, idx + 400);
  assert.ok(body.includes('settleDraft(payload.requestId, payload.success === true || isSoftSendFailure(payload))'), '事件回执应按 requestId 配对，并识别软失败');
});

test('回执草稿：TTL 过期清理，避免旧草稿回填到新消息', () => {
  assert.ok(/var DRAFT_TTL_MS = 150000;/.test(script), '应有与回执超时同档的草稿 TTL');
  assert.ok(/function dropExpiredDraft\s*\(/.test(script), '应有过期清理函数');
  const sendIdx = script.indexOf('function send(');
  const sendBody = script.slice(sendIdx, sendIdx + 1200);
  assert.ok(sendBody.includes('dropExpiredDraft()'), '发送前应清理过期草稿');
});

test('回执草稿：requestId 贯穿 sendMessage 调用，override 投递不存草稿', () => {
  assert.ok(/var draftRequestId = hasOverride \? null : newRequestId\(\);/.test(script), '仅普通直发生成 requestId');
  const calls = script.match(/api\.sendMessage\([^,]+,\s*draftRequestId\)/g);
  assert.ok(calls && calls.length >= 1, 'sendMessage 应携带 requestId 配对回执');
});

// ===== 代码块增强（需求 121：语法着色 + 独立复制）=====

test('代码块增强：结构函数与 renderMarkdown 出口接线', () => {
  assert.ok(/function highlightCodeEl\s*\(/.test(script), '应有语法着色函数');
  assert.ok(/function decorateCodeBlocks\s*\(/.test(script), '应有代码块结构增强函数');
  assert.ok(/function enhanceCodeBlocksHtml\s*\(/.test(script), '应有 HTML 字符串增强入口');
  // renderMarkdown 必须在返回前增强：否则 6 个渲染入口全部拿不到头栏/着色
  const idx = script.indexOf('function renderMarkdown');
  const body = script.slice(idx, script.indexOf('\n  }', script.indexOf('return enhanceCodeBlocksHtml', idx)));
  assert.ok(body.includes('return enhanceCodeBlocksHtml(src)'), 'renderMarkdown 成功分支应经增强后返回');
  // 增强必须在 sanitizer 之后（先净化再插结构，避免增强产物被 sanitizer 剥掉或绕过净化）
  assert.ok(body.indexOf('CuckooSanitize.sanitizeHtml') < body.indexOf('enhanceCodeBlocksHtml'), '增强应在 sanitizer 之后');
});

test('代码块复制：事件委托绑在 #stream（流式重建不丢监听）', () => {
  assert.ok(/function bindCodeCopyDelegation\s*\(/.test(script), '应有复制委托绑定函数');
  assert.ok(/bindCodeCopyDelegation\(stream\)/.test(script), '委托应绑在 #stream 上');
  const idx = script.indexOf('function bindCodeCopyDelegation');
  const body = script.slice(idx, idx + 1400);
  assert.ok(body.includes("closest('.code-copy-btn')"), '应按按钮类名识别点击目标');
  assert.ok(body.includes('pre code'), '复制内容应取自 code 元素');
  // 委托函数自己绑一次；关键是结构增强函数不得给每个按钮绑监听
  const dIdx = script.indexOf('function decorateCodeBlocks');
  const dBody = script.slice(dIdx, dIdx + 1200);
  assert.ok(!dBody.includes('addEventListener'), '结构增强不得给每个按钮绑监听（会被流式重建冲掉）');
});

test('代码块增强：未知语言与空块降级不丢内容', () => {
  const idx = script.indexOf('function highlightCodeEl');
  const body = script.slice(idx, script.indexOf('function decorateCodeBlocks', idx));
  // 未知语言（如 cuckoo）不高亮，保留原文本
  assert.ok(body.includes('hl.getLanguage(lang)'), '应校验语言是否已注册，未注册不硬高亮');
  assert.ok(body.includes('if (!out || typeof out.value'), '高亮失败须直接返回，不改动原文本');
  assert.ok(/catch \(e\) \{ out = null; \}/.test(body), '高亮异常须被吞掉并降级');
  // 空 pre 不增强（避免残留只有头栏的空壳）
  const dIdx = script.indexOf('function decorateCodeBlocks');
  const dBody = script.slice(dIdx, script.indexOf('function bindCodeCopyDelegation', dIdx));
  assert.ok(dBody.includes("pre.textContent || ''"), '应跳过空代码块');
});

test('代码块复制/删除匹配：取正文时剔除代码块头栏', () => {
  // 头栏含语言标签与「复制/已复制」文案，若用 body.innerText 取文本，
  // 整条复制与"按文本匹配历史"都会被污染 → 必须走剥离头栏的 plainBodyText
  assert.ok(/function plainBodyText\s*\(/.test(script), '应有剔除头栏的取文函数');
  const idx = script.indexOf('function plainBodyText');
  const body = script.slice(idx, script.indexOf('function attachAssistantActions', idx));
  assert.ok(body.includes("querySelectorAll('.code-header')"), '应移除头栏节点');
  assert.ok(!/body\.innerText/.test(script), '正文取文不得直接用 body.innerText');
});

test('代码块增强：页面加载 highlight.js 且与 CSP 兼容', () => {
  assert.ok(html.includes('vendor/hljs/hljs.min.js'), '页面应加载本地 hljs 产物');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, '应有 CSP');
  assert.ok(/script-src[^;]*'self'/.test(csp[1]), 'CSP 应允许同源脚本');
  assert.ok(!/script-src[^;]*https?:/.test(csp[1]), '不应为着色放宽到远程脚本');
});

test('代码块增强：样式与明暗主题 token 齐备', () => {
  assert.ok(/\.msg\.assistant \.body \.code-wrapper \{/.test(html), '应有 .code-wrapper 样式');
  assert.ok(/\.msg\.assistant \.body \.code-header \{/.test(html), '应有 .code-header 样式');
  assert.ok(/\.msg\.assistant \.body \.code-copy-btn \{/.test(html), '应有 .code-copy-btn 样式');
  assert.ok(/\.msg\.assistant \.body \.code-wrapper > pre \{/.test(html), 'wrapper 内 pre 需去掉自带边框背景（防双框）');
  assert.ok(/--hl-keyword:/.test(html), '应有 hljs token 浅色配色');
  const darkIdx = html.indexOf('body[data-ck-dark]');
  assert.ok(darkIdx > 0 && html.indexOf('--hl-keyword:', darkIdx) > darkIdx, '深色主题应覆盖 hljs 配色');
});

// ===== 长任务折叠/滚动稳定性（防回退到"折叠时视口跳一下"）=====

test('折叠滚动：使用滚动锚点补偿展开/折叠两个方向', () => {
  assert.ok(/function captureCollapseAnchor\s*\(/.test(script), '应有折叠锚点捕获');
  assert.ok(script.includes('anchor.node.getBoundingClientRect().top - anchor.top'), '应按锚点位移补偿 scrollTop');
  assert.ok(script.includes('startTop + (stream.scrollHeight - startH)'), '无后继元素时按有符号高度差兜底');
  assert.ok(!script.includes("startTop - Math.max(0, startH - stream.scrollHeight)"), '不能只补偿收缩，展开时会跳');
});

test('折叠滚动：过渡时长与抑制贴底窗口一致', () => {
  assert.ok(html.includes('transition: max-height .32s'), '思考/工具块折叠过渡应为 320ms');
  const calls = script.match(/toggleDetail\([^\n]+320\)/g) || [];
  assert.ok(calls.length >= 4, '自动折叠与手动折叠都应使用 320ms');
});

test('工具卡自动折叠：先给用户看结果，再平滑收起', () => {
  assert.ok(script.includes('}, 500);'), 'tool-end 后应延迟 500ms 再自动折叠');
  assert.ok(script.includes('target.__ckUserToggled'), '用户手动操作过的卡片不得被自动折叠抢走');
});

// ===== 思考块内部滚动（API 模式与网页窗口模式共用 harness）=====

test('思考块流式更新：不重建文本节点，避免 textContent 把 scrollTop 重置到 0', () => {
  // 回归背景：textContent 全量重写会销毁文本节点，浏览器把内部 scrollTop 归零；
  // 随后的 scroll 事件被误判成"用户上翻"，thinkFollow=false，后续思考永远停在顶部。
  assert.ok(/function setThinkText\s*\(/.test(script), '应有文本节点增量更新函数');
  assert.ok(script.includes('setThinkText(cur.thinkBody, think)'), 'onStream 应通过文本节点更新思考内容');
  assert.ok(!script.includes('cur.thinkBody.textContent = think'), '不得再用 textContent 全量重写思考体');
  assert.ok(/__ckThinkTextNode/.test(script), '应复用同一个文本节点');
});

test('思考块展开与流式跟随：始终定位到最新一行', () => {
  assert.ok(/function scrollThinkToLatest\s*\(/.test(script), '应有思考块贴底函数');
  assert.ok(script.includes('scrollThinkToLatest(cur'), '流式/自动展开时应贴底');
  assert.ok(/scrollThinkToLatest\(\{\s*thinkBody:/.test(script), '静态历史展开时应贴底');
  // 展开有 320ms max-height 过渡，贴底必须跨过渡期复测，而不是只写一次 scrollTop
  assert.ok(script.includes('requestAnimationFrame(pin)'), '贴底应跨帧复测');
  assert.ok(script.includes('body.__ckThinkPinTimer'), '贴底定时器应可复用/清理');
});

test('内嵌滚动容器使用统一细滚动条', () => {
  for (const sel of ['.think-body', '.tool-body', '.tool-pre', '.plan-body']) {
    assert.ok(html.includes(sel + '::-webkit-scrollbar'), sel + ' 应有滚动条样式');
  }
  assert.ok(html.includes('scrollbar-gutter: stable'), '内嵌滚动容器应预留滚动条槽，避免出现时内容横向抖动');
  assert.ok(/\n\s*\.stream\s*\{[^}]*overscroll-behavior: contain;/.test(html), '最外层对话区应阻止滚动链传导');
  // 内层容器（思考/工具/计划）不能 contain：滚到顶/底后需把滚轮链回 .stream，
  // 否则鼠标停在工具卡上时对话主区域滚不动（用户实测回归）。
  assert.ok(!/\.(think-body|tool-body|tool-pre|plan-body)[^{]*\{[^}]*overscroll-behavior/.test(html), '内层滚动容器不得阻断滚动链');
});

test('计划/目标模式骨架未受滚动改动影响', () => {
  assert.ok(/function renderPlan\s*\(/.test(script), '计划渲染函数应保留');
  assert.ok(/function renderPlanBar\s*\(/.test(script), '计划状态条应保留');
  assert.ok(/function renderGoalBar\s*\(/.test(script), '目标条渲染应保留');
  assert.ok(html.includes('id="plan-panel"') && html.includes('id="goalbar"'), '计划/目标面板 DOM 应保留');
  assert.ok(html.includes('id="plan-confirm"') && html.includes('id="goal-toggle"'), '计划/目标操作按钮应保留');
});

test('API 模型设置：自动拉列表、搜索选中、默认第一', () => {
  assert.ok(html.includes('id="api-model-trigger"') && html.includes('id="api-model-menu"'), '应有可展开的模型选择器');
  assert.ok(html.includes('id="api-model-search"'), '模型列表应支持搜索');
  assert.ok(/function refreshApiModels\s*\(/.test(script), '应有模型列表拉取函数');
  assert.ok(script.includes('api.listApiModels({ baseUrl: baseUrl, apiKey: enteredKey })'), '应把表单 Base URL/Key 传给主进程拉列表');
  assert.ok(script.includes('setApiModel(apiModelList[0], false)'), '空模型时应默认选中第一项');
  assert.ok(script.includes('if (!currentModel && apiModelList.length)'), '已有模型不应被 /models 列表覆盖');
  assert.ok(script.includes('renderApiModelList'), '应渲染可点击的模型项');
  assert.ok(html.includes('min-height: 30px') && html.includes('line-height: 1.6'), '模型列表行应有足够高度，避免文字被压扁');
  assert.ok(!script.includes("modelPicker.setAttribute('title'"), '不应给模型触发器设置原生 tooltip，避免盖住搜索框');
});

test('API 本地历史按 profile + session 双作用域隔离；新对话不误删旧会话', () => {
  assert.ok(/function apiScopeSuffix\s*\(/.test(script), '应有 profile/session 作用域后缀');
  assert.ok(script.includes("apiScopeSuffix(sid)"), 'hist/plan/goal key 应带 profile/session 作用域');
  assert.ok(script.includes("(apiSessionId ? ':' + apiSessionId : '')"), '作用域后缀应包含 apiSessionId');
  assert.ok(script.includes('nextApiSessionId'), 'API 新对话应接收主进程新建的 sessionId');
  assert.ok(script.includes('localStorage.removeItem(histKey())'), '新对话只应清掉新 session 的本地历史');
  assert.ok(script.includes('payload.profileId'), 'session-changed 事件应透传 profileId');
  assert.ok(script.includes('payload.apiSessionId'), 'session-changed 事件应透传 apiSessionId');
  assert.ok(script.includes('function scopedSessionKey()'), '内存计划条目也应按 session 隔离');
});

test('API 多会话左侧栏：常驻列表、切换、新建、删除', () => {
  assert.ok(html.includes('id="btn-api-sessions"') && html.includes('id="api-session-menu"'), '应有会话侧栏入口');
  assert.ok(html.includes('id="api-session-list"') && html.includes('id="api-session-new"'), '侧栏内应有列表与新建按钮');
  assert.ok(!html.includes('body.ck-api-mode #btn-api-sessions { display: none'), 'API 模式必须显示会话入口');
  assert.ok(html.includes('ck-api-sidebar-open'), '侧栏展开时应右移聊天区');
  const sessionMenuCss = html.match(/\.api-session-menu \{[\s\S]*?\}/)?.[0] || '';
  assert.ok(!/border-right/.test(sessionMenuCss), '会话侧栏右侧不应有分隔线');
  assert.ok(html.includes('body.ck-api-mode .api-usage.has-data { display: none !important; }'), '顶栏 token 不应与右下角重复');
  assert.ok(script.includes('window.harnessAPI.listApiSessions()'), '应调用主进程会话列表');
  assert.ok(script.includes('window.harnessAPI.selectApiSession('), '应调用主进程切换会话');
  assert.ok(script.includes('window.harnessAPI.deleteApiSession('), '应调用主进程删除会话');
  assert.ok(script.includes("case 'api-session':"), '应处理主进程 active 会话变更事件');
  assert.ok(script.includes("case 'reset': resetConversation(payload && payload.apiSessionId)"), 'reset 事件应消费新 sessionId');
  assert.ok(script.includes('function refreshApiSessionList()') && script.includes('function switchApiSession('), '应有列表刷新/切换实现');
  assert.ok(script.includes('function deleteApiSession(') && script.includes('clearSessionLocalState('), '删除会话后应清本地作用域存档');
  assert.ok(!script.includes('open.title =') && !script.includes('del.title ='), '会话项不应使用原生 hover tooltip');
  assert.ok(!html.includes('id="btn-api-sessions" title='), '顶部会话入口不应使用原生 hover tooltip');
});

test('API 会话入口在顶栏左侧，菜单默认收起', () => {
  const topbarStart = html.indexOf('<div class="topbar">');
  const brandIndex = html.indexOf('<div class="brand">', topbarStart);
  const triggerIndex = html.indexOf('id="btn-api-sessions"', topbarStart);
  assert.ok(triggerIndex > topbarStart, '顶栏应含会话入口');
  assert.ok(triggerIndex < brandIndex, '会话入口应在品牌左侧，而不是顶栏右侧');
  assert.ok(html.includes('data-tooltip="打开会话 (Ctrl+B)"'), '左侧会话入口应提示 Ctrl+B');
  assert.ok(html.includes('aria-expanded="false"'), '会话入口初始应为收起状态');
  assert.ok(script.includes('setApiSessionMenuOpen(false)'), '进入 API 模式时应默认收起会话菜单');
});

test('历史会话项不再显示蓝色左边框', () => {
  const activeRule = html.match(/\.api-session-row\.active \{[\s\S]*?\}/)?.[0] || '';
  assert.ok(activeRule, '应有会话项 active 样式');
  assert.ok(!activeRule.includes('box-shadow'), 'active 会话项不应再画左侧蓝色边框线');
});

test('控制台快捷键：Ctrl+B 切换会话菜单，Ctrl+N 提示新对话', () => {
  assert.ok(html.includes('data-tooltip="新对话 (Ctrl+N)"'), '新对话按钮应提示 Ctrl+N');
  assert.ok(html.includes('aria-keyshortcuts="Control+N Meta+N"'), '新对话按钮应声明 Ctrl+N 快捷键');
  assert.ok(script.includes("key === 'b'") || script.includes("key === 'B'"), '应监听 Ctrl+B');
  assert.ok(script.includes('setApiSessionMenuOpen(!apiSessionMenuOpen)'), 'Ctrl+B 应切换会话菜单');
  assert.ok(script.includes('ev.preventDefault()'), 'Ctrl+B 应 preventDefault，避免浏览器默认行为');
});

test('API 设置两列表单：Label 顶对齐、输入框底对齐', () => {
  assert.ok(html.includes('.enh-row { display: flex; gap: 10px; align-items: stretch; }'), '两列行应拉伸等高');
  assert.ok(html.includes('margin-top: auto'), '输入框应贴底对齐，避免 label 换行把输入框推歪');
});

test('API 关闭图片输入时附件按钮仍可用（文本附件不受影响）', () => {
  assert.ok(!html.includes('body.ck-api-mode:not(.ck-api-vision) #attach-btn { display: none'), '附件入口不能随图片开关整体隐藏');
});

test('API 编辑旧消息：先截断主进程上下文，再截断本地历史并发送', () => {
  // 回归背景：API 模式只截断 DOM/localStorage，st.messages 没动，
  // 下一条消息会把旧 user 继续发给模型，表现为“编辑变追加”。
  const submitIdx = script.indexOf('function doSubmitLatest');
  assert.ok(submitIdx > 0, '应有 doSubmitLatest');
  const submitBody = script.slice(submitIdx, submitIdx + 900);
  assert.ok(submitBody.includes('truncateApiContextFromHistItem'), '重新发送必须先截断 API 上下文');
  assert.ok(submitBody.includes('truncateApiContextFromHistItem(histItem, commit'), '截断成功后才执行本地删除+发送');
  assert.ok(submitBody.includes('deleteUserMessage(msgEl, histItem)'), '本地删除仍保留在 commit 回调中');

  const truncIdx = script.indexOf('function doTruncate');
  assert.ok(truncIdx > 0, '应有 doTruncate');
  const truncBody = script.slice(truncIdx, truncIdx + 1600);
  assert.ok(truncBody.includes('truncateApiContextFromHistItem'), '截断重发必须先截断 API 上下文');
  assert.ok(truncBody.includes('truncateUserMessage'), '截断成功后再截断本地历史');
  assert.ok(
    truncBody.indexOf('truncateApiContextFromHistItem') < truncBody.indexOf('truncateUserMessage'),
    'API 上下文截断必须早于本地截断',
  );
});

test('API 设置：关闭即保存，无底部保存按钮', () => {
  assert.ok(!html.includes('id="api-save"'), '不应再有底部保存按钮');
  assert.ok(!script.includes('apiTransportEls.save'), '不应再绑定保存按钮');
  assert.ok(script.includes('saveApiTransportForm(true)'), '关闭弹窗应自动保存');
  assert.ok(/function closeApiSettings\s*\(/.test(script), '应统一关闭入口');
});
