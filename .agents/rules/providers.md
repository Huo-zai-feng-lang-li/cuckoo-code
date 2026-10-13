---
name: providers
paths:
  - "src/providers/**/*.ts"
---

# providers 层规则（平台适配）

providers 适配各 AI 平台（DeepSeek / Claude / ChatGPT / 自定义）。可依赖 `infra`，被 `tools` / `bridge` / `session` 依赖。

## 加新平台的标准流程

1. 新建 `src/providers/<id>.ts`，实现 `Provider` 接口（见 `types.ts`）
2. 若有网络拦截需求 → 新建 hook `src/providers/hooks/<id>.ts`（**见 hooks.md 规则**）
3. 注册：
   - `src/providers/registry.ts` 的 `loadBuiltinProviders()`
   - hook 另需注册到 `scripts/build-hooks.mjs` 的 HOOKS 数组
4. `npm run compile` 重建（hook 会内联进 `hook-sources.ts`）

## D14 运行时校验（铁律）

TS 类型**运行时被擦除**，provider 的正确性**靠校验函数**（`validate.ts`）保证，不靠类型。

- 内置 provider 加载时过 `validateProvider`，失败即跳过并告警
- 自定义 provider 同样校验
- **改 Provider 接口 → 必须同步改 `validate.ts`**

## 接口约定

- `id` / `name` / `homeUrl` / `sessionUrlBase`：基础标识
- `extractSessionId(url)` / `matchesUrl(url)`：URL 识别（**必须实现**）
- 各种选择器（`inputSelectors` 等）：按优先级排序的数组，用于查找输入框/发送按钮
