# 登录与桌面体验修复

目标：修复网页登录兼容性、让 UI 管理文件级全局规则、提供明暗主题选择、优化已测量的性能热点、修复任务通知点击路由，并支持工作区从归档到删除。

约束：规则文件是唯一来源；不导入系统浏览器凭据；不关闭 TLS、上下文隔离等安全配置；不承诺绕过第三方嵌入式浏览器限制；所有外网操作使用本机 51081 代理；不提交或发布；清理本次启动的进程。

验收：规则读写与边界测试、主题持久化与跨窗口一致性、通知恢复正确来源窗口、登录窗口与 session/UA 一致性、工作区删除只移除会话元数据且不越界删除磁盘目录、性能前后操作计数或计时、全量测试/类型检查/编译，以及手动验证说明。

## 阶段

- [x] 启动 Goal，检查 handoff 与 rules（均不存在），工作区初始干净，初始化 CodeGraph。
- [x] 获取用户登录范围：Claude、Gemini、Arena 等外网站点。
- [x] 登录：profile session 与页面使用动态 Chrome UA；OAuth `window.open` 仅允许 http/https 或 OAuth SDK 所需的 `about:blank`，复用 profile partition，使用安全 WebPreferences 且不注入 bridge；工具栏提供系统浏览器兜底。已核查 WebRTC-Disabler，它解决隐私指纹而非 OAuth 嵌入限制，因此不作为登录修复依赖。
- [x] 全局规则：增加用户级规则文件列表、读取、保存、新建、删除、目录打开入口；使用 SHA-256 乐观并发校验，拒绝越界/软链接路径。
- [x] 工作区：在归档之外增加带确认的会话记录和项目记录删除；只修改 session 元数据，不删除磁盘项目文件。
- [x] 主题：增加系统/浅色/深色三态切换，持久化偏好，并同步壳页面、Harness、overlay、Monaco 与原生主题。
- [x] 通知：由通知发送者定位来源窗口，点击时恢复/显示/聚焦并清除闪烁；来源销毁时按 profile 恢复窗口。
- [x] 性能：规则扫描按目录/文件元数据缓存，提示词模板、项目介绍与工具契约按 mtime/size 缓存，减少重复磁盘读取。
- [x] ChatGPT/Google 页面：网页的 Trusted Types 策略会拦截覆盖层 HTML 注入，统一通过应用自有 TrustedHTML policy 写入静态面板、确认框和历史列表，确保项目目录与本地工具桥接继续初始化；规则操作按钮改为紧凑尺寸并保留图标入口。
- [x] ChatGPT 匿名对话：补充 `/unauth-mweb/conversation/updates` 端点和 NDJSON 解码，兼容旧 `/backend-api/conversation` SSE；真实 Electron CDP 验证输入框发送、回复捕获与 observer 日志闭环。
- [x] 支持边界核对：内置网页仅 DeepSeek、Claude、ChatGPT；未注册的 Gemini、Arena 等网址没有回复协议 hook，不能宣称支持自动工具回填，需导入自定义 Provider。
- [x] 集成：`npm run typecheck`、`npx tsc -p tsconfig.build.json`、`node scripts/build-shell.mjs` 通过；全量 Vitest 在临时 Electron 路径解析下 91 个测试文件/882 项通过。真实 Electron binary 下载因网络返回 `TypeError: fetch failed`，未能启动桌面端手测与完整 compile。

## 依赖与证据

- `src/app/entry.ts`：WebContentsView、partition、UA、popup 与生命周期。
- `src/infra/user-agent.ts`，`test/infra/user-agent.test.js`：UA 构建。
- `src/rules/*`，`src/session/prompt-builder.ts`，`docs/rules.md`：文件扫描与注入。
- `src/app/theme/theme-manager.ts`，`src/plugins/runtime/theme-runtime.ts`，`src/ui/shell/scripts/pages/settings.ts`：主题偏好与 UI。
- `src/app/ipc/renderer.ts`，`src/app/window.ts`：通知发送者与窗口映射。
- 官方 API：Electron window-open / notification / BrowserWindow 文档；Google OAuth 对 embedded user-agent 的限制需核验。

登录实现依据：Electron 官方文档确认 `session.setUserAgent` 不影响已有 WebContents，因此创建 profile 时与页面创建前同时设置；`setWindowOpenHandler` 用于控制并配置 `window.open` 子窗口。Electron 扩展支持为按 session 加载未打包扩展，且 API/Manifest 支持范围有限；WebRTC-Disabler 的清单和说明显示其主要修改 WebRTC、时区、语言和定位，不等价于 OAuth 登录兼容层。

记录：初次 create_goal 被拒绝，因为 `/goal` 已自动创建活动目标；使用现有目标继续。依赖尚未安装，已通过代理启动 npm ci。
