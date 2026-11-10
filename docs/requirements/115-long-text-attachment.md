---
id: 115
type: fix
title: 长文本回传改走附件通道（降低脚本特征）
status: doing
branch: fix/115-long-text-attachment
created: 2026-11-10
updated: 2026-11-10
---

# 115：长文本回传改走附件通道（降低脚本特征）

> 状态：**doing**（仅建档案，未开工）
> 分支：`fix/115-long-text-attachment`（已创建，尚无改动）

## 一、用户目标与约束

1. **防封号**：当前长文本注入方式的机械特征过强，是脚本检测的高危信号。
2. **不降智商**：改完之后模型必须仍能读到工具回传的**完整内容**，不能只看到附件文件名。
3. 不影响短消息（工具循环的绝大多数回传）的现有节奏。

硬约束：
- overlay 不依赖上层（`chat-input.ts` 只能用 `electronAPI` 与回调注入）
- 不引入新的跨层依赖
- 附件通道任何环节失败 → 必须回退到现有 `insertText` 路径，绝不能发不出消息

## 二、现状核查（已完成，勿重复调查）

### 2.1 当前长文本注入路径

DeepSeek 输入框是 `<textarea>`，`setInputContent`（`src/overlay/chat-input.ts:93`）的分支顺序：

1. `provider.fillInput` —— **DeepSeek 未实现**（grep 零命中）
2. `electronAPI.insertTextToChat(text)` → IPC `chat-insert-text`
   → 主进程 `src/app/ipc/renderer.ts:113-130` → `sender.insertText(text)`
   → Chromium 原生 IME 管线，`isTrusted=true`
3. 校验长度（`currentText.length >= msg.length - 16`）→ 不符则回退 DOM `value` setter + `input` 事件

`contenteditable` 分支（`chat-input.ts:167-190`）虽有 `ClipboardEvent('paste')`，但 **DeepSeek 是 textarea，永远走不到那里**。

### 2.2 为什么这是高危特征

`sender.insertText` 模拟**键盘逐字敲入**。20000 字意味着：
- 零退格、零停顿、零粘贴
- 输入速率恒定且极快
- 文本形态是工具回传的原始 JSON/日志，本身非人类内容

任何做输入行为分析的站点都能一眼识别。这不只是"像机器人"，是"教科书级的自动化样本"。

### 2.3 人类长文本路径（官方认可）

官方网页版手动粘贴长文本 → DeepSeek 前端监听到 `paste`、检测长度超阈值 → **自动转成 `.txt` 附件卡片**发送。最终请求形态是「短提示词 + 文件附件」。

走这条路 = 走人类路径。

### 2.4 ⚠️ 关键发现：项目里已有成熟的附件上传通道

**`src/app/ipc/cdp-attach.ts` 已经实现了完整的、全程无合成事件的上传通道**（307 行，已投入使用，服务于纯净模式手动上传与 `attachFile` 工具）：

```
1. provider 探测源码（getAttachProbeSource，可选）在页内定位上传入口坐标
2. CDP Input.dispatchMouseEvent 派发**真实鼠标事件**点击入口
3. CDP Page.setInterceptFileChooserDialog 拦截原生文件选择框（不弹窗）
4. Page.fileChooserOpened 事件 → DOM.setFileInputFiles 注入临时文件
5. 站点走原生 change 流程，附件进入输入区
```

- 入口签名：`cdpAttach(ctx: AttachCtx, file: { name, data(base64), mime }): Promise<AttachResult>`
- 现有调用方：`src/app/ipc/harness.ts:553`（`harness-attach` IPC 内）
- 临时文件落盘 → 用完即删（`finally` 里 unlink + rmdir）
- debugger 占用有检测（`wc.debugger.isAttached()` → 返回 `debugger-busy`）

**这意味着：115 不需要新造剪贴板粘贴方案，直接复用这条已被验证过的通道即可。**
它比"合成 ClipboardEvent"（isTrusted=false）和"系统剪贴板+Ctrl+V"（污染用户剪贴板）都更干净。

### 2.5 复用该通道的两个前置未知项

1. **DeepSeek 没有实现 `getAttachProbeSource`**（grep 确认），CDP 通道会走 `genericAttachProbe` 通用关键词探测（`cdp-attach.ts:263`）。
   该探测只在视口下半部找类名/aria/title 含 `attach|upload|paperclip|file|image|图片|文件|上传|添加|附件|相册` 的小尺寸元素。
   **DeepSeek 的上传按钮能否命中，必须真机验证**。命中不了就得给 DeepSeek 写 `getAttachProbeSource`（参考智谱的实现方式）。

2. **模型对 `.txt` 附件的读取完整度未知**。这是本需求最大的风险点。

## 三、方案

### 阶段 0：开工前必做验证（阻塞项，不通过就停）

按顺序做，前一条不通就看下一条：

**验证 1：DeepSeek 上传入口能否被探测到**
- 起开发版（`cuckoo-dev-verify` + CDP 9444），开 DeepSeek 对话页
- 直接在页面注入 `genericAttachProbe` 的源码，看返回 `{ found, x, y, candidates }`
- 若 `found: false` → 用 `document.querySelectorAll` 人工找上传按钮，记录其选择器/类名/aria-label，据此写 DeepSeek 的 `getAttachProbeSource`

**验证 2：cdpAttach 能否真的把 .txt 附件塞进 DeepSeek 输入区**
- 造一个 8000 字符的 .txt，base64 后调 `harness-attach` IPC（或临时脚本直接调 `cdpAttach`）
- 观察页面：输入区是否出现附件卡片、文件名是否正确、有无报错
- 若失败，看返回的 `error` 与页面 `[cuckoo-attach]` 日志定位

**验证 3（最关键）：模型能否读全附件内容**
- 附件上传成功后，发送问题："这个文件第 6000~6100 字符附近写了什么？请原样引用"
- 对比：同样的内容直接用 insertText 贴进输入框，问同样的问题
- **若附件版本读不全 / 只读开头 / 说"已收到文件"后泛泛而谈 → 本方案作废**（踩中"不降智商"红线）
- 若读得全 → 方案成立，进入阶段 1

### 阶段 1：实现（验证通过后）

#### 1.1 主进程新增 IPC

在 `src/app/ipc/harness.ts` 或 `renderer.ts` 新增一个 IPC（建议名 `chat-send-as-file`），入参 `{ text, fileName }`：

```ts
// 伪代码
ipcMain.handle('chat-send-as-file', async (event, { text, fileName }) => {
  const ctx = findContext(event.sender);           // 或 windowState.getContextByWebContents
  if (!ctx?.view || ctx.view.webContents.isDestroyed()) return { success: false, error: 'no-ai-view' };
  const data = Buffer.from(text, 'utf8').toString('base64');
  const r = await cdpAttach(ctx, { name: fileName, data, mime: 'text/plain' });
  return r;
});
```

**注意**：`cdpAttach` 内部会 `wc.debugger.attach()`。若此时 debugger 已被占用（如 CDP 调试连的是同一个 webContents），会返回 `debugger-busy`。需要确认运行时不会与其它 debugger 使用者冲突。

#### 1.2 bridge 暴露 API

`src/bridge/api.ts` 加：
```ts
sendAsFile: (text: string, fileName: string) =>
  ipcRenderer.invoke('chat-send-as-file', { text, fileName }),
```

#### 1.3 overlay 分流

`src/overlay/chat-input.ts` 的 `setInputContent` 之前（或在 `sendToChat` 里）加分流：

```ts
// 伪代码，位置待定（要评估放在 setInputContent 内还是 sendToChat 前）
const ATTACH_THRESHOLD = 4000;   // 与旧 ratio 阈值一致，待真机调
if (msg.length > ATTACH_THRESHOLD && typeof api.sendAsFile === 'function') {
  const fileName = 'tool-result-' + Date.now() + '.txt';
  const r = await api.sendAsFile(msg, fileName);
  if (r && r.success) {
    // 附件已进输入区 → 填入一句短提示词，再走正常发送
    return await setInputContent(input, '（工具输出较长，已作为附件发送，请阅读附件内容）');
  }
  // 失败 → 落回下面的 insertText 路径
}
```

**这里有个设计决策需要在实现时定**：
- 选项 A：附件 + 一句固定短提示词（如"请阅读附件中的工具输出"）→ 多一次模型理解成本
- 选项 B：附件 + 空输入直接发送（DeepSeek 允许只发附件吗？需验证）
- 选项 C：附件 + 原文本的前 N 字摘要（让模型有上下文锚点）

倾向 **A**，最稳。但提示词措辞要简短，且不能触发模型"总结附件"的默认行为。

#### 1.4 阈值与回退

- 阈值初值 4000 字符（与旧 `ratio` 阈值一致）
- 短消息（< 4000）行为完全不变 —— 这是绝大多数工具回传的场景，不能碰
- 附件通道任何环节失败 → 静默回退 `insertTextToChat`，只打 warn 日志

### 阶段 2：其他平台

- ChatGPT / Claude 对 paste 和附件的处理与 DeepSeek 不同（ChatGPT 会把粘贴的长文本识别为"粘贴的文件"）
- 建议：把「是否需要走附件通道」和「附件通道怎么走」做成 provider 钩子，或至少按 `providerId` 分支
- **本需求先只做 DeepSeek**，其他平台保持现状

## 四、风险与防御

| 风险 | 等级 | 防御 |
|---|---|---|
| 模型读不全附件（降智商） | **最高** | 阶段 0 验证 3 必须先过；不过则方案作废 |
| DeepSeek 上传入口探测不到 | 高 | 阶段 0 验证 1；不行就写 `getAttachProbeSource` |
| debugger 冲突（`debugger-busy`） | 中 | 失败即回退 insertText；日志可见 |
| 附件大小限制 | 中 | 需查 DeepSeek 单文件上限；超限则按 MAX_OUTPUT(15000) 截断后再传 |
| 附件 + 提示词可能让模型"偷懒"只读摘要 | 中 | 提示词明确要求"完整阅读附件"；验证 3 专门测这个 |
| 用户手动打字时被打断 | 低 | 工具回传是自动流程，用户此时通常在等待 |

## 五、验收标准

- [ ] 阶段 0 三条验证完成，结论写进本档案「验证记录」
- [ ] 长文本（> 4000 字符）回传后，模型能正确引用内容**中段**（不降智商）
- [ ] 短文本（< 4000）回传行为无任何变化
- [ ] 附件通道失败能静默回退到 insertText，消息不丢
- [ ] typecheck / test / lint / compile 全绿
- [ ] 真机验证（开发版 `cuckoo-dev-verify`）

## 六、关键代码位置索引（接手必读）

| 用途 | 路径 | 关键行 |
|---|---|---|
| 当前注入分流逻辑 | `src/overlay/chat-input.ts` | `setInputContent` L93-196 |
| 发送入口（含延迟） | `src/overlay/chat-input.ts` | `sendToChat` L253 |
| 回传长度硬上限 15000 | `src/overlay/chat-input.ts` | L405 `MAX_OUTPUT` |
| 原生 insertText IPC | `src/app/ipc/renderer.ts` | `chat-insert-text` L113-130 |
| **附件上传主流程** | `src/app/ipc/cdp-attach.ts` | `cdpAttach` L28-256 |
| 通用上传入口探测 | `src/app/ipc/cdp-attach.ts` | `genericAttachProbe` L263-306 |
| 附件 IPC 现有入口 | `src/app/ipc/harness.ts` | `harness-attach` L539-576 |
| Provider 附件钩子定义 | `src/providers/types.ts` | `getAttachProbeSource` L80-88 |
| bridge 暴露 API | `src/bridge/api.ts` | L11-130 |

## 七、遗留 / 后续

（完成后补）

## 八、验证记录

（阶段 0 完成后在此记录：探测结果 / 上传结果 / 模型读取完整度对比）
