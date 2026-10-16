---
id: 071
type: fix
title: 思考阶段 TPS 显示 -- （只估算正文，忽略思考内容）
status: done
branch: fix/071-tps-think
created: 2026-10-16
updated: 2026-10-16
---

# 071 — 思考阶段 TPS 显示 -- 修复

## 背景

用户真机观察：DeepSeek 输出思考内容时，底栏输出速度显示 `-- t/s`，不变化。

## 根因

TPS 计算链路（`src/overlay/events.ts:417`）：
```js
const text = (ev && ev.text) || '';   // 只取【正文】，think 被丢弃
tpsMeter.update(text, finished, acc);
```

TPS 两条路径在思考阶段都失效：
1. **估算路径**：用正文长度估 token。思考阶段正文为空 → 算不出速度。
2. **精确路径**：用服务端 `acc`。DeepSeek 该值思考阶段通常未下发（null）。

结果 `tpsMeter.value = 0` → `formatTps(0)` 返回空 → 显示 `-- t/s`。

而 hook 早已携带思考内容：`deepseek.ts:105` 的 dispatchStream detail 含 `think`，observer 转发（observer.ts:403），overlay 回调里 `ev.think` 可用——只是没被 TPS 用上。

## 修复

`events.ts` TPS 回调：`text = (ev.text||'') + (ev.think||'')`，思考阶段也能用思考字数估算出速度。

- 拼接后长度单调递增，不会误触发 tpsMeter 的"新一轮"检测（`textLen < lastTextLen`）。
- `estimateTokens` 只看字符构成，与 text/think 来源无关。
- 平台提供 `acc`（精确路径）时该参数被忽略，不受影响。

## 改动文件
- `src/overlay/events.ts`（1 行）

## 验证
- typecheck / test(988) / lint(0 error) / compile 全绿
- tps 单测 17 个全过
