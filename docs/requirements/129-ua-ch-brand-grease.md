---
id: 129
type: fix
title: Chrome UA-CH 品牌 GREASE / 顺序与高熵字段一致性修复
status: doing
branch: master
created: 2026-11-23
updated: 2026-11-23
---

# 129 Chrome UA-CH 品牌 GREASE / 顺序与高熵字段一致性修复

- 状态：代码、单测、Electron 探针完成；待用户真机验收
- 日期：2026-11-23
- 版本：`v0.10.233`
- 前置：需求 127（登录/运行环境特征修复）

## 用户现象

在 `chat.deepseek.com` 的 DevTools 控制台里：

```js
navigator.userAgentData.brands
// [{ brand: "Not?A_Brand", version: "24" }, { brand: "Chromium", version: "152" }]
```

没有 `Google Chrome`，且控制台已经打印「主世界指纹修正已注入」。高熵
`getHighEntropyValues(['brands','fullVersionList','platformVersion'])` 同样缺
`Google Chrome`，`fullVersionList` 只有 `Not?A_Brand` 与 `Chromium`。

真 Chrome 152 的实测值（Clearcote，2026-09 实测，
<https://www.clearcotelabs.com/chrome-releases/152>）：

```text
Sec-CH-UA: "Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"
```

## 根因

1. **GREASE 品牌与顺序写死**：`user-agent.ts` 三处把假品牌写成
   `Not_A Brand`、版本写死 `24`，品牌顺序写死
   `[Google Chrome, Chromium, Not_A Brand]`。Chromium 的 GREASE 值按主版本轮换：
   品牌名 = `Not + chars[major % 11] + A + chars[(major+1) % 11] + Brand`，
   版本 = `["8","99","24"][major % 3]`，顺序由 `major % 6` 决定。152 实际是
   `Not?A_Brand`、24，且 Chromium 排第一，所以三处全错。
2. **CDP 已注入时跳过 JS 补丁**：`applyUad()` 发现 `brands` 已含 `Google Chrome`
   就直接 `uadDone=true; return true`，不安装 getter。CDP 的
   `Emulation.setUserAgentOverride` 一旦因打开 DevTools 而 detach，原生
   Electron 品牌列表就重新露出来；JS 层没有兜底。
3. **高熵字段不完整**：`patchHighEntropy` 只补 `fullVersionList`，没有补
   `r.brands`；而且不管调用方有没有请求 `fullVersionList` 都强行加该字段，
   与真 Chrome 的返回形状不一致。

## 改动

| 文件 | 内容 |
|---|---|
| `src/infra/user-agent.ts` | 新增 `buildChromeBrands(major, full, fullVersion)`：按 Chromium GREASE 算法生成品牌名、假版本、顺序；`buildClientHintsHeaders`、`ensureClientHints` 的 full-version-list、`buildUserAgentMetadata`、`buildUserAgentDataFix` 全部改为共用该函数，删除 `Not_A Brand` 硬编码 |
| `src/infra/user-agent.ts` | `applyUad()` 不再因原生已含 `Google Chrome` 跳过；始终在原型上安装 `brands` getter 与 `getHighEntropyValues` 包装，CDP 断开后仍由 JS 兜住 |
| `src/infra/user-agent.ts` | 高熵包装同时改 `brands` 与 `fullVersionList`，但只在响应本来就有该字段时改；不再凭空增加未请求的 `fullVersionList` |
| `test/infra/user-agent.test.js` | 新增 Chrome 152/153/154 的品牌名、版本、顺序与 `Sec-CH-UA` 断言；新增「原生已含 Google Chrome 也必须归一化」「未请求 fullVersionList 不得凭空返回」用例 |

## 验证

- 单测：`test/infra/user-agent.test.js` 14 条全绿。
- 真实 Electron 探针（隐藏窗口 + preload 注入 + CDP attach/override/detach）：
  - 注入后：`low brands = [Chromium 152, Not?A_Brand 24, Google Chrome 152]`；
  - `getHighEntropyValues(['platformVersion'])` 返回 `brands` 同上，且
    `hasOwnProperty('fullVersionList') === false`；
  - CDP `Emulation.setUserAgentOverride` 生效时值不变；
  - **detach（模拟打开 DevTools 后释放 debugger）后值仍不变**，确认不再回退到原生。
- 待真机：用户按交付步骤在打包版 `chat.deepseek.com` 复验。

## 边界

- 品牌名/版本/顺序随 `process.versions.chrome` 自动计算；升级浏览器后如果
  Chromium 改算法，需要补充新主版本的实测断言。
- 打开 DevTools 本身仍可被页面通过 debugger 计时等方式探测；本需求只保证
  指纹字段不再因 CDP 断开而回退，不承诺「完全不可检测」。
- 控制台 `[Cuckoo Code]` 日志不是网页可直接读取的 DevTools 历史；页面可以
  hook `console.log`，但日志本身不是本次品牌缺失的原因，本轮未做生产静音；
  已由需求 130 / `v0.10.235` 补齐。
