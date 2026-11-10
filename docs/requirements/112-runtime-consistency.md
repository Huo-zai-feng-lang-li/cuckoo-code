# 112：编辑恢复、显示几何与代理切换一致性

## 用户目标与约束

减少无效工具往返，保留模型有效上下文；4K 与多屏页面保持真实尺寸和缩放；保存代理后可靠生效。用户授权直接完成修复、验证并推送 tag。

账号封禁截图显示截止 November 12, 2026 18:51，但没有时区、平台判定细节或此次请求统计。不得把客户端缺陷或历史检测结果当作封禁的已证实原因，不承诺客户端修改可以解除账号限制。

## 实现范围

1. 四份模型提示词要求 edit 文本匹配失败后重新 read 相关片段，禁止凭记忆修改 oldString 重试；不改变模型选择、推理设置或内容截断策略。
2. 指纹脚本保留浏览器真实 Screen 与 devicePixelRatio；不通过缩小窗口、CSS 缩放、修改 viewport 来迎合固定屏幕预设，旧 profile 数据继续兼容。
3. 代理变更等待 setProxy 成功后关闭旧连接池；相同配置不重复关闭连接；失败向上传递，不报告成功、不直连加载目标站点。核查启动、保存、刷新和自动出口探测调用方。
4. 核查主世界 electronAPI 的真实调用方。若只供隔离 preload 使用，则移除不必要的主世界暴露，保留隔离世界接口及功能；不通过隐藏检测痕迹代替真实权限边界。
5. 记录审计证据，纠正历史 handoff 对封禁原因的过度归因。

## 验收

- 针对代理切换、失败传播及幂等性有回归证据。
- 在真实 Electron 中验证页面原生几何不被指纹脚本修改、隔离 API 可用且页面没有多余的 API 权限。
- typecheck、全量测试、lint、compile 通过；隔离 CUCKOO_HOME 启动验证并清理本任务进程。
- 更新 CHANGELOG、版本和 tag（下一版跳过含 4 的 0.10.214，使用 0.10.215）；推送后核验远程引用。

## 证据

- src/app/entry.ts:112 的 clampBounds 使用 Electron screen.getDisplayMatching(...).workArea。
- src/app/fingerprint.ts:289 起覆盖 Screen 和 devicePixelRatio，未改变真实窗口大小。
- src/bridge/api.ts:252 通过 exposeInMainWorld 暴露接口；contextIsolation 不阻止显式桥接。
- src/app/entry.ts:1715 保存代理后调用 applyNetIdentity 并 reload。
- src/app/net-identity.ts:201 捕获 setProxy 异常而不抛出，且未关闭旧连接。
- Electron 官方文档：https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig 、https://www.electronjs.org/docs/latest/api/context-bridge 。
