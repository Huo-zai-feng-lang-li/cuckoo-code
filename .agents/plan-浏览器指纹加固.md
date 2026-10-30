# 计划：浏览器指纹一致性加固（需求 100）

## 目标
消除三处「被识破」的指纹矛盾 + 抬高子代理启动间隔默认值。

## 执行流程
1. 建需求档案 + 分支 `fix/100-fingerprint-hardening`（已建）
2. 改 `src/infra/user-agent.ts`：删 loadTimes/csi；UA、Client Hints、userAgentData 按平台生成
3. 新增 `src/providers/hooks/shared/native-mask.ts`；三平台 hook 接入
4. `src/app/global-settings.ts` + `src/overlay/panels/settings.ts`：启动间隔默认 0→2/5；migrateLegacy 补迁移
5. 更新测试断言
6. compile / typecheck / test / lint
7. 真机 CDP 探针验证
8. CHANGELOG + 版本 0.10.199→0.10.200 + 提交 + tag

## 涉及文件
- src/infra/user-agent.ts
- src/providers/hooks/shared/native-mask.ts（新增）
- src/providers/hooks/{deepseek,claude,chatgpt}.ts
- src/app/global-settings.ts
- src/overlay/panels/settings.ts
- test/app/global-settings.test.js
- CHANGELOG.md / package.json / .agents/handoff.md

## 风险与对策
- userAgentData 从"整体伪造"改为"最小覆盖"：改动语义大，必须真机确认 Google OAuth / 站点不报不安全
- hook 在 AI 页面主世界执行，改动只能真机验证；maskAsNative 的 toString 必须不抛错（try/catch 包裹）
