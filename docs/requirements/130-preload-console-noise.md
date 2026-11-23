---
id: 130
type: fix
title: preload 控制台日志降噪（生产静默，保留错误）
status: doing
branch: master
created: 2026-11-23
updated: 2026-11-23
---

# 130 preload 控制台日志降噪（生产静默，保留错误）

- 状态：代码、单测、Electron 探针完成；待用户真机验收
- 日期：2026-11-23
- 版本：`v0.10.235`
- 前置：需求 129（`v0.10.233` UA-CH 品牌修复）

## 用户现象

`v0.10.233` 的品牌值已经正确，但用户打开 DevTools 仍看到大量
`[Cuckoo Code]` 启动、指纹注入、拦截器、看门狗、插件日志，怀疑旧版没有退出，
或日志没有被关闭。

## 结论

- 已核实 `D:\cuckoo-code\resources\app.asar` 的 `package.json` 版本为
  `0.10.233`，进程启动时间晚于安装包写入时间，**不是旧版残留**。
- `v0.10.233` 只修了品牌，没有做日志静默。诊断日志不是品牌缺失的根因，
  但确实会把“Cuckoo 正在注入页面”直接展示给打开 DevTools 的人。

## 改动

| 文件 | 内容 |
|---|---|
| `src/bridge/console-filter.ts` | 新增 `installConsoleFilter` / `isDebugConsoleEnabled`：生产版静默 preload 的 `log` / `info` / `debug`，保留 `warn` / `error` |
| `src/bridge/console-filter-install.ts` | 副作用模块，在 preload 入口最早安装过滤器 |
| `src/bridge/entry.ts` | 第一行 import `console-filter-install.js`，保证启动日志也被覆盖 |
| `test/bridge/console-filter.test.js` | 3 条：生产静默、调试不静默、`CUCKOO_DEBUG` / `defaultApp` 判定 |

## 验证

- 单测：`test/bridge/console-filter.test.js` 3 条全绿；全量 `154` 文件 `1564` 用例通过。
- 真实 Electron 探针（preload 隔离世界）：
  - `PRELOAD_AFTER_FILTER_LOG` / `INFO` 不再出现；
  - `PRELOAD_AFTER_FILTER_WARN` / `ERROR` 仍出现；
  - 页面主世界的 `PAGE_LOG` / `PAGE_WARN` 仍正常出现，确认没有误伤页面 console。
- 开发模式：`electron .` 的 `process.defaultApp=true`，或设置 `CUCKOO_DEBUG=1`，日志保持。
- 待真机：用户安装 `v0.10.235` 后确认控制台不再出现 `[Cuckoo Code]` 普通日志。

## 边界

- 只静默 preload 隔离世界的 `log/info/debug`，不碰页面主世界；页面自身日志不会被吞。
- 保留 `warn/error`，避免真故障失去诊断。
- 不改变 DevTools 可被 debugger 计时探测的事实；本需求只做日志降噪，不承诺“完全不可检测”。
- 若开发者需要在生产版排障，启动时设置 `CUCKOO_DEBUG=1`。
