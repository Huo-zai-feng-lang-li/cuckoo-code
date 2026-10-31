# 计划：浏览器指纹一致性加固（需求 100）

> 状态：✅ 已完成（v0.10.200，tag `v0.10.200`，commit `f4bc9ad` + `0989327`）

## 目标

消除三处「被识破」的指纹矛盾 + 抬高子代理启动间隔默认值。

## 执行流程（全部完成）

1. ✅ 建需求档案 + 分支 `fix/100-fingerprint-hardening`
2. ✅ 改 `src/infra/user-agent.ts`：删 loadTimes/csi；UA、Client Hints、userAgentData 按平台生成
3. ✅ 新增 `src/providers/hooks/shared/native-mask.ts`；三平台 hook 接入
4. ✅ `src/app/global-settings.ts` + `src/overlay/panels/settings.ts`：启动间隔默认 0→2/5；migrateLegacy 补迁移
5. ✅ 更新测试断言
6. ✅ compile / typecheck / test（131 文件 1316 用例）/ lint 全绿
7. ✅ 真机 CDP 探针验证（见下）
8. ✅ CHANGELOG + 版本 0.10.199→0.10.200 + 提交 + tag

## 涉及文件

- `src/infra/user-agent.ts`
- `src/providers/hooks/shared/native-mask.ts`（新增）
- `src/providers/hooks/{deepseek,claude,chatgpt}.ts`
- `src/app/global-settings.ts`
- `src/overlay/panels/settings.ts`
- `test/app/global-settings.test.js`
- `CHANGELOG.md` / `package.json` / `.agents/handoff.md`

## 实际踩到的坑（计划外的额外修复）

1. **`userAgentData` 每次访问返回新对象** —— 打在实例上的补丁随对象丢弃。必须只打原型。
2. **原生 `getHighEntropyValues` 要求 this 是实例** —— 原型包装必须 `apply(this, arguments)`，否则抛 Illegal invocation。
3. **原生方法是原型上的只读方法** —— 非严格模式下普通赋值静默失败，必须 `defineProperty`。
4. **`__installed` 幂等标记写错作用域**（真 bug）—— 声明在 `install()` 内部，每次调用都重置。已提到模块作用域。
5. **只伪装 toString 不够** —— `window.fetch.length` 是一行检测，必须补齐 length（fetch=1、send=0、open=2、setRequestHeader=2）。

## 风险与对策（已验证）

- ✅ userAgentData 从「整体伪造」改为「最小覆盖」：真机确认 DeepSeek 页面正常，fetch/XHR 功能未受影响（请求 200）
- ✅ hook 在 AI 页面主世界执行：maskAsNative 的 toString 全部 try/catch 包裹，不抛错

## 真机验证结果（CDP 9444，DeepSeek 页面，Windows）

```
platform=Win32, ua 含 Chrome/152 且无 Electron 标识, uadPlatform=Windows   ← 三者一致
uadBrands 含 Google Chrome; 高熵 fullVersionList 含 Google Chrome
webdriver=false; chrome.loadTimes=undefined; chrome.csi=undefined
fetchLength=1(原生), xhrSendLength=0(原生), open=2, setRequestHeader=2
fetch/xhr 的 toString 均含 [native code]
brandsGetterStr="function get brands() { [native code] }"
windowCuckooKeys=[]   ← 修复前是 ["__cuckooDeepseekHookInstalled__"]
```

## 未覆盖

- **Claude / ChatGPT 平台未真机验证** —— 代码结构相同、编译通过，但只有 DeepSeek 用真实账号跑过
