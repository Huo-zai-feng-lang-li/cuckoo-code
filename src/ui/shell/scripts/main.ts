/**
 * 壳页面脚本入口。
 * 导入各模块（副作用：绑定事件），注册 tab 加载器，做预加载。
 */
import { api, ckPrompt, ckConfirm, ckAlert } from './shared.js';
import { registerTab } from './sidebar.js';
import './toolbar.js';
import './preview.js';
import './platform.js';

import { loadWorkspaces } from './pages/workspaces.js';
import { loadFiles } from './pages/files.js';
import { loadSnippets } from './pages/snippets.js';
import { loadSkills } from './pages/skills.js';
import { loadAgents } from './pages/agents.js';
import { loadMcpServers } from './pages/mcp.js';
import { loadAutoCompact } from './pages/token.js';
import { loadAbout } from './pages/about.js';
import { loadRemote } from './pages/remote.js';
import { renderWindowList } from './pages/windows.js';
import { loadSettings } from './pages/settings.js';
import { renderRecent } from './recent.js';
import { loadConversations } from './pages/conversations.js';
import { loadPlugins } from './pages/plugins.js';
import { loadRules } from './pages/rules.js';
import { loadMemories } from './pages/memories.js';
import { loadGit } from './pages/git.js';
import { loadTasks } from './pages/tasks.js';
import { initPluginShell } from './plugin-shell.js';
import { initModalGuard } from './modal-guard.js';
import { initThemePresenter } from './theme-presenter.js';
import { initGlobalTooltip } from './tooltip.js';
import { initActivitybarDrag, applyActivitybarOrder } from './activitybar-drag.js';
import { initActivitybarOverflow } from './activitybar-overflow.js';
import { initActivitybarVisibility } from './activitybar-visibility.js';
import { initUpdateProgress } from './update-progress.js';
import { initWindowSwitchToast } from './window-switch.js';
import { initNewConvLoading } from './newconv-loading.js';

// 全局统一自定义 Tooltip（接管所有 title，告别系统原生提示）
try { initGlobalTooltip(); } catch (_) { /* ignore */ }

// 窗口组切换提示 toast
try { initWindowSwitchToast(); } catch (_) { /* ignore */ }

// 新建对话 loading（点顶部 + 显示；主进程完成时隐藏）
try { initNewConvLoading(); } catch (_) { /* ignore */ }

// 活动栏图标拖拽排序（顺序持久化）
try { initActivitybarDrag(); applyActivitybarOrder(); } catch (_) { /* ignore */ }

// 活动栏用户显隐（设置页开关控制）
try { initActivitybarVisibility(); } catch (_) { /* ignore */ }

// 活动栏溢出（主区超 14 个 → 「⋯」hover 弹框）
try { initActivitybarOverflow(); } catch (_) { /* ignore */ }

// 自动更新进度（状态栏进度条）
try { initUpdateProgress(); } catch (_) { /* ignore */ }

// 把自定义弹框挂到 window，供插件脚本调用（Electron 禁用原生 prompt，插件需用这套）
(window as any).ckPrompt = ckPrompt;
(window as any).ckConfirm = ckConfirm;
(window as any).ckAlert = ckAlert;

// 注册 tab → 加载函数（sidebar 点击时调用）
registerTab('workspaces', loadWorkspaces);
registerTab('files', loadFiles);
registerTab('snippets', loadSnippets);
registerTab('skills', loadSkills);
registerTab('agents', loadAgents);
registerTab('mcp', loadMcpServers);
registerTab('token', loadAutoCompact);
registerTab('about', loadAbout);
registerTab('remote', loadRemote);
registerTab('windows', renderWindowList);
registerTab('settings', loadSettings);
registerTab('conversations', loadConversations);
registerTab('plugins', loadPlugins);
registerTab('rules', loadRules);
registerTab('memories', loadMemories);
registerTab('git', loadGit);
registerTab('tasks', loadTasks);

// 预加载：工作区（默认页）+ 提示词 + 自动压缩配置
try { loadWorkspaces(); } catch (_) { /* ignore */ }
try { loadSnippets(); } catch (_) { /* ignore */ }
try { loadAutoCompact(); } catch (_) { /* ignore */ }

// 渲染底部状态栏「最近使用」
try { renderRecent(); } catch (_) { /* ignore */ }

// 预加载 Git 改动数（活动栏 badge）
try { loadGit(); } catch (_) { /* ignore */ }

// 渲染底部状态栏「当前窗口名」
function renderWindowName(): void {
  const el = document.getElementById('sb-window-name-text');
  const fn = (api as any).getWindowName;
  if (!el || typeof fn !== 'function') return;
  fn().then((r: any) => { if (r && r.success) el.textContent = r.name || '--'; }).catch(() => {});
}
try { renderWindowName(); } catch (_) { /* ignore */ }
// 主进程推送窗口名变化（用户信息提取后）→ 实时更新
if ((api as any).onWindowNameUpdated) {
  (api as any).onWindowNameUpdated((name: string) => {
    const el = document.getElementById('sb-window-name-text');
    if (el && name) el.textContent = name;
  });
}

// 插件界面挂载（接收主进程 shell-plugin-mount）
try { initPluginShell(); } catch (_) { /* ignore */ }

// 模态守护：全屏覆盖层可见时隐藏 AI 视图（WebContentsView 挡不住 CSS）
try { initModalGuard(); } catch (_) { /* ignore */ }

// 主题呈现层（消费主进程快照，写 --ck-* 变量）
try { initThemePresenter(); } catch (_) { /* ignore */ }

// 上报壳页面真实可视尺寸（主进程据此精确布局，避免菜单栏高度误差盖住状态栏）
function reportShellSize(): void {
  if (api.reportShellSize) api.reportShellSize(window.innerWidth, window.innerHeight);
}
reportShellSize();
window.addEventListener('resize', reportShellSize);

// 其他窗口改了提示词 → 本窗口同步刷新
if ((api as any).onSnippetsChanged) {
  (api as any).onSnippetsChanged(() => { try { loadSnippets(); } catch (_) { /* ignore */ } });
}
